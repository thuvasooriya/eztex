// BundleStore.zig -- unified file resolution: cache + bundle index + fetch.
//
// Platform-agnostic: all platform divergences are behind Host.zig.
// Flow: open_file(name) -> cache hit -> ensure index -> fetch -> cache -> return

const std = @import("std");
const fs = std.fs;
const Host = @import("Host.zig");

const Log = @import("Log.zig");

const BundleStore = @This();

const is_wasm = Host.is_wasm;
const dbg = Log.dbg;

pub const IndexEntry = Host.IndexEntry;

allocator: std.mem.Allocator,
bundle_index: std.StringHashMap(IndexEntry),
bundle_index_loaded: bool,
url: []const u8,
digest: []const u8,

pub fn init(allocator: std.mem.Allocator, url: []const u8, digest: []const u8) BundleStore {
    return .{
        .allocator = allocator,
        .bundle_index = std.StringHashMap(IndexEntry).init(allocator),
        .bundle_index_loaded = false,
        .url = url,
        .digest = digest,
    };
}

pub fn deinit(self: *BundleStore) void {
    Host.cache_save();

    var it = self.bundle_index.iterator();
    while (it.next()) |entry| {
        self.allocator.free(entry.key_ptr.*);
    }
    self.bundle_index.deinit();
}

// resolve a file: cache -> index lookup -> fetch -> write -> return
pub fn open_file(self: *BundleStore, name: []const u8) !fs.File {
    dbg("bs", "open_file: \"{s}\"", .{name});
    // 1. check persistent cache (Host abstracts disk vs OPFS)
    if (Host.cache_open(name)) |file| {
        dbg("bs", "open_file: cache hit for \"{s}\"", .{name});
        return file;
    }

    // 2. bundle_index lookup
    try self.ensure_index();
    const entry = self.resolve_index_entry(name) orelse {
        dbg("bs", "open_file: not in index \"{s}\"", .{name});
        return error.FileNotFound;
    };
    dbg("bs", "open_file: index entry \"{s}\" offset={d} len={d}", .{ name, entry.offset, entry.length });

    // 3. fetch via Host (abstracts HTTP Range vs sync XHR)
    Log.dbg("bundle", "fetching: {s}", .{name});
    const content = try Host.fetch_range(name, entry, self.allocator);
    defer self.allocator.free(content);

    // 4. persist to cache (Host abstracts disk vs OPFS, no-op on WASM)
    Host.cache_write(name, content);

    // 5. write to temp file and return handle
    const file = fs.cwd().createFile(name, .{ .read = true }) catch return error.CacheWriteFailed;
    file.writeAll(content) catch {
        file.close();
        return error.CacheWriteFailed;
    };
    file.seekTo(0) catch {
        file.close();
        return error.CacheWriteFailed;
    };

    // on native, re-open from cache for content-addressed dedup benefit
    if (!is_wasm) {
        file.close();
        return Host.cache_open(name) orelse error.CacheWriteFailed;
    }

    return file;
}

// check if a file exists in cache or index
pub fn has(self: *BundleStore, name: []const u8) !bool {
    if (Host.cache_check(name) == .hit) return true;
    try self.ensure_index();
    return self.bundle_index.contains(name);
}

pub fn count(self: *BundleStore) !usize {
    try self.ensure_index();
    return self.bundle_index.count();
}

// resolve name to index entry, handling fonts/ prefix stripping
pub fn resolve_index_entry(self: *BundleStore, name: []const u8) ?IndexEntry {
    if (self.bundle_index.get(name)) |entry| return entry;
    // try stripping fonts/ prefix (WASM fetches use bare names in index)
    const fonts_prefix = "fonts/";
    if (name.len > fonts_prefix.len and std.mem.eql(u8, name[0..fonts_prefix.len], fonts_prefix)) {
        return self.bundle_index.get(name[fonts_prefix.len..]);
    }
    return null;
}

// -- index management --

pub fn ensure_index(self: *BundleStore) !void {
    if (self.bundle_index_loaded) return;
    dbg("bs", "ensure_index: loading...", .{});

    // try loading cached index first (native: disk cache, wasm: always null)
    if (Host.load_cached_index(self.digest, self.allocator)) |content| {
        defer self.allocator.free(content);
        self.parse_index(content) catch {
            // cache corrupted, fall through to network fetch
        };
        if (self.bundle_index.count() > 0) {
            self.bundle_index_loaded = true;
            Log.dbg("bundle", "bundle_index loaded from cache ({d} entries)", .{self.bundle_index.count()});
            return;
        }
    }

    // fetch from network (native: HTTP + decompress, wasm: error.IndexNotLoaded)
    const content = try Host.fetch_index(self.allocator);
    defer self.allocator.free(content);

    Log.dbg("bundle", "bundle index downloaded ({d} bytes decompressed)", .{content.len});

    try self.parse_index(content);
    self.bundle_index_loaded = true;
    Log.dbg("bundle", "bundle_index fetched from network ({d} entries)", .{self.bundle_index.count()});

    // cache for future runs
    Host.cache_index(self.digest, content);
}

