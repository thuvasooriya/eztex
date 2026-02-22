// hosts/native.zig -- native host implementation (macOS/Linux).
//
// Wraps std.http.Client for range fetches, Cache.zig for persistent storage,
// and OS threads for batch prefetch. All state is module-level to avoid
// threading through BundleStore fields.

const std = @import("std");
const fs = std.fs;
const posix = std.posix;
const http = std.http;
const Io = std.Io;
const Cache = @import("../Cache.zig");
const Host = @import("../Host.zig");
const Engine = @import("../Engine.zig");
const Log = @import("../Log.zig");
const Config = @import("../Config.zig");
const BundleStore = @import("../BundleStore.zig");

const retry_attempts: usize = 3;
const retry_sleep_ns: u64 = 500 * std.time.ns_per_ms;

// -- module state --

var cache: Cache = Cache.init(std.heap.c_allocator);
var data_url_buf: [2048]u8 = undefined;
var data_url_len: usize = 0;
var index_url_buf: [2048]u8 = undefined;
var index_url_len: usize = 0;
var resolved_url: ?[]u8 = null;
var client: ?http.Client = null;

pub fn init(cache_dir: ?[]const u8, url: []const u8, idx_url: []const u8, digest: []const u8) void {
    if (url.len <= data_url_buf.len) {
        @memcpy(data_url_buf[0..url.len], url);
        data_url_len = url.len;
    }

    if (idx_url.len <= index_url_buf.len) {
        @memcpy(index_url_buf[0..idx_url.len], idx_url);
        index_url_len = idx_url.len;
    }

    // clear cached redirect when URL changes (e.g. bundle URL override)
    if (resolved_url) |u| {
        std.heap.c_allocator.free(u);
        resolved_url = null;
    }

    set_digest(digest);

    if (cache_dir) |dir| {
        cache.set_cache_dir(dir);
        cache.set_manifest_path(digest);
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

    Log.dbg("bundle", "downloading '{s}' (offset={d}, len={d})", .{ name, entry.offset, entry.length });

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
            Log.dbg("bundle", "  fetch failed (attempt {d}/{d}): {}", .{ attempt + 1, retry_attempts, err });
            body_out.deinit();
            posix.nanosleep(0, retry_sleep_ns);
            continue;
        };

        if (result.status != .partial_content and result.status != .ok) {
            Log.dbg("bundle", "  unexpected HTTP status: {d} (attempt {d}/{d})", .{
                @intFromEnum(result.status), attempt + 1, retry_attempts,
            });
            body_out.deinit();
            posix.nanosleep(0, retry_sleep_ns);
            continue;
        }

        const data = body_out.toOwnedSlice() catch |err| {
            Log.dbg("bundle", "  alloc failed: {}", .{err});
            body_out.deinit();
            continue;
        };
        Log.dbg("bundle", "  downloaded {d} bytes", .{data.len});
        return data;
    }

    Log.dbg("bundle", "failed to download '{s}' after {d} attempts", .{ name, retry_attempts });
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
                Log.dbg("bundle", "prefetch: failed '{s}': {}", .{ name, err });
            body_out.deinit();
            posix.nanosleep(0, retry_sleep_ns);
            continue;
        };

        if (result.status != .partial_content and result.status != .ok) {
            if (attempt == retry_attempts - 1)
                Log.dbg("bundle", "prefetch: HTTP {d} for '{s}'", .{ @intFromEnum(result.status), name });
            body_out.deinit();
            posix.nanosleep(0, retry_sleep_ns);
            continue;
        }

        return body_out.toOwnedSlice() catch |err| {
            Log.dbg("bundle", "prefetch: alloc failed for '{s}': {}", .{ name, err });
            body_out.deinit();
            continue;
        };
    }

    return error.NetworkError;
}

// -- cache --

pub fn cache_check(name: []const u8) Host.CacheStatus {
    if (cache.get_cache_dir().len == 0) return .unsupported;
    return if (cache.has(name)) .hit else .miss;
}

pub fn cache_open(name: []const u8) ?fs.File {
    return cache.open_cached(name);
}

