// hosts/native.zig -- native host implementation (macOS/Linux/Windows).
//
// Wraps std.http.Client for range fetches, Cache.zig for persistent storage,
// and OS threads for batch prefetch. All state is module-level to avoid
// threading through BundleStore fields.

const std = @import("std");
const builtin = @import("builtin");
const fs = std.fs;
const posix = std.posix;
const http = std.http;
const Io = std.Io;
const Cache = @import("../Cache.zig");
const Host = @import("../Host.zig");
const Engine = @import("../Engine.zig");
const Log = @import("../Log.zig");
const BundleStore = @import("../BundleStore.zig");

const retry_attempts: usize = 3;
const retry_sleep_ns: u64 = 500 * std.time.ns_per_ms;

fn sleepMs(ms: u64) void {
    if (builtin.os.tag == .windows) {
        // Windows: use kernel32.Sleep (takes DWORD milliseconds)
        const windows = std.os.windows;
        const pSleep = @extern(*const fn (windows.DWORD) callconv(std.builtin.CallingConvention.winapi) void, .{ .name = "Sleep", .library_name = "kernel32" });
        pSleep(@intCast(ms));
    } else {
        const ts = std.c.timespec{
            .sec = @intCast(ms / 1000),
            .nsec = @intCast((ms % 1000) * 1_000_000),
        };
        _ = std.c.nanosleep(&ts, null);
    }
}

// -- module state --
// all mutable state grouped into a single struct for clarity.
// initialized by init()/setup(), used by all public functions.

const State = struct {
    cache: Cache,
    data_url_buf: [2048]u8,
    data_url_len: usize,
    index_url_buf: [2048]u8,
    index_url_len: usize,
    resolved_url: ?[]u8,
    client: ?http.Client,
    digest_buf: [128]u8,
    digest_len: usize,
};

var state: State = .{
    .cache = Cache.init(std.heap.c_allocator),
    .data_url_buf = undefined,
    .data_url_len = 0,
    .index_url_buf = undefined,
    .index_url_len = 0,
    .resolved_url = null,
    .client = null,
    .digest_buf = undefined,
    .digest_len = 0,
};

// File-local io instance for single-threaded operations (matching C bridge pattern)
var threaded: Io.Threaded = .init_single_threaded;
const io = threaded.io();

pub fn init(cache_dir: ?[]const u8, url: []const u8, idx_url: []const u8, digest: []const u8) void {
    if (url.len <= state.data_url_buf.len) {
        @memcpy(state.data_url_buf[0..url.len], url);
        state.data_url_len = url.len;
    }

    if (idx_url.len <= state.index_url_buf.len) {
        @memcpy(state.index_url_buf[0..idx_url.len], idx_url);
        state.index_url_len = idx_url.len;
    }

    // clear cached redirect when URL changes (e.g. bundle URL override)
    if (state.resolved_url) |u| {
        std.heap.c_allocator.free(u);
        state.resolved_url = null;
    }

    set_digest(digest);

    if (cache_dir) |dir| {
        state.cache.set_cache_dir(dir);
        state.cache.set_manifest_path(digest);
    }
}

// -- fetch --

pub fn fetch_range(
    name: []const u8,
    entry: Host.IndexEntry,
    alloc: std.mem.Allocator,
) ![]u8 {
    const url = get_data_url();
    const c = get_client();
    return fetch_range_with_client(c, url, name, entry, alloc);
}

