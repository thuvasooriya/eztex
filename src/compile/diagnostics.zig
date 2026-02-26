// compile/diagnostics.zig -- diagnostic output formatting and parsing.
//
// Parses "file:line: message\ncontext" output from C engines,
// formats with severity labels and optional ANSI colors.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Log = @import("../Log.zig");
const Host = @import("../Host.zig");
const World = @import("../World.zig");
const is_wasm = Host.is_wasm;

pub fn diag_write_stderr(io: Io, text: []const u8) void {
    var buf: [4096]u8 = undefined;
    var w = Log.stderr_writer(io, &buf);
    const iface = &w.interface;
    iface.writeAll(text) catch {};
    iface.writeByte('\n') catch {};
    iface.flush() catch {};
}

// parsed diagnostic parts from the C engine's "file:line: message\ncontext..." format
pub const DiagParts = struct {
    file: ?[]const u8,
    line: ?[]const u8,
    message: []const u8,
    context: ?[]const u8,
};

// parse "file:line: message" prefix from diagnostic text.
// the C engine's diagnostic_print_file_line() emits "%s:%d: " at the start.
// handles both "./file.tex:5: msg" and bare "msg" (no prefix).
pub fn parse_diag_text(text: []const u8) DiagParts {
    const first_nl = std.mem.indexOfScalar(u8, text, '\n');
    const first_line = if (first_nl) |nl| text[0..nl] else text;
    const context = if (first_nl) |nl| (if (nl + 1 < text.len) text[nl + 1 ..] else null) else null;

    if (parse_file_line_prefix(first_line)) |parsed| {
        return .{
            .file = parsed.file,
            .line = parsed.line_str,
            .message = parsed.rest,
            .context = context,
        };
    }

    return .{ .file = null, .line = null, .message = first_line, .context = context };
}

pub const FileLinePrefix = struct {
    file: []const u8,
    line_str: []const u8,
    rest: []const u8,
};

pub fn parse_file_line_prefix(line: []const u8) ?FileLinePrefix {
    var i: usize = 0;
    while (i < line.len) {
        if (line[i] == ':' and i > 0) {
            const after_colon = i + 1;
            var j = after_colon;
            while (j < line.len and line[j] >= '0' and line[j] <= '9') : (j += 1) {}
            if (j > after_colon and j + 1 < line.len and line[j] == ':' and line[j + 1] == ' ') {
                return .{
                    .file = line[0..i],
                    .line_str = line[after_colon..j],
                    .rest = line[j + 2 ..],
                };
            }
        }
        i += 1;
    }
    return null;
}

pub fn detect_use_color(_: Io) bool {
    if (is_wasm) return false;
    // check if stderr (fd 2) is a terminal
    if (builtin.os.tag == .windows) return false; // TODO: Windows console detection
    return std.c.isatty(2) == 1;
}

pub fn diag_write_with_severity(io: Io, text: []const u8, comptime severity: []const u8) void {
    if (text.len == 0) return;
    var buf: [8192]u8 = undefined;
    var w = Log.stderr_writer(io, &buf);
    const iface = &w.interface;
    const use_color = detect_use_color(io);
    const parsed = parse_diag_text(text);

    if (use_color) {
        const color = if (comptime std.mem.eql(u8, severity, "error")) "\x1b[1;31m" else "\x1b[1;33m";
        iface.writeAll(color) catch {};
        iface.writeAll(severity) catch {};
        iface.writeAll(":\x1b[0m ") catch {};
    } else {
        iface.writeAll(severity) catch {};
        iface.writeAll(": ") catch {};
    }

    iface.writeAll(parsed.message) catch {};
    iface.writeByte('\n') catch {};

    if (parsed.file) |file| {
        if (use_color) {
            iface.writeAll("  \x1b[1;34m-->\x1b[0m ") catch {};
        } else {
            iface.writeAll("  --> ") catch {};
        }
        iface.writeAll(file) catch {};
        if (parsed.line) |line_str| {
            iface.writeByte(':') catch {};
            iface.writeAll(line_str) catch {};
        }
        iface.writeByte('\n') catch {};
    }

    if (parsed.context) |ctx| {
        if (ctx.len > 0) {
            var line_iter = std.mem.splitScalar(u8, ctx, '\n');
            while (line_iter.next()) |ctx_line| {
                if (ctx_line.len == 0) continue;
                if (use_color) {
                    iface.writeAll("  \x1b[1;34m|\x1b[0m ") catch {};
                } else {
                    iface.writeAll("  | ") catch {};
                }
                iface.writeAll(ctx_line) catch {};
                iface.writeByte('\n') catch {};
            }
        }
    }

    iface.flush() catch {};
}

