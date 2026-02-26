// hosts/wasm.zig -- WASM host implementation.
//
// Wraps the js_request_range extern import for range fetches.
// Index fetching uses js_request_index extern (JS returns cached decompressed bytes).
// WASM has no persistent cache (OPFS is managed by JS host externally).
// Single-threaded: batch seed just does sequential fetches.

const std = @import("std");
const fs = std.fs;
const Host = @import("../Host.zig");
const Engine = @import("../Engine.zig");
const BundleStore = @import("../BundleStore.zig");
const Log = @import("../Log.zig");

// WASM allocator: use wasm_allocator for JS buffer management (no libc dependency).
// The alloc parameter passed to functions is used for returned data.
const wasm_allocator = std.heap.wasm_allocator;

// -- JS host callbacks (extern imports) --
//
// Ownership contract: JS must return buffers allocated through the module's
// exported allocator path (eztex_alloc). This ensures freeing with wasm_allocator
// on the Zig side is valid. JS receives the allocator via the import table.

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
// The returned buffer must be allocated via the module's exported allocator.
extern "env" fn js_request_index(
    buf_ptr: *[*]u8,
    buf_len: *usize,
) i32;

// -- init (no-op on WASM, JS manages transport state) --

pub fn init(_: ?[]const u8, _: []const u8, _: []const u8, _: []const u8) void {}

// -- setup --
// WASM platform setup: init BundleStore with wasm_allocator.
// files are fetched on demand from JS host via js_request_range.
// returns null (WASM has no persistent cache directory).
pub fn setup(world: *Engine.World, _: bool, _: ?[]const u8, data_url: []const u8, _: []const u8, digest: *const [64]u8) ?[]const u8 {
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();
    Log.dbg(io, "wasm", "setup: initializing BundleStore with wasm_allocator", .{});
    const bs = BundleStore.init(wasm_allocator, data_url, digest);
    Engine.set_bundle_store(bs);
    world.bundle_store = Engine.get_bundle_store();
    Log.dbg(io, "wasm", "setup: complete, bundle_store set", .{});
    return null;
}

// -- fetch --

pub fn fetch_range(name: []const u8, entry: Host.IndexEntry, alloc: std.mem.Allocator) ![]u8 {
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();
    Log.dbg(io, "wasm", "fetch_range: \"{s}\" offset={d} len={d}", .{ name, entry.offset, entry.length });
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
        Log.dbg(io, "wasm", "fetch_range: JS returned error ({d})", .{result});
        return error.FileNotFound;
    }
    if (buf_len == 0) {
        Log.dbg(io, "wasm", "fetch_range: JS returned 0 bytes", .{});
        return error.FileNotFound;
    }

    Log.dbg(io, "wasm", "fetch_range: got {d} bytes from JS", .{buf_len});
    const js_slice = buf_ptr[0..buf_len];
    // copy out of JS-allocated buffer, then free via wasm_allocator (valid
    // because JS allocated through the module's exported allocator path).
    const owned = try alloc.dupe(u8, js_slice);
    wasm_allocator.free(js_slice);
    return owned;
}

// -- cache (WASM has no persistent cache from Zig's perspective) --
// JS pre-loads files into WASI filesystem and manages OPFS externally.

pub fn cache_check(_: []const u8) Host.CacheStatus {
    return .unsupported;
}

pub fn cache_open(_: []const u8) ?std.Io.File {
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
    // copy out of JS-allocated buffer, then free via wasm_allocator (valid
    // because JS allocated through the module's exported allocator path).
    const owned = try alloc.dupe(u8, js_slice);
    wasm_allocator.free(js_slice);
    return owned;
}

pub fn cache_index(_: []const u8, _: []const u8) void {}

// -- time --

pub fn timestamp_ns() i128 {
    // WASM: use WASI clock (available via std.time on wasm32-wasi)
    return std.time.nanoTimestamp();
}