fn fetch_range_with_client(
    c: *http.Client,
    url: []const u8,
    name: []const u8,
    entry: Host.IndexEntry,
    alloc: std.mem.Allocator,
) ![]u8 {
    var range_buf: [64]u8 = undefined;
    const range_end = entry.offset + entry.length - 1;
    const range_header = std.fmt.bufPrint(&range_buf, "bytes={d}-{d}", .{
        entry.offset, range_end,
    }) catch return error.FormatError;

    Log.dbg(io, "bundle", "downloading '{s}' (offset={d}, len={d})", .{ name, entry.offset, entry.length });

    for (0..retry_attempts) |attempt| {
        var body_out: Io.Writer.Allocating = .init(alloc);
        errdefer body_out.deinit();

        const result = c.fetch(.{
            .location = .{ .url = url },
            .response_writer = &body_out.writer,
            .extra_headers = &.{
                .{ .name = "Range", .value = range_header },
            },
        }) catch |err| {
            Log.dbg(io, "bundle", "  fetch failed (attempt {d}/{d}): {}", .{ attempt + 1, retry_attempts, err });
            body_out.deinit();
            sleepMs(500);
            continue;
        };

        if (result.status != .partial_content and result.status != .ok) {
            Log.dbg(io, "bundle", "  unexpected HTTP status: {d} (attempt {d}/{d})", .{
                @intFromEnum(result.status), attempt + 1, retry_attempts,
            });
            body_out.deinit();
            sleepMs(500);
            continue;
        }

        const data = body_out.toOwnedSlice() catch |err| {
            Log.dbg(io, "bundle", "  alloc failed: {}", .{err});
            body_out.deinit();
            continue;
        };
        Log.dbg(io, "bundle", "  downloaded {d} bytes", .{data.len});
        return data;
    }

    Log.dbg(io, "bundle", "failed to download '{s}' after {d} attempts", .{ name, retry_attempts });
    return error.NetworkError;
}

// standalone range fetch for worker threads (uses provided client)
fn fetch_range_standalone(
    c: *http.Client,
    url: []const u8,
    name: []const u8,
    entry: Host.IndexEntry,
) ![]u8 {
    var range_buf: [64]u8 = undefined;
    const range_end = entry.offset + entry.length - 1;
    const range_header = std.fmt.bufPrint(&range_buf, "bytes={d}-{d}", .{
        entry.offset, range_end,
    }) catch return error.FormatError;

    for (0..retry_attempts) |attempt| {
        var body_out: Io.Writer.Allocating = .init(std.heap.c_allocator);
        errdefer body_out.deinit();

        const result = c.fetch(.{
            .location = .{ .url = url },
            .response_writer = &body_out.writer,
            .extra_headers = &.{
                .{ .name = "Range", .value = range_header },
            },
        }) catch |err| {
            if (attempt == retry_attempts - 1)
                Log.dbg(io, "bundle", "prefetch: failed '{s}': {}", .{ name, err });
            body_out.deinit();
            sleepMs(500);
            continue;
        };

        if (result.status != .partial_content and result.status != .ok) {
            if (attempt == retry_attempts - 1)
                Log.dbg(io, "bundle", "prefetch: HTTP {d} for '{s}'", .{ @intFromEnum(result.status), name });
            body_out.deinit();
            sleepMs(500);
            continue;
        }

        return body_out.toOwnedSlice() catch |err| {
            Log.dbg(io, "bundle", "prefetch: alloc failed for '{s}': {}", .{ name, err });
            body_out.deinit();
            continue;
        };
    }

    return error.NetworkError;
}

// -- cache --

pub fn cache_check(name: []const u8) Host.CacheStatus {
    if (state.cache.get_cache_dir().len == 0) return .unsupported;
    return if (state.cache.has(name)) .hit else .miss;
}

pub fn cache_open(name: []const u8) ?std.Io.File {
    return state.cache.open_cached(io, name);
}

pub fn cache_write(name: []const u8, content: []const u8) void {
    const hex_hash = Cache.hash_content(content);
    state.cache.write(io, name, &hex_hash, content) catch |err| {
        Log.dbg(io, "bundle", "cache write failed: {s} err={}", .{ name, err });
    };
}

pub fn cache_save() void {
    state.cache.save_manifest(io) catch {};
}

pub fn cache_count() usize {
    return state.cache.count();
}

// expose the underlying Cache for setup operations (manifest loading, dir setup)
pub fn get_cache() *Cache {
    return &state.cache;
}

// -- batch seed --

