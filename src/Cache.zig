// Cache.zig -- content-addressed file cache for native target.
//
// Stores files using SHA-256 content hashing in a layout compatible with
// the ITAR bundle cache: files/{hash[0:2]}/{hash[2:]}
// Manifest format: "name size hash\n" per line.
//
// Cache directory:
//   macOS:  ~/Library/Caches/eztex/v1/
//   Linux:  $XDG_CACHE_HOME/eztex/v1/ (default ~/.cache/eztex/v1/)
//
// Not compiled on WASM -- BundleStore uses a comptime void field instead.

const std = @import("std");
const builtin = @import("builtin");
const fs = std.fs;
const Io = std.Io;
const posix = std.posix;
const Digest = @import("Digest.zig");

const Cache = @This();

allocator: std.mem.Allocator,
base_dir: [512]u8 = @splat(0),
base_dir_len: usize = 0,
manifest: std.StringHashMap(ManifestEntry),
manifest_path: [1024]u8 = @splat(0),
manifest_path_len: usize = 0,
dirty: bool = false,

pub const ManifestEntry = struct {
    hash: [64]u8,
    size: u32,
};

pub fn init(allocator: std.mem.Allocator) Cache {
    return .{
        .allocator = allocator,
        .manifest = std.StringHashMap(ManifestEntry).init(allocator),
    };
}

pub fn deinit(self: *Cache) void {
    var it = self.manifest.iterator();
    while (it.next()) |entry| {
        self.allocator.free(entry.key_ptr.*);
    }
    self.manifest.deinit();
}

// detect and set the platform-appropriate cache directory.
// returns false if no cache directory could be determined (e.g. WASM).
pub fn detect_cache_dir(self: *Cache) bool {
    const home = std.c.getenv("HOME") orelse return false;

    // macOS: ~/Library/Caches/eztex/v1/
    // Linux/other: $XDG_CACHE_HOME/eztex/v1/ or ~/.cache/eztex/v1/
    const cache_base = if (comptime builtin.os.tag == .macos)
        std.fmt.bufPrint(&self.base_dir, "{s}/Library/Caches/eztex/v1", .{home}) catch return false
    else blk: {
        const xdg = std.c.getenv("XDG_CACHE_HOME");
        if (xdg) |xdg_dir| {
            break :blk std.fmt.bufPrint(&self.base_dir, "{s}/eztex/v1", .{xdg_dir}) catch return false;
        }
        break :blk std.fmt.bufPrint(&self.base_dir, "{s}/.cache/eztex/v1", .{home}) catch return false;
    };

    self.base_dir_len = cache_base.len;
    return true;
}

// set cache directory explicitly (for migration or testing)
pub fn set_cache_dir(self: *Cache, dir: []const u8) void {
    const copy_len = @min(dir.len, self.base_dir.len);
    @memcpy(self.base_dir[0..copy_len], dir[0..copy_len]);
    self.base_dir_len = copy_len;
}

pub fn get_cache_dir(self: *const Cache) []const u8 {
    return self.base_dir[0..self.base_dir_len];
}

// ensure the cache directory structure exists
pub fn ensure_dirs(self: *Cache) !void {
    if (self.base_dir_len == 0) return error.NoCacheDir;
    const dir = self.get_cache_dir();

    // create local io instance for native-only module
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();

    // create base dirs manually using createDirPath (creates parent dirs as needed)
    var buf: [1024]u8 = undefined;
    for ([_][]const u8{ "files", "manifests", "indexes", "formats" }) |sub| {
        const path = std.fmt.bufPrint(&buf, "{s}/{s}", .{ dir, sub }) catch continue;
        // Create dir and any parent directories - ignore errors if it exists
        Io.Dir.cwd().createDirPath(io, path) catch {};
    }
}

// load a manifest file (format: "name size hash" per line)
pub fn load_manifest(self: *Cache, path: []const u8) !void {
    // create local io instance for native-only module
    var threaded: std.Io.Threaded = .init_single_threaded;
    const io = threaded.io();

    const file = try Io.Dir.cwd().openFile(io, path, .{});
    defer file.close(io);

    // Read file content manually (Io.File doesn't have readToEndAlloc in 0.16)
    const stat = try file.stat(io);
    const content = try self.allocator.alloc(u8, stat.size);
    errdefer self.allocator.free(content);
    var read_buf: [4096]u8 = undefined;
    var file_reader = file.readerStreaming(io, &read_buf);
    const reader = &file_reader.interface;
    try reader.readSliceAll(content);

    var line_iter = std.mem.splitScalar(u8, content, '\n');
    while (line_iter.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len < 66) continue; // minimum: "x 0 " + 64 hex chars

        // parse from right: last 64 chars = hash, then size, then name
        const hash_start = trimmed.len - 64;
        const hash_str = trimmed[hash_start..];

        var valid = true;
        for (hash_str) |c| {
            if (!std.ascii.isHex(c)) {
                valid = false;
                break;
            }
        }
        if (!valid) continue;
        if (hash_start == 0 or trimmed[hash_start - 1] != ' ') continue;
        const size_end = hash_start - 1;

        // find name/size boundary
        var name_end = size_end;
        while (name_end > 0 and trimmed[name_end - 1] != ' ') {
            name_end -= 1;
        }
        if (name_end == 0) continue;
        name_end -= 1;

        const filename = trimmed[0..name_end];
        if (filename.len == 0) continue;
        if (std.mem.startsWith(u8, filename, "SVNREV") or
            std.mem.startsWith(u8, filename, "GITHASH")) continue;

        const size_str = trimmed[name_end + 1 .. size_end];
        const size = std.fmt.parseInt(u32, size_str, 10) catch 0;

        var entry = ManifestEntry{ .hash = undefined, .size = size };
        @memcpy(&entry.hash, hash_str);

        const owned_name = try self.allocator.dupe(u8, filename);
        self.manifest.put(owned_name, entry) catch {
            self.allocator.free(owned_name);
            continue;
        };
    }

    // remember manifest path for save
    const copy_len = @min(path.len, self.manifest_path.len);
    @memcpy(self.manifest_path[0..copy_len], path[0..copy_len]);
    self.manifest_path_len = copy_len;
}

