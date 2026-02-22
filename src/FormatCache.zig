// FormatCache.zig -- content-addressed cache for XeTeX format files.
// cache key = SHA256(bundle_digest ++ engine_version ++ format_type)
// on hit: return cached bytes. on miss: return null.
const std = @import("std");
const fs = std.fs;
const Sha256 = std.crypto.hash.sha2.Sha256;
const FormatCache = @This();

pub const FormatType = enum(u8) {
    xelatex = 0,
    plain = 1,
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
        const digest = self.hash();
        const hex_chars = "0123456789abcdef";
        var name: [64 + 4]u8 = undefined;
        for (digest, 0..) |byte, i| {
            name[i * 2] = hex_chars[byte >> 4];
            name[i * 2 + 1] = hex_chars[byte & 0x0f];
        }
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

// load cached format bytes. returns null on miss.
pub fn load(allocator: std.mem.Allocator, cache_dir: []const u8, key: Key) LoadError!?[]u8 {
    const name = key.hex_filename();
    var dir = fs.openDirAbsolute(cache_dir, .{}) catch return null;
    defer dir.close();

    const file = dir.openFile(&name, .{}) catch return null;
    defer file.close();

    const stat = file.stat() catch return null;
    if (stat.size == 0) return null;

    const bytes = allocator.alloc(u8, @intCast(stat.size)) catch return LoadError.OutOfMemory;
    errdefer allocator.free(bytes);

    var total: usize = 0;
    while (total < bytes.len) {
        const n = file.read(bytes[total..]) catch {
            allocator.free(bytes);
            return null;
        };
        if (n == 0) {
            allocator.free(bytes);
            return null;
        }
        total += n;
    }

    return bytes;
}

// store format bytes under the cache key.
pub fn store(_: std.mem.Allocator, cache_dir: []const u8, key: Key, bytes: []const u8) StoreError!void {
    var dir = fs.openDirAbsolute(cache_dir, .{}) catch |err| switch (err) {
        error.FileNotFound => return StoreError.CacheDirNotFound,
        else => return StoreError.MakeDirFailed,
    };
    defer dir.close();

    const name = key.hex_filename();
    const file = dir.createFile(&name, .{}) catch return StoreError.WriteFailed;
    defer file.close();

    file.writeAll(bytes) catch return StoreError.WriteFailed;
}

// remove cached entry for key. no-op if not present.
pub fn invalidate(cache_dir: []const u8, key: Key) void {
    var dir = fs.openDirAbsolute(cache_dir, .{}) catch return;
    defer dir.close();
    const name = key.hex_filename();
    dir.deleteFile(&name) catch {};
}

// -- tests --

const testing = std.testing;

test "cache miss when directory does not exist" {
    const key = Key{
        .bundle_digest = [_]u8{0xAA} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const result = try FormatCache.load(testing.allocator, "/nonexistent_cache_dir_xyz", key);
    try testing.expect(result == null);
}

test "store then load returns same bytes" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [4096]u8 = undefined;
    const cache_dir = try tmp.dir.realpath(".", &path_buf);

    const key = Key{
        .bundle_digest = [_]u8{0xBB} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const data = "hello format bytes 12345";

    try FormatCache.store(testing.allocator, cache_dir, key, data);

    const loaded = try FormatCache.load(testing.allocator, cache_dir, key);
    try testing.expect(loaded != null);
    defer testing.allocator.free(loaded.?);

    try testing.expectEqualStrings(data, loaded.?);
}

test "different keys produce different files" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [4096]u8 = undefined;
    const cache_dir = try tmp.dir.realpath(".", &path_buf);

    const key1 = Key{
        .bundle_digest = [_]u8{0x01} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const key2 = Key{
        .bundle_digest = [_]u8{0x02} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };

    try FormatCache.store(testing.allocator, cache_dir, key1, "data_one");
    try FormatCache.store(testing.allocator, cache_dir, key2, "data_two");

    const loaded1 = try FormatCache.load(testing.allocator, cache_dir, key1);
    try testing.expect(loaded1 != null);
    defer testing.allocator.free(loaded1.?);

    const loaded2 = try FormatCache.load(testing.allocator, cache_dir, key2);
    try testing.expect(loaded2 != null);
    defer testing.allocator.free(loaded2.?);

    try testing.expectEqualStrings("data_one", loaded1.?);
    try testing.expectEqualStrings("data_two", loaded2.?);
}

test "format type affects cache key" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [4096]u8 = undefined;
    const cache_dir = try tmp.dir.realpath(".", &path_buf);

    const key_latex = Key{
        .bundle_digest = [_]u8{0xCC} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };
    const key_plain = Key{
        .bundle_digest = [_]u8{0xCC} ** 32,
        .engine_version = 33,
        .format_type = .plain,
    };

    try FormatCache.store(testing.allocator, cache_dir, key_latex, "latex_data");
    try FormatCache.store(testing.allocator, cache_dir, key_plain, "plain_data");

    const loaded_latex = try FormatCache.load(testing.allocator, cache_dir, key_latex);
    try testing.expect(loaded_latex != null);
    defer testing.allocator.free(loaded_latex.?);

    const loaded_plain = try FormatCache.load(testing.allocator, cache_dir, key_plain);
    try testing.expect(loaded_plain != null);
    defer testing.allocator.free(loaded_plain.?);

    try testing.expectEqualStrings("latex_data", loaded_latex.?);
    try testing.expectEqualStrings("plain_data", loaded_plain.?);
}

test "invalidate removes cached entry" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var path_buf: [4096]u8 = undefined;
    const cache_dir = try tmp.dir.realpath(".", &path_buf);

    const key = Key{
        .bundle_digest = [_]u8{0xDD} ** 32,
        .engine_version = 33,
        .format_type = .xelatex,
    };

    try FormatCache.store(testing.allocator, cache_dir, key, "some data");

    // verify it's there
    const loaded = try FormatCache.load(testing.allocator, cache_dir, key);
    try testing.expect(loaded != null);
    testing.allocator.free(loaded.?);

    // invalidate
    FormatCache.invalidate(cache_dir, key);

    // should be gone
    const loaded2 = try FormatCache.load(testing.allocator, cache_dir, key);
    try testing.expect(loaded2 == null);
}

test "key hash is deterministic" {
    const key = Key{
        .bundle_digest = [_]u8{0xEE} ** 32,
        .engine_version = 42,
        .format_type = .plain,
    };
    const h1 = key.hash();
    const h2 = key.hash();
    try testing.expectEqualSlices(u8, &h1, &h2);
}
