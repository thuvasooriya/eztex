// Config.zig -- optional eztex.zon project config parser.
// loads ZON config from the input file's directory (or cwd),
// providing project-level defaults that CLI flags can override.
//
// Config is the single source of truth for all defaults.
// `Config.default()` provides the canonical default values.

const std = @import("std");
const fs = std.fs;
const Io = std.Io;
const Config = @This();

// compilation target
entry: ?[]const u8 = null,
output: ?[]const u8 = null,
format: ?Format = null,

// feature toggles
synctex: ?bool = null,
deterministic: ?bool = null,
keep_intermediates: ?bool = null,

// bundle override
bundle: ?Bundle = null,

// extra files to include in compilation environment
files: ?[]const []const u8 = null,

pub const Format = enum { latex, plain };
pub const Bundle = struct {
    url: ?[]const u8 = null,
    index: ?[]const u8 = null,
};

pub const filename = "eztex.zon";

// canonical bundle URL and digest -- the single source of truth.
pub const default_bundle_url = "https://eztex-cors-proxy.thuva.workers.dev/bundle";
pub const default_index_url = "https://eztex-cors-proxy.thuva.workers.dev/index.gz";
pub const default_bundle_digest = compute_digest(default_bundle_url);

fn compute_digest(comptime input: []const u8) [64]u8 {
    @setEvalBranchQuota(10000);
    return @import("Digest.zig").hexDigest(input);
}

// return canonical defaults for all fields.
pub fn default() Config {
    return .{ .bundle = .{} };
}

// resolved bundle with all fields guaranteed non-null.
// use effective_bundle() to get one from a Config.
pub const ResolvedBundle = struct {
    url: []const u8,
    index_url: []const u8,
};

// resolve effective bundle settings: fill in defaults for any null fields.
pub fn effective_bundle(self: Config) ResolvedBundle {
    const b = self.bundle orelse Bundle{};
    return .{
        .url = b.url orelse default_bundle_url,
        .index_url = b.index orelse default_index_url,
    };
}

// compute SHA-256 hex digest from a URL at runtime. returns by value (thread-safe).
pub fn digest_from_url(url: []const u8) [64]u8 {
    if (std.mem.eql(u8, url, default_bundle_url)) return default_bundle_digest;
    return @import("Digest.zig").hexDigest(url);
}

// load config from directory, or return defaults if no config file found.
pub fn load_or_default(io: Io, allocator: std.mem.Allocator, dir_path: ?[]const u8) Config {
    const maybe = load(io, allocator, dir_path) catch return Config.default();
    return maybe orelse Config.default();
}

// attempt to load eztex.zon from the given directory.
// returns null if file doesn't exist. errors on malformed ZON.
pub fn load(io: Io, allocator: std.mem.Allocator, dir_path: ?[]const u8) !?Config {
    var path_buf: [4096]u8 = undefined;
    const config_path = if (dir_path) |d|
        std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ d, filename }) catch return null
    else
        filename;

    const file = Io.Dir.cwd().openFile(io, config_path, .{}) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return null, // don't fail on permission errors etc
    };
    defer file.close(io);

    var read_buf: [64 * 1024]u8 = undefined;
    var file_reader = Io.File.Reader.init(file, io, &read_buf);
    const content = file_reader.interface.allocRemaining(allocator, .unlimited) catch return null;
    defer allocator.free(content);

    // Ensure content is sentinel-terminated for ZON parsing
    const content_sentinel = allocator.allocSentinel(u8, content.len, 0) catch return null;
    defer allocator.free(content_sentinel);
    @memcpy(content_sentinel, content);

    const config = std.zon.parse.fromSliceAlloc(Config, allocator, content_sentinel, null, .{
        .ignore_unknown_fields = true,
    }) catch return null;

    return config;
}

pub fn deinit(self: Config, allocator: std.mem.Allocator) void {
    std.zon.parse.free(allocator, self);
}

// -- tests --

test "load nonexistent config returns null" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    const result = try Config.load(io, allocator, "/nonexistent/path");
    try std.testing.expect(result == null);
}

test "load valid config" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .entry = "thesis.tex",
        \\    .synctex = true,
        \\}
    ;
    try tmp_dir.dir.writeFile(io, .{ .sub_path = filename, .data = content });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp_dir.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path: []const u8 = std.mem.sliceTo(dir_path_raw, 0);

    const config = try Config.load(io, allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expectEqualStrings("thesis.tex", c.entry.?);
    try std.testing.expect(c.synctex.? == true);
    try std.testing.expect(c.format == null);
    try std.testing.expect(c.deterministic == null);
}

test "load config with format" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .format = .plain,
        \\}
    ;
    try tmp_dir.dir.writeFile(io, .{ .sub_path = filename, .data = content });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp_dir.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path: []const u8 = std.mem.sliceTo(dir_path_raw, 0);

    const config = try Config.load(io, allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expect(c.format.? == .plain);
}

test "malformed config returns null" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    try tmp_dir.dir.writeFile(io, .{ .sub_path = filename, .data = "this is not valid zon {{{" });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp_dir.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path: []const u8 = std.mem.sliceTo(dir_path_raw, 0);

    const config = try Config.load(io, allocator, dir_path);
    try std.testing.expect(config == null);
}

test "load config with bundle" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .entry = "paper.tex",
        \\    .bundle = .{
        \\        .url = "https://example.com/bundle.tar",
        \\    },
        \\}
    ;
    try tmp_dir.dir.writeFile(io, .{ .sub_path = filename, .data = content });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp_dir.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path: []const u8 = std.mem.sliceTo(dir_path_raw, 0);

    const config = try Config.load(io, allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expectEqualStrings("paper.tex", c.entry.?);
    try std.testing.expect(c.bundle != null);
    const b = c.bundle.?;
    try std.testing.expectEqualStrings("https://example.com/bundle.tar", b.url.?);
}

test "load config with bundle url only" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .bundle = .{
        \\        .url = "https://example.com/custom.tar",
        \\    },
        \\}
    ;
    try tmp_dir.dir.writeFile(io, .{ .sub_path = filename, .data = content });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp_dir.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path: []const u8 = std.mem.sliceTo(dir_path_raw, 0);

    const config = try Config.load(io, allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expect(c.bundle != null);
    const b = c.bundle.?;
    try std.testing.expectEqualStrings("https://example.com/custom.tar", b.url.?);
    try std.testing.expect(b.index == null);
}

test "digest_from_url returns default for default URL" {
    const d = digest_from_url(default_bundle_url);
    try std.testing.expectEqualStrings(&default_bundle_digest, &d);
}

test "digest_from_url returns deterministic hash for custom URL" {
    const d1 = digest_from_url("https://example.com/bundle.tar");
    try std.testing.expect(d1.len == 64);
    // calling again with same URL should produce same result
    const d2 = digest_from_url("https://example.com/bundle.tar");
    try std.testing.expectEqualStrings(&d1, &d2);
}