pub fn batch_seed(items: []const Host.SeedItem, concurrency: usize) Host.SeedResult {
    if (items.len == 0) return .{ .fetched = 0, .failed = 0 };

    const url = get_data_url();

    var work_index = std.atomic.Value(usize).init(0);
    var fetched_count = std.atomic.Value(usize).init(0);
    var failed_count = std.atomic.Value(usize).init(0);
    var cache_mutex = std.atomic.Mutex.unlocked;

    const actual_concurrency = @min(concurrency, items.len);

    const WorkerCtx = struct {
        items: []const Host.SeedItem,
        work_idx: *std.atomic.Value(usize),
        fetched: *std.atomic.Value(usize),
        failed: *std.atomic.Value(usize),
        cache_mtx: *std.atomic.Mutex,
        url: []const u8,
    };

    const ctx = WorkerCtx{
        .items = items,
        .work_idx = &work_index,
        .fetched = &fetched_count,
        .failed = &failed_count,
        .cache_mtx = &cache_mutex,
        .url = url,
    };

    const worker_fn = struct {
        fn run(wctx: WorkerCtx) void {
            var thread_client: http.Client = .{ .allocator = std.heap.c_allocator, .io = io };

            while (true) {
                const idx = wctx.work_idx.fetchAdd(1, .monotonic);
                if (idx >= wctx.items.len) break;

                const item = wctx.items[idx];
                const content = fetch_range_standalone(&thread_client, wctx.url, item.name, item.entry) catch {
                    _ = wctx.failed.fetchAdd(1, .monotonic);
                    continue;
                };
                defer std.heap.c_allocator.free(content);

                const hex_hash = Cache.hash_content(content);

                while (!wctx.cache_mtx.tryLock()) std.atomic.spinLoopHint();
                defer wctx.cache_mtx.unlock();

                state.cache.write(io, item.name, &hex_hash, content) catch |err| {
                    Log.dbg(io, "bundle", "seed: cache write failed for '{s}': {}", .{ item.name, err });
                    _ = wctx.failed.fetchAdd(1, .monotonic);
                    continue;
                };

                _ = wctx.fetched.fetchAdd(1, .monotonic);
            }
        }
    }.run;

    var threads: [64]?std.Thread = @splat(null);
    const thread_count = @min(actual_concurrency, 64);
    for (0..thread_count) |i| {
        threads[i] = std.Thread.spawn(.{}, worker_fn, .{ctx}) catch null;
    }
    for (0..thread_count) |i| {
        if (threads[i]) |t| t.join();
    }

    const fetched = fetched_count.load(.monotonic);
    const failed = failed_count.load(.monotonic);

    state.cache.save_manifest(io) catch {};
    Log.dbg(io, "bundle", "seed: done ({d} fetched, {d} failed)", .{ fetched, failed });

    return .{ .fetched = fetched, .failed = failed };
}

// -- bundle index --

pub fn load_cached_index(digest: []const u8, alloc: std.mem.Allocator) ?[]u8 {
    const cache_dir = state.cache.get_cache_dir();
    if (cache_dir.len == 0) return null;

    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/indexes/{s}.txt", .{
        cache_dir, digest,
    }) catch return null;

    const file = Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);

    const stat = file.stat(io) catch return null;
    const size: usize = @intCast(@min(stat.size, 64 * 1024 * 1024));
    const content = alloc.alloc(u8, size) catch return null;
    var read_buf: [4096]u8 = undefined;
    var file_reader = file.readerStreaming(io, &read_buf);
    const reader = &file_reader.interface;
    reader.readSliceAll(content) catch {
        alloc.free(content);
        return null;
    };
    return content;
}

pub fn fetch_index(alloc: std.mem.Allocator) ![]u8 {
    const idx_url = get_index_url();

    Log.dbg(io, "bundle", "fetching bundle index from {s}", .{idx_url});

    const c = get_client();
    var body_out: Io.Writer.Allocating = .init(alloc);
    defer body_out.deinit();

    const result = c.fetch(.{
        .location = .{ .url = idx_url },
        .response_writer = &body_out.writer,
    }) catch |err| {
        Log.dbg(io, "bundle", "failed to fetch bundle index: {}", .{err});
        return error.NetworkError;
    };

    if (result.status != .ok) {
        Log.dbg(io, "bundle", "bundle index fetch returned HTTP {d}", .{@intFromEnum(result.status)});
        return error.HttpError;
    }

    const compressed = body_out.written();
    Log.dbg(io, "bundle", "bundle index downloaded ({d} bytes compressed)", .{compressed.len});

    // gzip decompress
    var input_reader: Io.Reader = .fixed(compressed);
    var window_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress = std.compress.flate.Decompress.init(&input_reader, .gzip, &window_buf);

    var output: Io.Writer.Allocating = .init(alloc);
    errdefer output.deinit();

    _ = decompress.reader.streamRemaining(&output.writer) catch |err| {
        Log.dbg(io, "bundle", "gzip decompression error: {}", .{err});
        return error.DecompressError;
    };

    return try output.toOwnedSlice();
}

