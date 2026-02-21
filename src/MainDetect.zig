// MainDetect.zig -- detect the main TeX file in a project directory.
// shared by native (main.zig) and WASM (wasm_exports.zig) paths.
// uses heuristics to find the primary .tex file to compile.

const std = @import("std");
const MainDetect = @This();

// common main file names in priority order
const known_names = [_][]const u8{
    "main.tex",
    "index.tex",
    "thesis.tex",
    "paper.tex",
    "document.tex",
    "report.tex",
};

// detect the main TeX file from a list of filenames.
// files: list of filenames (relative paths, e.g. "chapter1.tex", "main.tex")
// read_fn: optional callback to read first N bytes of a file (for \documentclass scan)
//          returns null if file can't be read.
//
// heuristics (first match wins):
//   1. only one .tex file in root -> use it
//   2. file containing \documentclass (scan first 4096 bytes)
//   3. well-known names: main.tex, index.tex, thesis.tex, paper.tex, document.tex
//   4. alphabetically first .tex file (last resort)
pub fn detect(
    allocator: std.mem.Allocator,
    files: []const []const u8,
    read_fn: ?*const fn ([]const u8) ?[]const u8,
) ?[]const u8 {
    // collect root-level .tex files (no path separators)
    var tex_files: std.ArrayList([]const u8) = .empty;
    defer tex_files.deinit(allocator);

    for (files) |f| {
        if (is_root_tex(f)) {
            tex_files.append(allocator, f) catch continue;
        }
    }

    if (tex_files.items.len == 0) return null;

    // heuristic 1: only one .tex file
    if (tex_files.items.len == 1) return tex_files.items[0];

    // heuristic 2: scan for \documentclass
    if (read_fn) |reader| {
        // first pass: find files with \documentclass
        var doc_class_file: ?[]const u8 = null;
        var doc_class_count: usize = 0;

        for (tex_files.items) |f| {
            if (reader(f)) |content| {
                if (has_documentclass(content)) {
                    doc_class_count += 1;
                    if (doc_class_file == null) doc_class_file = f;
                }
            }
        }

        // if exactly one has \documentclass, use it
        if (doc_class_count == 1) return doc_class_file;

        // if multiple have \documentclass, prefer known names among them
        if (doc_class_count > 1) {
            for (&known_names) |name| {
                for (tex_files.items) |f| {
                    if (std.mem.eql(u8, basename(f), name)) {
                        if (reader(f)) |content| {
                            if (has_documentclass(content)) return f;
                        }
                    }
                }
            }
            // fall through to known names check
        }
    }

    // heuristic 3: well-known names
    for (&known_names) |name| {
        for (tex_files.items) |f| {
            if (std.mem.eql(u8, basename(f), name)) return f;
        }
    }

    // heuristic 4: alphabetically first
    std.mem.sort([]const u8, tex_files.items, {}, struct {
        fn lessThan(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.lessThan);
    return tex_files.items[0];
}

fn is_root_tex(path: []const u8) bool {
    // root-level: no directory separators, ends with .tex
    if (std.mem.indexOfScalar(u8, path, '/') != null) return false;
    if (std.mem.indexOfScalar(u8, path, '\\') != null) return false;
    return std.mem.endsWith(u8, path, ".tex");
}

fn basename(path: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, path, '/')) |idx| return path[idx + 1 ..];
    if (std.mem.lastIndexOfScalar(u8, path, '\\')) |idx| return path[idx + 1 ..];
    return path;
}

fn has_documentclass(content: []const u8) bool {
    // scan for \documentclass (within first 4096 bytes or full content)
    const scan_limit = @min(content.len, 4096);
    const scan = content[0..scan_limit];
    return std.mem.indexOf(u8, scan, "\\documentclass") != null;
}

// -- tests --

test "detect single tex file" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{"paper.tex"};
    const result = detect(allocator, &files, null);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("paper.tex", result.?);
}

test "detect known name priority" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "chapter1.tex", "main.tex", "appendix.tex" };
    const result = detect(allocator, &files, null);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("main.tex", result.?);
}

test "detect thesis.tex over unknown" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "intro.tex", "thesis.tex", "conclusion.tex" };
    const result = detect(allocator, &files, null);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("thesis.tex", result.?);
}

test "detect alphabetically first as fallback" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "zebra.tex", "alpha.tex", "beta.tex" };
    const result = detect(allocator, &files, null);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("alpha.tex", result.?);
}

test "detect ignores subdirectory files" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "chapters/intro.tex", "main.tex" };
    const result = detect(allocator, &files, null);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("main.tex", result.?);
}

test "detect no tex files returns null" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "README.md", "Makefile" };
    const result = detect(allocator, &files, null);
    try std.testing.expect(result == null);
}

test "detect with documentclass reader" {
    const allocator = std.testing.allocator;
    const files = [_][]const u8{ "preamble.tex", "mydoc.tex", "macros.tex" };

    // mydoc.tex has \documentclass, others don't
    const reader = struct {
        fn read(name: []const u8) ?[]const u8 {
            if (std.mem.eql(u8, name, "mydoc.tex")) {
                return "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
            }
            return "% just macros\n\\newcommand{\\foo}{bar}";
        }
    }.read;

    const result = detect(allocator, &files, &reader);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("mydoc.tex", result.?);
}