pub fn cache_write(name: []const u8, content: []const u8) void {
    const hex_hash = Cache.hash_content(content);
    cache.write(name, &hex_hash, content) catch |err| {
        Log.dbg("bundle", "cache write failed: {s} err={}", .{ name, err });
    };
}

pub fn cache_save() void {
    cache.save_manifest() catch {};
}

pub fn cache_count() usize {
    return cache.count();
}

// expose the underlying Cache for setup operations (manifest loading, dir setup)
pub fn get_cache() *Cache {
    return &cache;
}

// -- batch seed --

pub fn batch_seed(items: []const Host.SeedItem, concurrency: usize) Host.SeedResult {
    if (items.len == 0) return .{ .fetched = 0, .failed = 0 };

    Log.dbg("bundle", "seed: {d} files to fetch", .{items.len});

    const url = get_data_url();

    var work_index = std.atomic.Value(usize).init(0);
    var fetched_count = std.atomic.Value(usize).init(0);
    var failed_count = std.atomic.Value(usize).init(0);
    var cache_mutex: std.Thread.Mutex = .{};

    const actual_concurrency = @min(concurrency, items.len);

    const WorkerCtx = struct {
        items: []const Host.SeedItem,
        work_idx: *std.atomic.Value(usize),
        fetched: *std.atomic.Value(usize),
        failed: *std.atomic.Value(usize),
        cache_mtx: *std.Thread.Mutex,
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
            var thread_client: http.Client = .{ .allocator = std.heap.c_allocator };

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

                wctx.cache_mtx.lock();
                defer wctx.cache_mtx.unlock();

                cache.write(item.name, &hex_hash, content) catch |err| {
                    Log.dbg("bundle", "seed: cache write failed for '{s}': {}", .{ item.name, err });
                    _ = wctx.failed.fetchAdd(1, .monotonic);
                    continue;
                };

                _ = wctx.fetched.fetchAdd(1, .monotonic);
            }
        }
    }.run;

    var threads: [16]?std.Thread = .{null} ** 16;
    const thread_count = @min(actual_concurrency, 16);
    for (0..thread_count) |i| {
        threads[i] = std.Thread.spawn(.{}, worker_fn, .{ctx}) catch null;
    }
    for (0..thread_count) |i| {
        if (threads[i]) |t| t.join();
    }

    const fetched = fetched_count.load(.monotonic);
    const failed = failed_count.load(.monotonic);

    cache.save_manifest() catch {};
    Log.dbg("bundle", "seed: done ({d} fetched, {d} failed)", .{ fetched, failed });

    return .{ .fetched = fetched, .failed = failed };
}

// -- bundle index --

pub fn load_cached_index(digest: []const u8, alloc: std.mem.Allocator) ?[]u8 {
    const cache_dir = cache.get_cache_dir();
    if (cache_dir.len == 0) return null;

    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/indexes/{s}.txt", .{
        cache_dir, digest,
    }) catch return null;

    const file = fs.cwd().openFile(path, .{}) catch return null;
    defer file.close();

    return file.readToEndAlloc(alloc, 64 * 1024 * 1024) catch null;
}

pub fn fetch_index(alloc: std.mem.Allocator) ![]u8 {
    const idx_url = get_index_url();

    Log.dbg("bundle", "fetching bundle index from {s}", .{idx_url});

    const c = get_client();
    var body_out: Io.Writer.Allocating = .init(alloc);
    defer body_out.deinit();

    const result = c.fetch(.{
        .location = .{ .url = idx_url },
        .response_writer = &body_out.writer,
    }) catch |err| {
        Log.dbg("bundle", "failed to fetch bundle index: {}", .{err});
        return error.NetworkError;
    };

    if (result.status != .ok) {
        Log.dbg("bundle", "bundle index fetch returned HTTP {d}", .{@intFromEnum(result.status)});
        return error.HttpError;
    }

    const compressed = body_out.written();
    Log.dbg("bundle", "bundle index downloaded ({d} bytes compressed)", .{compressed.len});

    // gzip decompress
    var input_reader: Io.Reader = .fixed(compressed);
    var window_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress = std.compress.flate.Decompress.init(&input_reader, .gzip, &window_buf);

    var output: Io.Writer.Allocating = .init(alloc);
    errdefer output.deinit();

    _ = decompress.reader.streamRemaining(&output.writer) catch |err| {
        Log.dbg("bundle", "gzip decompression error: {}", .{err});
        return error.DecompressError;
    };

    return try output.toOwnedSlice();
}

