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
// This module is self-contained for freestanding wasm32 (no Host.zig, Engine.zig,
// or BundleStore.zig dependencies). It implements its own minimal index store
// with just the parsing and lookup logic needed for the JS worker contract.

const std = @import("std");
const builtin = @import("builtin");

// Allocator: wasm_allocator for freestanding wasm, c_allocator for host-native testing
const allocator = if (builtin.cpu.arch == .wasm32)
    std.heap.wasm_allocator
else
    std.heap.c_allocator;

// Minimal imports: only pure Zig modules with no C/Engine deps
const Config = @import("Config.zig");
const seeds = @import("seeds.zig");
const MainDetect = @import("MainDetect.zig");
const Log = @import("Log.zig");

// -- minimal wasm-only index store (no Host/Engine/BundleStore deps) --

const IndexEntry = struct {
    offset: u64,
    length: u32,
};

var global_index: ?std.StringHashMap(IndexEntry) = null;
var global_index_loaded: bool = false;

fn ensure_index() *std.StringHashMap(IndexEntry) {
    if (global_index == null) {
        global_index = std.StringHashMap(IndexEntry).init(allocator);
    }
    return &(global_index.?);
}

fn clear_index() void {
    if (global_index) |*idx| {
        var it = idx.iterator();
        while (it.next()) |entry| {
            allocator.free(entry.key_ptr.*);
        }
        idx.clearRetainingCapacity();
    }
    global_index_loaded = false;
}

// parse ITAR index text into the global index. keys are lowercased for
// case-insensitive lookup. clears any previously loaded index.
fn parse_index(content: []const u8) !void {
    clear_index();
    const idx = ensure_index();

    var line_iter = std.mem.splitScalar(u8, content, '\n');
    while (line_iter.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
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
        ascii_lower(owned_name);
        // handle duplicate keys: if key exists, free the new key and update value
        const result = idx.fetchPut(owned_name, .{ .offset = offset, .length = length }) catch {
            allocator.free(owned_name);
            continue;
        };
        if (result) |old_entry| {
            allocator.free(old_entry.key);
        }
    }
    global_index_loaded = true;
}

// resolve name to index entry, handling case-insensitive lookup and fonts/ prefix stripping.
// index keys are stored lowercased, so we lowercase the query too.
fn resolve_index_entry(name: []const u8) ?IndexEntry {
    const idx = ensure_index();

    var buf: [1024]u8 = undefined;
    const lower = lower_into(&buf, name) orelse return null;
    if (idx.get(lower)) |entry| return entry;

    // try stripping fonts/ prefix (WASM fetches use bare names in index)
    const fonts_prefix = "fonts/";
    if (lower.len > fonts_prefix.len and std.mem.eql(u8, lower[0..fonts_prefix.len], fonts_prefix)) {
        return idx.get(lower[fonts_prefix.len..]);
    }
    return null;
}

fn lower_into(buf: []u8, s: []const u8) ?[]u8 {
    if (s.len > buf.len) return null;
    @memcpy(buf[0..s.len], s);
    ascii_lower(buf[0..s.len]);
    return buf[0..s.len];
}

fn ascii_lower(s: []u8) void {
    for (s) |*c| {
        if (c.* >= 'A' and c.* <= 'Z') c.* += 32;
    }
}

fn dbg_wasm(scope: []const u8, comptime fmt: []const u8, args: anytype) void {
    if (!Log.is_debug()) return;
    _ = scope;
    _ = fmt;
    _ = args;
}

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

// parse ITAR index text into the global index. used by the JS api_instance
// for index_lookup queries (batch_fetch). returns 0 on success, -1 on error.
pub export fn eztex_push_index(data_ptr: [*]const u8, data_len: usize) i32 {
    dbg_wasm("wasm_export", "eztex_push_index: {d} bytes", .{data_len});
    const content = data_ptr[0..data_len];
    parse_index(content) catch |err| {
        dbg_wasm("wasm_export", "eztex_push_index: parse failed: {}", .{err});
        return -1;
    };
    const idx = ensure_index();
    dbg_wasm("wasm_export", "eztex_push_index: success, {d} entries", .{idx.count()});
    return 0;
}

// query: look up index entry for Range request parameters.
// returns 0 on success (writes offset/length to output pointers), -1 if not found.
pub export fn eztex_query_index(
    name_ptr: [*]const u8,
    name_len: usize,
    out_offset: *u64,
    out_length: *u32,
) i32 {
    const name = name_ptr[0..name_len];
    dbg_wasm("wasm_export", "eztex_query_index: \"{s}\"", .{name});
    const entry = resolve_index_entry(name) orelse {
        dbg_wasm("wasm_export", "eztex_query_index: not found", .{});
        return -1;
    };
    out_offset.* = entry.offset;
    out_length.* = entry.length;
    dbg_wasm("wasm_export", "eztex_query_index: found offset={d} len={d}", .{ entry.offset, entry.length });
    return 0;
}

// return cache version string for OPFS invalidation.
// format: "v2-zig-" + first 16 chars of bundle_digest.
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
    const list = list_ptr[0..list_len];

    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(allocator);

    var iter = std.mem.splitScalar(u8, list, '\n');
    while (iter.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0) continue;
        files.append(allocator, trimmed) catch continue;
    }

    if (files.items.len == 0) return 0;

    const result = MainDetect.detect(allocator, files.items, null, null) orelse return 0;

    if (result.len > out_cap) return 0;
    @memcpy(out_ptr[0..result.len], result);
    return result.len;
}
