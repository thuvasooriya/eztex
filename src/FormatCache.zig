// FormatCache.zig -- content-addressed cache for XeTeX format files.
// cache key = SHA256(bundle_digest ++ engine_version ++ format_type)
// on hit: return cached bytes. on miss: return null.
const std = @import("std");
const Io = std.Io;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Digest = @import("Digest.zig");
const FormatCache = @This();

pub const FormatType = enum(u8) {
    xelatex = 0,
    plain = 1,
    pdflatex = 2,
};

pub const Key = struct {
    bundle_digest: [32]u8,
    engine_version: u32,
    format_type: FormatType,

    pub fn hash(self: Key) [32]u8 {
        var h = Sha256.init(.{});
        h.update(&self.bundle_digest);
        const ver_bytes: [4]u8 = @bitCast(std.mem.nativeToBig(u32, self.engine_version));
        h.update(&ver_bytes);
        h.update(&.{@intFromEnum(self.format_type)});
        return h.finalResult();
    }

    pub fn hex_filename(self: Key) [64 + 4]u8 {
        const hex = Digest.toHex(self.hash());
        var name: [64 + 4]u8 = undefined;
        @memcpy(name[0..64], &hex);
        name[64] = '.';
        name[65] = 'f';
        name[66] = 'm';
        name[67] = 't';
        return name;
    }
};

pub const LoadError = error{
    CacheDirNotFound,
    FileNotFound,
    ReadFailed,
    OutOfMemory,
};

pub const StoreError = error{
    CacheDirNotFound,
    MakeDirFailed,
    WriteFailed,
    OutOfMemory,
};

fn format_dir_path(cache_dir: []const u8, buf: []u8) ?[]const u8 {
    return std.fmt.bufPrint(buf, "{s}/formats", .{cache_dir}) catch null;
}

// load cached format bytes. returns null on miss.
pub fn load(io: Io, allocator: std.mem.Allocator, cache_dir: []const u8, key: Key) LoadError!?[]u8 {
    const name = key.hex_filename();
    var dir_buf: [1024]u8 = undefined;
    const formats_path = format_dir_path(cache_dir, &dir_buf) orelse return null;
    var dir = Io.Dir.openDirAbsolute(io, formats_path, .{}) catch return null;
    defer dir.close(io);

    const file = dir.openFile(io, &name, .{}) catch return null;
    defer file.close(io);

    const stat = file.stat(io) catch return null;
    if (stat.size == 0) return null;

    const size: usize = @intCast(stat.size);
    const bytes = allocator.alloc(u8, size) catch return null;
    errdefer allocator.free(bytes);

    const n = file.readPositionalAll(io, bytes, 0) catch {
        allocator.free(bytes);
        return null;
    };
    if (n != size) {
        allocator.free(bytes);
        return null;
    }

    return bytes;
}

// store format bytes under the cache key.
pub fn store(io: Io, _: std.mem.Allocator, cache_dir: []const u8, key: Key, bytes: []const u8) StoreError!void {
    const name = key.hex_filename();
    var dir_buf: [1024]u8 = undefined;
    const formats_path = format_dir_path(cache_dir, &dir_buf) orelse return StoreError.MakeDirFailed;

    // ensure formats directory exists
    Io.Dir.cwd().createDirPath(io, formats_path) catch return StoreError.MakeDirFailed;

    var dir = Io.Dir.openDirAbsolute(io, formats_path, .{}) catch |err| switch (err) {
        error.FileNotFound => return StoreError.CacheDirNotFound,
        else => return StoreError.MakeDirFailed,
    };
    defer dir.close(io);

    const file = dir.createFile(io, &name, .{}) catch return StoreError.WriteFailed;
    defer file.close(io);

    var write_buf: [4096]u8 = undefined;
    var writer = file.writerStreaming(io, &write_buf);
    writer.interface.writeAll(bytes) catch return StoreError.WriteFailed;
    _ = writer.interface.flush() catch {};
}

// remove cached entry for key. no-op if not present.
pub fn invalidate(io: Io, cache_dir: []const u8, key: Key) void {
    var dir_buf: [1024]u8 = undefined;
    const formats_path = format_dir_path(cache_dir, &dir_buf) orelse return;
    var dir = Io.Dir.openDirAbsolute(io, formats_path, .{}) catch return;
    defer dir.close(io);
    const name = key.hex_filename();
    dir.deleteFile(io, &name) catch {};
}

