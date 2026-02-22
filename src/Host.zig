// Host.zig -- comptime-dispatched host abstraction layer.
//
// Isolates the hard platform divergences (transport, storage, concurrency)
// behind a single interface so BundleStore and main.zig can be
// platform-agnostic.
//
// Necessary divergences hidden here:
//   - Transport: std.http (native) vs sync XHR extern (WASM)
//   - Storage: filesystem Cache.zig (native) vs WASI fs + OPFS (WASM)
//   - Concurrency: OS threads (native) vs single-threaded (WASM)
//   - ABI: u64 offsets (native) vs u32 lo/hi split (WASM)
//   - Time: std.time (native) vs extern (WASM)

const std = @import("std");
const builtin = @import("builtin");
const Engine = @import("Engine.zig");

pub const is_wasm = builtin.cpu.arch == .wasm32;

const Impl = if (is_wasm)
    @import("hosts/wasm.zig")
else
    @import("hosts/native.zig");

pub const IndexEntry = struct {
    offset: u64,
    length: u32,
};

pub const CacheStatus = enum { hit, miss, unsupported };

pub const SeedItem = struct {
    name: []const u8,
    entry: IndexEntry,
};

pub const SeedResult = struct {
    fetched: usize,
    failed: usize,
};

// -- initialization --

// platform-specific setup: cache discovery + BundleStore init (native) or JS host init (WASM).
// returns cache directory path on native, null on WASM.
pub fn setup(world: *Engine.World, verbose: bool, cache_dir_override: ?[]const u8) ?[]const u8 {
    return Impl.setup(world, verbose, cache_dir_override);
}

// initialize the host layer. native: sets up cache dir, HTTP state.
// wasm: no-op (JS manages transport state).
pub fn init(cache_dir: ?[]const u8, data_url: []const u8, index_url: []const u8, digest: []const u8) void {
    Impl.init(cache_dir, data_url, index_url, digest);
}

// -- range fetch: retrieve bytes from bundle at (offset, length) --
// both platforms: return owned slice or error. caller frees with allocator.
pub fn fetch_range(
    name: []const u8,
    entry: IndexEntry,
    alloc: std.mem.Allocator,
) ![]u8 {
    return Impl.fetch_range(name, entry, alloc);
}

// -- persistent cache --

// check if a file exists in the persistent cache
pub fn cache_check(name: []const u8) CacheStatus {
    return Impl.cache_check(name);
}

// read file content from the persistent cache. returns null if not cached.
pub fn cache_open(name: []const u8) ?std.fs.File {
    return Impl.cache_open(name);
}

// write file content to persistent cache
pub fn cache_write(name: []const u8, content: []const u8) void {
    Impl.cache_write(name, content);
}

// save cache manifest (native: writes manifest to disk, wasm: no-op)
pub fn cache_save() void {
    Impl.cache_save();
}

// number of entries in the persistent cache
pub fn cache_count() usize {
    return Impl.cache_count();
}

// -- batch seed (native only) --
// fetch multiple files concurrently using OS thread pool with work-stealing.
// only available on native -- callers must guard with `if (!is_wasm)`.
pub fn batch_seed(items: []const SeedItem, concurrency: usize) SeedResult {
    if (is_wasm) @compileError("batch_seed is not available on WASM");
    return Impl.batch_seed(items, concurrency);
}

// -- bundle index --
// try loading cached index from disk. returns decompressed text or null.
// native: reads from {cache_dir}/indexes/{digest}.txt
// wasm: always returns null (index is fetched fresh via js_request_index extern)
pub fn load_cached_index(digest: []const u8, alloc: std.mem.Allocator) ?[]u8 {
    return Impl.load_cached_index(digest, alloc);
}

// fetch bundle index from network and decompress. returns decompressed text.
// native: HTTP GET {data_url}.index.gz + gzip decompress
// wasm: calls js_request_index extern (JS returns cached decompressed bytes)
pub fn fetch_index(alloc: std.mem.Allocator) ![]u8 {
    return Impl.fetch_index(alloc);
}

// cache decompressed index text to disk for future runs.
// native: writes to {cache_dir}/indexes/{digest}.txt
// wasm: no-op
pub fn cache_index(digest: []const u8, content: []const u8) void {
    Impl.cache_index(digest, content);
}

// -- time --

pub fn timestamp_ns() i128 {
    return Impl.timestamp_ns();
}