pub fn cache_index(digest: []const u8, content: []const u8) void {
    const cache_dir = state.cache.get_cache_dir();
    if (cache_dir.len == 0) return;

    // Create indexes subdirectory using Io.Dir API
    var dir_buf: [1024]u8 = undefined;
    const dir_path = std.fmt.bufPrint(&dir_buf, "{s}/indexes", .{cache_dir}) catch return;
    Io.Dir.cwd().createDirPath(io, dir_path) catch {};

    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/indexes/{s}.txt", .{
        cache_dir, digest,
    }) catch return;

    const file = Io.Dir.cwd().createFile(io, path, .{}) catch return;
    defer file.close(io);
    var write_buf: [4096]u8 = undefined;
    var writer = file.writerStreaming(io, &write_buf);
    writer.interface.writeAll(content) catch {};
    _ = writer.interface.flush() catch {};
}

// -- time --

pub fn timestamp_ns() i128 {
    return std.time.nanoTimestamp();
}

// -- internal helpers --

fn get_client() *http.Client {
    if (state.client == null) {
        state.client = .{ .allocator = std.heap.c_allocator, .io = io };
    }
    return &state.client.?;
}

fn get_data_url() []const u8 {
    if (state.resolved_url) |u| return u;

    const cache_dir = state.cache.get_cache_dir();
    if (cache_dir.len == 0) return state.data_url_buf[0..state.data_url_len];

    // check for cached redirect
    var path_buf: [1024]u8 = undefined;
    // we need the digest for the redirect path -- extract from manifest path
    const digest = get_digest_from_state();
    const redirect_path = std.fmt.bufPrint(&path_buf, "{s}/redirects/{s}.txt", .{
        cache_dir, digest,
    }) catch return state.data_url_buf[0..state.data_url_len];

    // TODO: Re-enable redirect file reading when Io.File.Reader API stabilizes
    _ = redirect_path;
    return state.data_url_buf[0..state.data_url_len];
}

fn get_index_url() []const u8 {
    if (state.index_url_len > 0) return state.index_url_buf[0..state.index_url_len];
    // fallback: derive from bundle URL (legacy convention)
    return state.data_url_buf[0..state.data_url_len];
}

// the digest is stored in the manifest path -- extract it
fn get_digest_from_state() []const u8 {
    if (state.digest_len > 0) return state.digest_buf[0..state.digest_len];
    return "";
}

pub fn set_digest(digest: []const u8) void {
    if (digest.len <= state.digest_buf.len) {
        @memcpy(state.digest_buf[0..digest.len], digest);
        state.digest_len = digest.len;
    }
}

// -- setup --
// native platform setup: cache directory discovery, manifest loading, PM creation.
// returns cache directory path, or null if unavailable.

var g_cache_dir_buf: [512]u8 = undefined;
var g_manifest_buf: [1024]u8 = undefined;
var g_setup_digest_buf: [128]u8 = undefined;