// -- tests --

const testing = std.testing;

test "cache miss when directory does not exist" {
    const key = Key{
        .bundle_digest = @splat(0xAA),
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const result = try FormatCache.load(testing.io, testing.allocator, "/nonexistent_cache_dir_xyz", key);
    try testing.expect(result == null);
}

test "store then load returns same bytes" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const cache_dir_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const cache_dir: []const u8 = std.mem.sliceTo(cache_dir_raw, 0);

    const key = Key{
        .bundle_digest = @splat(0xBB),
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const data = "hello format bytes 12345";

    try FormatCache.store(testing.io, testing.allocator, cache_dir, key, data);

    const loaded = try FormatCache.load(testing.io, testing.allocator, cache_dir, key);
    try testing.expect(loaded != null);
    defer testing.allocator.free(loaded.?);

    try testing.expectEqualStrings(data, loaded.?);
}

test "different keys produce different files" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const cache_dir_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const cache_dir: []const u8 = std.mem.sliceTo(cache_dir_raw, 0);

    const key1 = Key{
        .bundle_digest = @splat(0x01),
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const key2 = Key{
        .bundle_digest = @splat(0x02),
        .engine_version = 33,
        .format_type = .xelatex,
    };

    try FormatCache.store(testing.io, testing.allocator, cache_dir, key1, "data_one");
    try FormatCache.store(testing.io, testing.allocator, cache_dir, key2, "data_two");

    const loaded1 = try FormatCache.load(testing.io, testing.allocator, cache_dir, key1);
    try testing.expect(loaded1 != null);
    defer testing.allocator.free(loaded1.?);

    const loaded2 = try FormatCache.load(testing.io, testing.allocator, cache_dir, key2);
    try testing.expect(loaded2 != null);
    defer testing.allocator.free(loaded2.?);

    try testing.expectEqualStrings("data_one", loaded1.?);
    try testing.expectEqualStrings("data_two", loaded2.?);
}

test "format type affects cache key" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const cache_dir_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const cache_dir: []const u8 = std.mem.sliceTo(cache_dir_raw, 0);

    const key_latex = Key{
        .bundle_digest = @splat(0xCC),
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const key_plain = Key{
        .bundle_digest = @splat(0xCC),
        .engine_version = 33,
        .format_type = .plain,
    };

    try FormatCache.store(testing.io, testing.allocator, cache_dir, key_latex, "latex_data");
    try FormatCache.store(testing.io, testing.allocator, cache_dir, key_plain, "plain_data");

    const loaded_latex = try FormatCache.load(testing.io, testing.allocator, cache_dir, key_latex);
    try testing.expect(loaded_latex != null);
    defer testing.allocator.free(loaded_latex.?);

    const loaded_plain = try FormatCache.load(testing.io, testing.allocator, cache_dir, key_plain);
    try testing.expect(loaded_plain != null);
    defer testing.allocator.free(loaded_plain.?);

    try testing.expectEqualStrings("latex_data", loaded_latex.?);
    try testing.expectEqualStrings("plain_data", loaded_plain.?);
}

test "invalidate removes cached entry" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const cache_dir_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const cache_dir: []const u8 = std.mem.sliceTo(cache_dir_raw, 0);

    const key = Key{
        .bundle_digest = @splat(0xDD),
        .engine_version = 33,
        .format_type = .xelatex,
    };

    try FormatCache.store(testing.io, testing.allocator, cache_dir, key, "some data");

    // verify it's there
    const loaded = try FormatCache.load(testing.io, testing.allocator, cache_dir, key);
    try testing.expect(loaded != null);
    testing.allocator.free(loaded.?);

    // invalidate
    FormatCache.invalidate(testing.io, cache_dir, key);

    const loaded2 = try FormatCache.load(testing.io, testing.allocator, cache_dir, key);
    try testing.expect(loaded2 == null);
}

test "key hash is deterministic" {
    const key = Key{
        .bundle_digest = @splat(0xEE),
        .engine_version = 42,
        .format_type = .plain,
    };
    const h1 = key.hash();
    const h2 = key.hash();
    try testing.expectEqualSlices(u8, &h1, &h2);
}