pub fn cache_index(digest: []const u8, content: []const u8) void {
    const cache_dir = cache.get_cache_dir();
    if (cache_dir.len == 0) return;

    var dir_buf: [1024]u8 = undefined;
    const dir_path = std.fmt.bufPrint(&dir_buf, "{s}/indexes", .{cache_dir}) catch return;
    fs.cwd().makePath(dir_path) catch {};

    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/indexes/{s}.txt", .{
        cache_dir, digest,
    }) catch return;

    const file = fs.cwd().createFile(path, .{}) catch return;
    defer file.close();
    file.writeAll(content) catch {};
}

// -- time --

pub fn timestamp_ns() i128 {
    return std.time.nanoTimestamp();
}

// -- internal helpers --

fn get_client() *http.Client {
    if (client == null) {
        client = .{ .allocator = std.heap.c_allocator };
    }
    return &client.?;
}

fn get_data_url() []const u8 {
    if (resolved_url) |u| return u;

    const cache_dir = cache.get_cache_dir();
    if (cache_dir.len == 0) return data_url_buf[0..data_url_len];

    // check for cached redirect
    var path_buf: [1024]u8 = undefined;
    // we need the digest for the redirect path -- extract from manifest path
    const digest = get_digest_from_state();
    const redirect_path = std.fmt.bufPrint(&path_buf, "{s}/redirects/{s}.txt", .{
        cache_dir, digest,
    }) catch return data_url_buf[0..data_url_len];

    if (fs.cwd().openFile(redirect_path, .{})) |file| {
        defer file.close();
        const content = file.readToEndAlloc(std.heap.c_allocator, 4096) catch return data_url_buf[0..data_url_len];
        const trimmed = std.mem.trimRight(u8, content, " \t\r\n");
        if (trimmed.len < content.len) {
            const result = std.heap.c_allocator.dupe(u8, trimmed) catch return data_url_buf[0..data_url_len];
            std.heap.c_allocator.free(content);
            resolved_url = result;
        } else {
            resolved_url = content;
        }
        return resolved_url.?;
    } else |_| {
        return data_url_buf[0..data_url_len];
    }
}

fn get_index_url() []const u8 {
    if (index_url_len > 0) return index_url_buf[0..index_url_len];
    // fallback: derive from bundle URL (legacy convention)
    return data_url_buf[0..data_url_len];
}

// the digest is stored in the manifest path -- extract it
var digest_buf: [128]u8 = undefined;
var digest_len: usize = 0;

fn get_digest_from_state() []const u8 {
    if (digest_len > 0) return digest_buf[0..digest_len];
    return "";
}

pub fn set_digest(digest: []const u8) void {
    if (digest.len <= digest_buf.len) {
        @memcpy(digest_buf[0..digest.len], digest);
        digest_len = digest.len;
    }
}

// -- setup --
// native platform setup: cache directory discovery, manifest loading, PM creation.
// returns cache directory path, or null if unavailable.

var g_cache_dir_buf: [512]u8 = undefined;
var g_manifest_buf: [1024]u8 = undefined;
var g_setup_digest_buf: [128]u8 = undefined;