// load index from raw ITAR text content. clears any previously loaded index.
// used by both native (from disk/HTTP) and WASM (from JS-provided bytes via eztex_push_index).
pub fn load_index(self: *BundleStore, content: []const u8) !void {
    var it = self.bundle_index.iterator();
    while (it.next()) |entry| {
        self.allocator.free(entry.key_ptr.*);
    }
    self.bundle_index.clearRetainingCapacity();
    try parse_index_into(self.allocator, &self.bundle_index, content);
    self.bundle_index_loaded = true;
}

fn parse_index(self: *BundleStore, content: []const u8) !void {
    self.bundle_index.clearRetainingCapacity();
    try parse_index_into(self.allocator, &self.bundle_index, content);
}

// standalone index parser: populate any StringHashMap(IndexEntry) from ITAR index text.
pub fn parse_index_into(
    allocator: std.mem.Allocator,
    index: *std.StringHashMap(IndexEntry),
    content: []const u8,
) !void {
    var line_iter = std.mem.splitScalar(u8, content, '\n');
    while (line_iter.next()) |line| {
        const trimmed = std.mem.trimRight(u8, line, " \t\r");
        if (trimmed.len == 0) continue;

        var parts = std.mem.splitScalar(u8, trimmed, ' ');
        const name = parts.next() orelse continue;
        const offset_str = parts.next() orelse continue;
        const length_str = parts.next() orelse continue;
        if (name.len == 0) continue;
        if (std.mem.eql(u8, name, "SVNREV") or std.mem.eql(u8, name, "GITHASH")) continue;

        const offset = std.fmt.parseInt(u64, offset_str, 10) catch continue;
        const length = std.fmt.parseInt(u32, length_str, 10) catch continue;

        const owned_name = try allocator.dupe(u8, name);
        index.put(owned_name, .{ .offset = offset, .length = length }) catch {
            allocator.free(owned_name);
            continue;
        };
    }
}

// -- batch seed cache --
// fetches a list of files in parallel, skipping cached and unknown entries.
// delegates concurrency strategy to Host (OS threads on native, sequential on WASM).

pub const SeedResult = struct {
    fetched: usize,
    skipped_cached: usize,
    skipped_unknown: usize,
    failed: usize,
};

pub fn seed_cache(self: *BundleStore, names: []const []const u8, concurrency: usize) SeedResult {
    if (names.len == 0) return .{ .fetched = 0, .skipped_cached = 0, .skipped_unknown = 0, .failed = 0 };

    self.ensure_index() catch |err| {
        Log.dbg("bundle", "seed: failed to load bundle index: {}", .{err});
        return .{ .fetched = 0, .skipped_cached = 0, .skipped_unknown = names.len, .failed = 0 };
    };

    // build work list: resolve index entries, skip cached and unknown
    var work_items: std.ArrayList(Host.SeedItem) = .empty;
    defer work_items.deinit(self.allocator);

    var skipped_cached: usize = 0;
    var skipped_unknown: usize = 0;

    for (names) |name| {
        if (Host.cache_check(name) == .hit) {
            skipped_cached += 1;
            continue;
        }
        const entry = self.bundle_index.get(name) orelse {
            skipped_unknown += 1;
            continue;
        };
        work_items.append(self.allocator, .{ .name = name, .entry = entry }) catch continue;
    }

    if (work_items.items.len == 0) {
        return .{
            .fetched = 0,
            .skipped_cached = skipped_cached,
            .skipped_unknown = skipped_unknown,
            .failed = 0,
        };
    }

    Log.dbg("bundle", "seed: {d} files to fetch ({d} cached, {d} unknown)", .{
        work_items.items.len, skipped_cached, skipped_unknown,
    });

    // delegate to Host (threads on native, sequential on WASM)
    const result = Host.batch_seed(work_items.items, concurrency);

    return .{
        .fetched = result.fetched,
        .skipped_cached = skipped_cached,
        .skipped_unknown = skipped_unknown,
        .failed = result.failed,
    };
}
