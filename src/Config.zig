// Config.zig -- optional eztex.zon project config parser.
// loads ZON config from the input file's directory (or cwd),
// providing project-level defaults that CLI flags can override.
//
// Config is the single source of truth for all defaults.
// `Config.default()` provides the canonical default values.

const std = @import("std");
const fs = std.fs;
const Config = @This();

// compilation target
entry: ?[]const u8 = null,
output: ?[]const u8 = null,
paper: ?[]const u8 = null,
format: ?Format = null,

// pass control
passes: ?Passes = null,

// feature toggles
synctex: ?bool = null,
deterministic: ?bool = null,
keep_intermediates: ?bool = null,

// bundle override
bundle: ?Bundle = null,

// extra files to include in compilation environment
files: ?[]const []const u8 = null,

pub const Format = enum { latex, plain };
pub const Passes = union(enum) {
    auto,
    single,
    fixed: u8,
};
pub const CachePolicy = enum { auto, always, refresh };
pub const Bundle = struct {
    url: ?[]const u8 = null,
    index: ?[]const u8 = null,
    digest: ?[]const u8 = null,
    cache: CachePolicy = .auto,
};

pub const filename = "eztex.zon";

// canonical bundle URL and digest -- the single source of truth.
pub const default_bundle_url = "https://eztex-cors-proxy.thuva.workers.dev/bundle";
pub const default_index_url = "https://eztex-cors-proxy.thuva.workers.dev/index.gz";
pub const default_bundle_digest = compute_digest(default_bundle_url);

fn compute_digest(comptime input: []const u8) [64]u8 {
    @setEvalBranchQuota(10000);
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(input, &hash, .{});
    const hex_chars = "0123456789abcdef";
    var hex: [64]u8 = undefined;
    for (hash, 0..) |byte, i| {
        hex[i * 2] = hex_chars[byte >> 4];
        hex[i * 2 + 1] = hex_chars[byte & 0x0f];
    }
    return hex;
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
    digest: []const u8,
    cache: CachePolicy,
};

// resolve effective bundle settings: fill in defaults for any null fields.
pub fn effective_bundle(self: Config) ResolvedBundle {
    const b = self.bundle orelse Bundle{};
    return .{
        .url = b.url orelse default_bundle_url,
        .index_url = b.index orelse default_index_url,
        .digest = b.digest orelse &default_bundle_digest,
        .cache = b.cache,
    };
}

// load config from directory, or return defaults if no config file found.
pub fn load_or_default(allocator: std.mem.Allocator, dir_path: ?[]const u8) Config {
    const maybe = load(allocator, dir_path) catch return Config.default();
    return maybe orelse Config.default();
}

// attempt to load eztex.zon from the given directory.
// returns null if file doesn't exist. errors on malformed ZON.
pub fn load(allocator: std.mem.Allocator, dir_path: ?[]const u8) !?Config {
    var path_buf: [4096]u8 = undefined;
    const config_path = if (dir_path) |d|
        std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ d, filename }) catch return null
    else
        filename;

    const file = fs.cwd().openFile(config_path, .{}) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return null, // don't fail on permission errors etc
    };
    defer file.close();

    const content = file.readToEndAllocOptions(allocator, 64 * 1024, null, .@"1", 0) catch return null;
    defer allocator.free(content);

    const config = std.zon.parse.fromSlice(Config, allocator, content, null, .{
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
    const result = try Config.load(allocator, "/nonexistent/path");
    try std.testing.expect(result == null);
}

test "load valid config" {
    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .entry = "thesis.tex",
        \\    .paper = "a4",
        \\    .synctex = true,
        \\}
    ;
    try tmp_dir.dir.writeFile(.{ .sub_path = filename, .data = content });

    // get the path as a string
    var path_buf: [4096]u8 = undefined;
    const dir_path = try tmp_dir.dir.realpath(".", &path_buf);

    const config = try Config.load(allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expectEqualStrings("thesis.tex", c.entry.?);
    try std.testing.expectEqualStrings("a4", c.paper.?);
    try std.testing.expect(c.synctex.? == true);
    try std.testing.expect(c.format == null);
    try std.testing.expect(c.deterministic == null);
}

test "load config with format and passes" {
    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .format = .plain,
        \\    .passes = .single,
        \\}
    ;
    try tmp_dir.dir.writeFile(.{ .sub_path = filename, .data = content });

    var path_buf: [4096]u8 = undefined;
    const dir_path = try tmp_dir.dir.realpath(".", &path_buf);

    const config = try Config.load(allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expect(c.format.? == .plain);
    try std.testing.expect(std.meta.activeTag(c.passes.?) == .single);
}

test "malformed config returns null" {
    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    try tmp_dir.dir.writeFile(.{ .sub_path = filename, .data = "this is not valid zon {{{" });

    var path_buf: [4096]u8 = undefined;
    const dir_path = try tmp_dir.dir.realpath(".", &path_buf);

    const config = try Config.load(allocator, dir_path);
    try std.testing.expect(config == null);
}

test "load config with bundle" {
    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .entry = "paper.tex",
        \\    .bundle = .{
        \\        .url = "https://example.com/bundle.tar",
        \\        .digest = "abc123",
        \\        .cache = .always,
        \\    },
        \\}
    ;
    try tmp_dir.dir.writeFile(.{ .sub_path = filename, .data = content });

    var path_buf: [4096]u8 = undefined;
    const dir_path = try tmp_dir.dir.realpath(".", &path_buf);

    const config = try Config.load(allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expectEqualStrings("paper.tex", c.entry.?);
    try std.testing.expect(c.bundle != null);
    const b = c.bundle.?;
    try std.testing.expectEqualStrings("https://example.com/bundle.tar", b.url.?);
    try std.testing.expectEqualStrings("abc123", b.digest.?);
    try std.testing.expect(b.cache == .always);
}

test "load config with bundle url only" {
    const allocator = std.testing.allocator;
    var tmp_dir = std.testing.tmpDir(.{});
    defer tmp_dir.cleanup();

    const content: [:0]const u8 =
        \\.{
        \\    .bundle = .{
        \\        .url = "https://example.com/custom.tar",
        \\    },
        \\}
    ;
    try tmp_dir.dir.writeFile(.{ .sub_path = filename, .data = content });

    var path_buf: [4096]u8 = undefined;
    const dir_path = try tmp_dir.dir.realpath(".", &path_buf);

    const config = try Config.load(allocator, dir_path);
    try std.testing.expect(config != null);
    const c = config.?;
    defer c.deinit(allocator);

    try std.testing.expect(c.bundle != null);
    const b = c.bundle.?;
    try std.testing.expectEqualStrings("https://example.com/custom.tar", b.url.?);
    try std.testing.expect(b.digest == null);
    try std.testing.expect(b.cache == .auto);
}
