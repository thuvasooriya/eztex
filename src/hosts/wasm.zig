// hosts/wasm.zig -- WASM host implementation.
//
// Wraps the js_request_range extern import for range fetches.
// Index fetching uses js_request_index extern (JS returns cached decompressed bytes).
// WASM has no persistent cache (OPFS is managed by JS host externally).
// Single-threaded: batch seed just does sequential fetches.

const std = @import("std");
const fs = std.fs;
const Host = @import("../Host.zig");
const bridge = @import("../bridge.zig");
const Config = @import("../Config.zig");
const BundleStore = @import("../BundleStore.zig");
const Log = @import("../Log.zig");

const allocator = std.heap.c_allocator;
const dbg = Log.dbg;

// -- JS host callbacks (extern imports) --

extern "env" fn js_request_range(
    name_ptr: [*]const u8,
    name_len: usize,
    offset_lo: u32,
    offset_hi: u32,
    length: u32,
    buf_ptr: *[*]u8,
    buf_len: *usize,
) i32;

// JS provides decompressed ITAR index text (cached from async fetch during init).
// returns 0 on success, -1 if index not available.
extern "env" fn js_request_index(
    buf_ptr: *[*]u8,
    buf_len: *usize,
) i32;

// -- init (no-op on WASM, JS manages transport state) --

pub fn init(_: ?[]const u8, _: []const u8, _: []const u8, _: []const u8) void {}

// -- setup --
// WASM platform setup: init BundleStore with c_allocator.
// files are fetched on demand from JS host via js_request_range.
// returns null (WASM has no persistent cache directory).
pub fn setup(world: *bridge.World, _: bool, _: ?[]const u8) ?[]const u8 {
    dbg("wasm", "setup: initializing BundleStore with c_allocator", .{});
    const bs = BundleStore.init(allocator, Config.default_bundle_url, &Config.default_bundle_digest);
    bridge.set_bundle_store(bs);
    world.bundle_store = bridge.get_bundle_store();
    dbg("wasm", "setup: complete, bundle_store set", .{});
    return null;
}

// -- fetch --

pub fn fetch_range(name: []const u8, entry: Host.IndexEntry, alloc: std.mem.Allocator) ![]u8 {
    dbg("wasm", "fetch_range: \"{s}\" offset={d} len={d}", .{ name, entry.offset, entry.length });
    var buf_ptr: [*]u8 = undefined;
    var buf_len: usize = 0;

    const offset_lo: u32 = @intCast(entry.offset & 0xFFFFFFFF);
    const offset_hi: u32 = @intCast(entry.offset >> 32);

    const result = js_request_range(
        name.ptr,
        name.len,
        offset_lo,
        offset_hi,
        entry.length,
        &buf_ptr,
        &buf_len,
    );
    if (result != 0) {
        dbg("wasm", "fetch_range: JS returned error ({d})", .{result});
        return error.FileNotFound;
    }
    if (buf_len == 0) {
        dbg("wasm", "fetch_range: JS returned 0 bytes", .{});
        return error.FileNotFound;
    }

    dbg("wasm", "fetch_range: got {d} bytes from JS", .{buf_len});
    const js_slice = buf_ptr[0..buf_len];
    const owned = try alloc.dupe(u8, js_slice);
    allocator.free(js_slice);
    return owned;
}

// -- cache (WASM has no persistent cache from Zig's perspective) --
// JS pre-loads files into WASI filesystem and manages OPFS externally.

pub fn cache_check(_: []const u8) Host.CacheStatus {
    return .unsupported;
}

pub fn cache_open(_: []const u8) ?fs.File {
    return null;
}

pub fn cache_write(_: []const u8, _: []const u8) void {}

pub fn cache_save() void {}

pub fn cache_count() usize {
    return 0;
}

// -- bundle index --

pub fn load_cached_index(_: []const u8, _: std.mem.Allocator) ?[]u8 {
    return null;
}

// fetch decompressed ITAR index text via JS host extern.
// JS caches the decompressed bytes from its async init fetch, so this is
// effectively a memory copy (no network call).
pub fn fetch_index(alloc: std.mem.Allocator) ![]u8 {
    var buf_ptr: [*]u8 = undefined;
    var buf_len: usize = 0;

    const result = js_request_index(&buf_ptr, &buf_len);
    if (result != 0) return error.IndexNotLoaded;
    if (buf_len == 0) return error.IndexNotLoaded;

    const js_slice = buf_ptr[0..buf_len];
    const owned = try alloc.dupe(u8, js_slice);
    allocator.free(js_slice);
    return owned;
}

pub fn cache_index(_: []const u8, _: []const u8) void {}

// -- time --

pub fn timestamp_ns() i128 {
    // WASM: use WASI clock (available via std.time on wasm32-wasi)
    return std.time.nanoTimestamp();
}