pub fn setup(world: *Engine.World, _: bool, cache_dir_override: ?[]const u8) ?[]const u8 {
    const cache_dir = if (cache_dir_override) |override| blk: {
        if (fs.path.isAbsolute(override)) {
            if (override.len > g_cache_dir_buf.len) {
                Log.log("eztex", .err, "cache-dir path too long ({d} bytes)", .{override.len});
                return null;
            }
            @memcpy(g_cache_dir_buf[0..override.len], override);
            break :blk g_cache_dir_buf[0..override.len];
        }
        if (fs.cwd().realpathAlloc(std.heap.c_allocator, override)) |abs| {
            if (abs.len > g_cache_dir_buf.len) {
                Log.log("eztex", .err, "cache-dir path too long ({d} bytes)", .{abs.len});
                return null;
            }
            @memcpy(g_cache_dir_buf[0..abs.len], abs);
            break :blk g_cache_dir_buf[0..abs.len];
        } else |_| {
            var cwd_buf: [512]u8 = undefined;
            const cwd = posix.getcwd(&cwd_buf) catch {
                Log.log("eztex", .err, "cannot resolve cache-dir: getcwd failed", .{});
                return null;
            };
            break :blk std.fmt.bufPrint(&g_cache_dir_buf, "{s}/{s}", .{ cwd, override }) catch {
                Log.log("eztex", .err, "cache-dir path too long", .{});
                return null;
            };
        }
    } else find_cache_dir(&g_cache_dir_buf) orelse {
        Log.log("eztex", .warn, "no cache directory found, bundle files unavailable", .{});
        return null;
    };

    if (cache_dir_override != null) {
        std.fs.makeDirAbsolute(cache_dir) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => {
                Log.log("eztex", .err, "cannot create cache-dir '{s}': {}", .{ cache_dir, err });
                return null;
            },
        };
        Log.dbg("eztex", "using cache override: {s}", .{cache_dir});
    }
    Log.dbg("eztex", "found cache: {s}", .{cache_dir});

    const digest: []const u8 = &Config.default_bundle_digest;

    // initialize the Host layer (sets cache dir, data URL, index URL, digest on module state)
    init(cache_dir, Config.default_bundle_url, Config.default_index_url, digest);

    // load the cache manifest from disk if it exists
    if (find_manifest_info(cache_dir, &g_manifest_buf, &g_setup_digest_buf)) |info| {
        Log.dbg("eztex", "loading manifest: {s}", .{info.path});
        Log.dbg("eztex", "bundle digest: {s}", .{info.digest});
        cache.load_manifest(info.path) catch |err| {
            Log.log("eztex", .warn, "failed to load manifest: {}", .{err});
        };
    } else {
        Log.log("eztex", .info, "no cached manifest found, will bootstrap from network on demand", .{});
    }

    // create PM with config-derived URL and digest
    const bs = BundleStore.init(std.heap.c_allocator, Config.default_bundle_url, digest);

    Engine.set_bundle_store(bs);
    world.bundle_store = Engine.get_bundle_store();
    Log.dbg("eztex", "bundle store initialized", .{});

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

fn remove_cache_symlinks(cdir: []const u8) void {
    var dir = fs.openDirAbsolute(cdir, .{}) catch return;
    defer dir.close();

    const subdirs = [_][]const u8{ "files", "manifests", "indexes", "formats", "redirects" };
    var path_buf: [1024]u8 = undefined;
    for (subdirs) |sub| {
        const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ cdir, sub }) catch continue;
        var link_buf: [512]u8 = undefined;
        _ = posix.readlink(full_path, &link_buf) catch continue;
        dir.deleteFile(sub) catch {};
    }
}

fn find_manifest_info(cdir: []const u8, path_buf: []u8, dbuf: []u8) ?struct { path: []const u8, digest: []const u8 } {
    const digest: []const u8 = &Config.default_bundle_digest;
    if (digest.len > dbuf.len) return null;
    @memcpy(dbuf[0..digest.len], digest);

    var dir_buf: [1024]u8 = undefined;
    const manifest_path = std.fmt.bufPrint(&dir_buf, "{s}/manifests/{s}.txt", .{ cdir, digest }) catch return null;

    const file = fs.cwd().openFile(manifest_path, .{}) catch return null;
    defer file.close();
    const stat = file.stat() catch return null;
    if (stat.size == 0) return null;

    const path = std.fmt.bufPrint(path_buf, "{s}", .{manifest_path}) catch return null;
    return .{ .path = path, .digest = dbuf[0..digest.len] };
}