fn on_diag_warning(io: Io, text: []const u8) void {
    diag_write_with_severity(io, text, "warning");
}

fn on_diag_error(io: Io, text: []const u8) void {
    diag_write_with_severity(io, text, "error");
}

fn on_diag_info(io: Io, text: []const u8) void {
    diag_write_stderr(io, text);
}

pub const default_diag_handler = World.DiagnosticHandler{
    .on_warning = on_diag_warning,
    .on_error = on_diag_error,
    .on_info = on_diag_info,
};

// -- tests --

test "parse_file_line_prefix: valid file:line: message" {
    const result = parse_file_line_prefix("./input.tex:5: Undefined control sequence") orelse
        return error.ExpectedNonNull;
    try std.testing.expectEqualStrings("./input.tex", result.file);
    try std.testing.expectEqualStrings("5", result.line_str);
    try std.testing.expectEqualStrings("Undefined control sequence", result.rest);
}

test "parse_file_line_prefix: multi-digit line number" {
    const result = parse_file_line_prefix("chapter1.tex:142: LaTeX Error: \\begin{document} ended") orelse
        return error.ExpectedNonNull;
    try std.testing.expectEqualStrings("chapter1.tex", result.file);
    try std.testing.expectEqualStrings("142", result.line_str);
    try std.testing.expectEqualStrings("LaTeX Error: \\begin{document} ended", result.rest);
}

test "parse_file_line_prefix: path with directory" {
    const result = parse_file_line_prefix("src/chapters/intro.tex:7: Missing $ inserted") orelse
        return error.ExpectedNonNull;
    try std.testing.expectEqualStrings("src/chapters/intro.tex", result.file);
    try std.testing.expectEqualStrings("7", result.line_str);
    try std.testing.expectEqualStrings("Missing $ inserted", result.rest);
}

test "parse_file_line_prefix: no match on bare message" {
    try std.testing.expectEqual(null, parse_file_line_prefix("Undefined control sequence"));
}

test "parse_file_line_prefix: no match without space after second colon" {
    try std.testing.expectEqual(null, parse_file_line_prefix("file:5:nospace"));
}

test "parse_diag_text: file:line: message with context" {
    const text = "./input.tex:5: Undefined control sequence\nl.5 \\badcommand\n               \\badcommand";
    const parsed = parse_diag_text(text);
    try std.testing.expectEqualStrings("./input.tex", parsed.file.?);
    try std.testing.expectEqualStrings("5", parsed.line.?);
    try std.testing.expectEqualStrings("Undefined control sequence", parsed.message);
    try std.testing.expect(parsed.context != null);
    try std.testing.expect(std.mem.startsWith(u8, parsed.context.?, "l.5 \\badcommand"));
}

test "parse_diag_text: bare message no prefix" {
    const parsed = parse_diag_text("Emergency stop");
    try std.testing.expectEqual(null, parsed.file);
    try std.testing.expectEqual(null, parsed.line);
    try std.testing.expectEqualStrings("Emergency stop", parsed.message);
    try std.testing.expectEqual(null, parsed.context);
}

test "parse_diag_text: message with context but no file prefix" {
    const text = "Emergency stop\n<*> \\input badfile";
    const parsed = parse_diag_text(text);
    try std.testing.expectEqual(null, parsed.file);
    try std.testing.expectEqual(null, parsed.line);
    try std.testing.expectEqualStrings("Emergency stop", parsed.message);
    try std.testing.expectEqualStrings("<*> \\input badfile", parsed.context.?);
}