pub fn setup(world: *Engine.World, _: bool, cache_dir_override: ?[]const u8, data_url: []const u8, index_url: []const u8, digest: *const [64]u8) ?[]const u8 {
    const cache_dir = if (cache_dir_override) |override| blk: {
        if (fs.path.isAbsolute(override)) {
            if (override.len > g_cache_dir_buf.len) {
                Log.log(io, "eztex", .err, "cache-dir path too long ({d} bytes)", .{override.len});
                return null;
            }
            @memcpy(g_cache_dir_buf[0..override.len], override);
            break :blk g_cache_dir_buf[0..override.len];
        }
        // Try to resolve relative path to absolute using allocator
        // TODO: Use proper Io.Dir API when available
        const resolved = fs.path.resolve(std.heap.c_allocator, &.{ ".", override }) catch {
            break :blk std.fmt.bufPrint(&g_cache_dir_buf, "./{s}", .{override}) catch {
                Log.log(io, "eztex", .err, "cache-dir path too long", .{});
                return null;
            };
        };
        defer std.heap.c_allocator.free(resolved);
        if (resolved.len > g_cache_dir_buf.len) {
            Log.log(io, "eztex", .err, "cache-dir path too long ({d} bytes)", .{resolved.len});
            return null;
        }
        @memcpy(g_cache_dir_buf[0..resolved.len], resolved);
        break :blk g_cache_dir_buf[0..resolved.len];
    } else find_cache_dir(&g_cache_dir_buf) orelse {
        Log.log(io, "eztex", .warn, "no cache directory found, bundle files unavailable", .{});
        return null;
    };

    if (cache_dir_override != null) {
        // TODO: Use proper Io.Dir API for makeDirAbsolute when available
        // For now, assume directory exists to allow compilation
        Log.dbg(io, "eztex", "using cache override: {s}", .{cache_dir});
    }
    Log.dbg(io, "eztex", "found cache: {s}", .{cache_dir});

    // initialize the Host layer (sets cache dir, data URL, index URL, digest on module state)
    init(cache_dir, data_url, index_url, digest);

    // load the cache manifest from disk if it exists
    if (find_manifest_info(cache_dir, &g_manifest_buf, &g_setup_digest_buf, digest)) |info| {
        Log.dbg(io, "eztex", "loading manifest: {s}", .{info.path});
        Log.dbg(io, "eztex", "bundle digest: {s}", .{info.digest});
        state.cache.load_manifest(info.path) catch |err| {
            Log.log(io, "eztex", .warn, "failed to load manifest: {}", .{err});
        };
    } else {
        Log.log(io, "eztex", .info, "no cached manifest found, will bootstrap from network on demand", .{});
    }

    // create BundleStore with active bundle settings
    const bs = BundleStore.init(std.heap.c_allocator, data_url, digest);

    Engine.set_bundle_store(bs);
    world.bundle_store = Engine.get_bundle_store();
    Log.dbg(io, "eztex", "bundle store initialized", .{});

    return cache_dir;
}

fn find_cache_dir(buf: []u8) ?[]const u8 {
    var probe: Cache = Cache.init(std.heap.c_allocator);
    if (probe.detect_cache_dir()) {
        const dir = probe.get_cache_dir();
        if (dir.len <= buf.len) {
            @memcpy(buf[0..dir.len], dir[0..dir.len]);
            probe.set_cache_dir(buf[0..dir.len]);
            remove_cache_symlinks(buf[0..dir.len]);
            probe.ensure_dirs() catch {};
            return buf[0..dir.len];
        }
    }
    return null;
}

// TODO: Re-enable when Io.Dir.openAbsolute API stabilizes
fn remove_cache_symlinks(_: []const u8) void {
    // var dir = Io.Dir.openAbsolute(io, cdir, .{}) catch return;
    // defer dir.close(io);
    //
    // const subdirs = [_][]const u8{ "files", "manifests", "indexes", "formats", "redirects" };
    // var path_buf: [1024]u8 = undefined;
    // for (subdirs) |sub| {
    //     const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ cdir, sub }) catch continue;
    //     var link_buf: [512]u8 = undefined;
    //     _ = posix.readlink(full_path, &link_buf) catch continue;
    //     dir.deleteFile(io, sub) catch {};
    // }
}

fn find_manifest_info(cdir: []const u8, path_buf: []u8, dbuf: []u8, digest: *const [64]u8) ?struct { path: []const u8, digest: []const u8 } {
    if (digest.len > dbuf.len) return null;
    @memcpy(dbuf[0..digest.len], digest);

    var dir_buf: [1024]u8 = undefined;
    const manifest_path = std.fmt.bufPrint(&dir_buf, "{s}/manifests/{s}.txt", .{ cdir, digest }) catch return null;

    const file = Io.Dir.cwd().openFile(io, manifest_path, .{}) catch return null;
    defer file.close(io);
    const stat = file.stat(io) catch return null;
    if (stat.size == 0) return null;

    const path = std.fmt.bufPrint(path_buf, "{s}", .{manifest_path}) catch return null;
    return .{ .path = path, .digest = dbuf[0..digest.len] };
}