// save manifest to disk (only if dirty)
pub fn save_manifest(self: *Cache, io: Io) !void {
    if (!self.dirty) return;
    if (self.manifest_path_len == 0) return error.NoManifestPath;

    const path = self.manifest_path[0..self.manifest_path_len];
    const file = try Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);

    var write_buf: [4096]u8 = undefined;
    var writer = file.writerStreaming(io, &write_buf);
    var it = self.manifest.iterator();
    while (it.next()) |entry| {
        var buf: [2048]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "{s} {d} {s}\n", .{
            entry.key_ptr.*,
            entry.value_ptr.size,
            &entry.value_ptr.hash,
        }) catch continue;
        writer.interface.writeAll(line) catch {};
    }
    _ = writer.interface.flush() catch {};

    self.dirty = false;
}

// set manifest path for the given bundle digest
pub fn set_manifest_path(self: *Cache, digest: []const u8) void {
    const dir = self.get_cache_dir();
    const result = std.fmt.bufPrint(&self.manifest_path, "{s}/manifests/{s}.txt", .{ dir, digest }) catch return;
    self.manifest_path_len = result.len;
}

// check if a file is in the manifest
pub fn has(self: *const Cache, name: []const u8) bool {
    return self.manifest.contains(name);
}

// open a cached file by name. returns null if not in manifest or file missing.
pub fn open_cached(self: *const Cache, io: Io, name: []const u8) ?Io.File {
    const entry = self.manifest.get(name) orelse return null;
    const dir = self.get_cache_dir();
    if (dir.len == 0) return null;

    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/files/{s}/{s}", .{
        dir,
        entry.hash[0..2],
        entry.hash[2..],
    }) catch return null;

    const file = Io.Dir.cwd().openFile(io, path, .{}) catch return null;

    // Validate actual file size against manifest to catch corrupted/truncated entries
    const stat = file.stat(io) catch {
        file.close(io);
        return null;
    };
    const actual_size: u64 = @intCast(@min(stat.size, std.math.maxInt(u64)));
    if (actual_size != entry.size) {
        std.log.debug("Cache size mismatch for '{s}': expected {d}, got {d}, treating as miss", .{
            name, entry.size, actual_size,
        });
        file.close(io);
        return null;
    }

    return file;
}

// write content to cache under its content hash. updates manifest.
pub fn write(self: *Cache, io: Io, name: []const u8, hex_hash: *const [64]u8, content: []const u8) !void {
    const dir = self.get_cache_dir();
    if (dir.len == 0) return error.NoCacheDir;

    // ensure subdirectory exists using createDirPath (creates parent dirs as needed)
    var dir_buf: [1024]u8 = undefined;
    const sub_dir = std.fmt.bufPrint(&dir_buf, "{s}/files/{s}", .{
        dir,
        hex_hash[0..2],
    }) catch return error.PathTooLong;
    Io.Dir.cwd().createDirPath(io, sub_dir) catch {};

    // write file
    var path_buf: [1024]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/files/{s}/{s}", .{
        dir,
        hex_hash[0..2],
        hex_hash[2..],
    }) catch return error.PathTooLong;

    const file = try Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);
    var write_buf: [4096]u8 = undefined;
    var writer = file.writerStreaming(io, &write_buf);
    try writer.interface.writeAll(content);
    try writer.interface.flush();

    // update manifest
    const size: u32 = @intCast(@min(content.len, std.math.maxInt(u32)));
    if (self.manifest.get(name) == null) {
        const owned_name = try self.allocator.dupe(u8, name);
        var entry = ManifestEntry{ .hash = undefined, .size = size };
        @memcpy(&entry.hash, hex_hash);
        self.manifest.put(owned_name, entry) catch {
            self.allocator.free(owned_name);
            return;
        };
    } else {
        // update existing entry
        const ptr = self.manifest.getPtr(name).?;
        @memcpy(&ptr.hash, hex_hash);
        ptr.size = size;
    }

    self.dirty = true;
}

// compute sha256 hex hash of content
pub fn hash_content(content: []const u8) [64]u8 {
    return Digest.hexDigest(content);
}

// read cached file content by name (returns owned slice, caller frees)
pub fn read_cached(self: *const Cache, io: Io, name: []const u8) ?[]u8 {
    const file = self.open_cached(io, name) orelse return null;
    defer file.close(io);

    // Read file content manually (Io.File doesn't have readToEndAlloc in 0.16)
    const stat = file.stat(io) catch return null;
    const content = self.allocator.alloc(u8, stat.size) catch return null;
    errdefer self.allocator.free(content);
    var read_buf: [4096]u8 = undefined;
    var file_reader = file.readerStreaming(io, &read_buf);
    const reader = &file_reader.interface;
    reader.readSliceAll(content) catch {
        self.allocator.free(content);
        return null;
    };
    return content;
}

// get the number of entries in the manifest
pub fn count(self: *const Cache) usize {
    return self.manifest.count();
}
