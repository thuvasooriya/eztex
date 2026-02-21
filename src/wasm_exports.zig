// wasm_exports.zig -- WASM/WASI exported functions.
//
// Provides the eztex_* export surface called from JS:
//   memory:     eztex_alloc, eztex_free
//   index:      eztex_push_index (api_instance), eztex_query_index
//   cache:      eztex_query_cache_version
//   bundle:     eztex_query_bundle_url, eztex_query_index_url
//   file lists: eztex_query_seed_init, eztex_query_seed_format
//   project:    eztex_query_main_file
//
// Per-compile instances self-load the index via ensure_index() ->
// Host.fetch_index() -> js_request_index extern (no load_index needed).
// Range fetch is handled by hosts/wasm.zig via Host.zig.

const std = @import("std");
const fs = std.fs;
const bridge = @import("bridge.zig");
const Config = @import("Config.zig");
const BundleStore = @import("BundleStore.zig");
const seeds = @import("seeds.zig");
const Log = @import("Log.zig");

const allocator = std.heap.c_allocator;
const dbg = Log.dbg;

// -- memory management exports --

pub export fn eztex_alloc(size: usize) ?[*]u8 {
    const slice = allocator.alloc(u8, size) catch return null;
    return slice.ptr;
}

pub export fn eztex_free(ptr: [*]u8, size: usize) void {
    allocator.free(ptr[0..size]);
}

// -- debug mode export --

pub export fn eztex_set_debug(enabled: u32) void {
    Log.set_debug(enabled != 0);
}

// -- index management exports --

// parse ITAR index text into the global BundleStore's index.
// used by the JS api_instance for index_lookup queries (batch_fetch).
// per-compile instances load their own index via ensure_index().
// returns 0 on success, -1 on error.
pub export fn eztex_push_index(data_ptr: [*]const u8, data_len: usize) i32 {
    dbg("wasm_export", "eztex_push_index: {d} bytes", .{data_len});
    const content = data_ptr[0..data_len];
    const bs = bridge.ensure_bundle_store();
    bs.load_index(content) catch |err| {
        dbg("wasm_export", "eztex_push_index: parse failed: {}", .{err});
        return -1;
    };
    dbg("wasm_export", "eztex_push_index: success, {d} entries", .{bs.bundle_index.count()});
    return 0;
}

// query: look up index entry for Range request parameters.
// returns 0 on success (writes offset/length to output pointers), -1 if not found.
// uses resolve_index_entry for consistent name resolution (fonts/ prefix stripping).
pub export fn eztex_query_index(
    name_ptr: [*]const u8,
    name_len: usize,
    out_offset: *u64,
    out_length: *u32,
) i32 {
    const name = name_ptr[0..name_len];
    dbg("wasm_export", "eztex_query_index: \"{s}\"", .{name});
    const bs = bridge.ensure_bundle_store();
    const entry = bs.resolve_index_entry(name) orelse {
        dbg("wasm_export", "eztex_query_index: not found", .{});
        return -1;
    };
    out_offset.* = entry.offset;
    out_length.* = entry.length;
    dbg("wasm_export", "eztex_query_index: found offset={d} len={d}", .{ entry.offset, entry.length });
    return 0;
}

// return cache version string for OPFS invalidation.
// format: "zig-" + first 16 chars of bundle_digest.
pub export fn eztex_query_cache_version(out_ptr: [*]u8, out_cap: usize) usize {
    const prefix = "v2-zig-";
    const digest_prefix_len = 16;
    const total = prefix.len + digest_prefix_len;
    if (out_cap < total) return 0;
    @memcpy(out_ptr[0..prefix.len], prefix);
    @memcpy(out_ptr[prefix.len..][0..digest_prefix_len], Config.default_bundle_digest[0..digest_prefix_len]);
    return total;
}

// return the effective bundle URL (comptime default; override via eztex.zon not
// available in WASM api_instance, but the default is the single source of truth).
pub export fn eztex_query_bundle_url(out_ptr: [*]u8, out_cap: usize) usize {
    const url = Config.default_bundle_url;
    if (out_cap < url.len) return 0;
    @memcpy(out_ptr[0..url.len], url);
    return url.len;
}

// return the effective index URL (separate from bundle URL).
pub export fn eztex_query_index_url(out_ptr: [*]u8, out_cap: usize) usize {
    const url = Config.default_index_url;
    if (out_cap < url.len) return 0;
    @memcpy(out_ptr[0..url.len], url);
    return url.len;
}

// -- file list exports --

pub export fn eztex_query_seed_init(out_ptr: [*]u8, out_cap: usize) usize {
    return seeds.write_init_seed_list(out_ptr, out_cap);
}

pub export fn eztex_query_seed_format(out_ptr: [*]u8, out_cap: usize) usize {
    return seeds.write_format_gen_seed_list(out_ptr, out_cap);
}

// -- main file detection export --

pub export fn eztex_query_main_file(
    list_ptr: [*]const u8,
    list_len: usize,
    out_ptr: [*]u8,
    out_cap: usize,
) usize {
    const MainDetect = @import("MainDetect.zig");
    const list = list_ptr[0..list_len];

    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(allocator);

    var iter = std.mem.splitScalar(u8, list, '\n');
    while (iter.next()) |line| {
        const trimmed = std.mem.trimRight(u8, line, " \t\r");
        if (trimmed.len == 0) continue;
        files.append(allocator, trimmed) catch continue;
    }

    if (files.items.len == 0) return 0;

    const result = MainDetect.detect(allocator, files.items, null) orelse return 0;

    if (result.len > out_cap) return 0;
    @memcpy(out_ptr[0..result.len], result);
    return result.len;
}
