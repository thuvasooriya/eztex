// compile/aux.zig -- aux file utilities.
//
// Reading, comparing, and analyzing .aux files for multi-pass compilation.

const std = @import("std");
const Io = std.Io;
const testing = std.testing;
const Md5 = std.crypto.hash.Md5;

pub const BibliographyState = struct {
    input_digest: [Md5.digest_length * 2]u8,
    citation_digest: [Md5.digest_length * 2]u8,
};

const BibliographyKind = enum {
    none,
    biblatex,
    bibtex,
};

const bibtex_markers = [_][]const u8{
    "\\bibdata{",
    "\\bibstyle{",
};

const biblatex_markers = [_][]const u8{
    "\\abx@aux@",
};

pub fn read_file_contents(io: Io, path: []const u8) ?[]const u8 {
    // Use openFileAbsolute for absolute paths, cwd().openFile for relative paths
    const file = if (std.fs.path.isAbsolute(path))
        Io.Dir.openFileAbsolute(io, path, .{}) catch return null
    else
        Io.Dir.cwd().openFile(io, path, .{}) catch return null;
    defer file.close(io);
    
    const stat = file.stat(io) catch return null;
    const size: usize = @intCast(stat.size);
    if (size == 0) return null;
    
    // Use the same pattern as World.zig for reading files
    const data = std.heap.c_allocator.alloc(u8, size) catch return null;
    errdefer std.heap.c_allocator.free(data);
    
    const bytes_read = file.readPositionalAll(io, data, 0) catch {
        std.heap.c_allocator.free(data);
        return null;
    };
    
    if (bytes_read != size) {
        std.heap.c_allocator.free(data);
        return null;
    }
    
    return data;
}

pub fn free_file_contents(contents: ?[]const u8) void {
    if (contents) |c| std.heap.c_allocator.free(c);
}

pub fn aux_changed(prev: ?[]const u8, curr: ?[]const u8) bool {
    if (prev == null and curr == null) return false;
    if (prev == null or curr == null) return true;
    return !std.mem.eql(u8, prev.?, curr.?);
}

pub fn aux_needs_bibtex(io: Io, aux_path: []const u8, aux_contents: ?[]const u8) bool {
    return detect_bibliography_kind(io, aux_path, aux_contents) == .bibtex;
}

pub fn aux_is_biblatex(io: Io, aux_path: []const u8, aux_contents: ?[]const u8) bool {
    return detect_bibliography_kind(io, aux_path, aux_contents) == .biblatex;
}

fn detect_bibliography_kind(io: Io, aux_path: []const u8, aux_contents: ?[]const u8) BibliographyKind {
    const allocator = std.heap.c_allocator;
    var detected = bibliography_kind_from_bcf(io, aux_path);

    const content = aux_contents orelse return detected;

    var visited: std.ArrayListUnmanaged([]u8) = .empty;
    defer {
        for (visited.items) |path| allocator.free(path);
        visited.deinit(allocator);
    }

    const resolved_aux_path = resolve_aux_path(allocator, null, aux_path) catch {
        return merge_bibliography_kind(detected, aux_contents_bibliography_kind(content));
    };
    visited.append(allocator, resolved_aux_path) catch {
        allocator.free(resolved_aux_path);
        return merge_bibliography_kind(detected, aux_contents_bibliography_kind(content));
    };

    detected = merge_bibliography_kind(detected, detect_bibliography_kind_recursive(io, resolved_aux_path, content, &visited));
    return detected;
}

pub fn bibliography_state(io: Io, aux_path: []const u8, aux_contents: ?[]const u8) ?BibliographyState {
    const content = aux_contents orelse return null;
    const allocator = std.heap.c_allocator;

    var visited: std.ArrayListUnmanaged([]u8) = .empty;
    defer {
        for (visited.items) |path| allocator.free(path);
        visited.deinit(allocator);
    }

    const resolved_aux_path = resolve_aux_path(allocator, null, aux_path) catch return null;
    visited.append(allocator, resolved_aux_path) catch {
        allocator.free(resolved_aux_path);
        return null;
    };

    var collector = BibliographyCollector.init();
    bibliography_state_recursive(io, resolved_aux_path, content, &visited, &collector);
    if (!collector.has_bibliography) return null;
    return collector.finish();
}

pub fn read_bibliography_state(io: Io, path: []const u8) ?BibliographyState {
    const raw = read_file_contents(io, path) orelse return null;
    defer free_file_contents(raw);

    var state: BibliographyState = undefined;
    var have_inputs = false;
    var have_citations = false;

    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "inputs=")) {
            const hex = line["inputs=".len..];
            if (!copy_hex_digest(state.input_digest[0..], hex)) return null;
            have_inputs = true;
        } else if (std.mem.startsWith(u8, line, "citations=")) {
            const hex = line["citations=".len..];
            if (!copy_hex_digest(state.citation_digest[0..], hex)) return null;
            have_citations = true;
        }
    }

    if (!have_inputs or !have_citations) return null;
    return state;
}

pub fn write_bibliography_state(io: Io, path: []const u8, state: BibliographyState) !void {
    const file = if (std.fs.path.isAbsolute(path))
        try Io.Dir.createFileAbsolute(io, path, .{})
    else
        try Io.Dir.cwd().createFile(io, path, .{});
    defer file.close(io);

    var buf: [160]u8 = undefined;
    const contents = try std.fmt.bufPrint(&buf, "inputs={s}\ncitations={s}\n", .{
        state.input_digest,
        state.citation_digest,
    });
    try file.writeStreamingAll(io, contents);
}

pub fn bib_inputs_changed(current: ?BibliographyState, previous: ?BibliographyState) bool {
    if (current == null) return false;
    if (previous == null) return true;
    return !std.mem.eql(u8, current.?.input_digest[0..], previous.?.input_digest[0..]);
}

pub fn bib_citations_changed(current: ?BibliographyState, previous: ?BibliographyState) bool {
    if (current == null) return false;
    if (previous == null) return true;
    return !std.mem.eql(u8, current.?.citation_digest[0..], previous.?.citation_digest[0..]);
}

fn aux_contents_bibliography_kind(aux_contents: []const u8) BibliographyKind {
    const has_bibtex = contains_any_marker(aux_contents, &bibtex_markers);
    const has_biblatex = contains_any_marker(aux_contents, &biblatex_markers);

    if (has_bibtex) return .bibtex;
    if (has_biblatex) return .biblatex;
    return .none;
}

fn detect_bibliography_kind_recursive(io: Io, aux_path: []const u8, aux_contents: []const u8, visited: *std.ArrayListUnmanaged([]u8)) BibliographyKind {
    const allocator = std.heap.c_allocator;
    var detected = aux_contents_bibliography_kind(aux_contents);
    if (detected == .bibtex) return .bibtex;

    var lines = std.mem.splitScalar(u8, aux_contents, '\n');
    while (lines.next()) |line| {
        const include_path = parse_aux_input_path(line) orelse continue;
        const resolved_include = resolve_aux_path(allocator, aux_path, include_path) catch continue;

        if (path_was_visited(visited.items, resolved_include)) {
            allocator.free(resolved_include);
            continue;
        }

        visited.append(allocator, resolved_include) catch {
            allocator.free(resolved_include);
            continue;
        };

        const include_contents = read_file_contents(io, resolved_include) orelse continue;
        defer free_file_contents(include_contents);

        detected = merge_bibliography_kind(detected, detect_bibliography_kind_recursive(io, resolved_include, include_contents, visited));
        if (detected == .bibtex) return .bibtex;
    }

    return detected;
}

fn merge_bibliography_kind(lhs: BibliographyKind, rhs: BibliographyKind) BibliographyKind {
    if (lhs == .bibtex or rhs == .bibtex) return .bibtex;
    if (lhs == .biblatex or rhs == .biblatex) return .biblatex;
    return .none;
}

fn bibliography_kind_from_bcf(io: Io, aux_path: []const u8) BibliographyKind {
    const allocator = std.heap.c_allocator;
    const bcf_path = companion_file_path(allocator, aux_path, ".bcf") catch return .none;
    defer allocator.free(bcf_path);

    return if (file_exists(io, bcf_path)) .biblatex else .none;
}

fn companion_file_path(allocator: std.mem.Allocator, path: []const u8, ext: []const u8) ![]u8 {
    const current_ext = std.fs.path.extension(path);
    const stem_len = if (current_ext.len > 0) path.len - current_ext.len else path.len;
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ path[0..stem_len], ext });
}

fn file_exists(io: Io, path: []const u8) bool {
    const file = if (std.fs.path.isAbsolute(path))
        Io.Dir.openFileAbsolute(io, path, .{}) catch return false
    else
        Io.Dir.cwd().openFile(io, path, .{}) catch return false;
    defer file.close(io);
    return true;
}

fn contains_any_marker(haystack: []const u8, markers: []const []const u8) bool {
    for (markers) |marker| {
        if (std.mem.indexOf(u8, haystack, marker) != null) return true;
    }
    return false;
}

const BibliographyCollector = struct {
    input_hasher: Md5,
    citation_hasher: Md5,
    has_bibliography: bool,

    fn init() BibliographyCollector {
        return .{
            .input_hasher = Md5.init(.{}),
            .citation_hasher = Md5.init(.{}),
            .has_bibliography = false,
        };
    }

    fn record_citation(self: *BibliographyCollector, line: []const u8) void {
        self.has_bibliography = true;
        self.citation_hasher.update(line);
        self.citation_hasher.update("\n");
    }

    fn record_input(self: *BibliographyCollector, path: []const u8, contents: ?[]const u8) void {
        self.has_bibliography = true;
        self.input_hasher.update(path);
        self.input_hasher.update("\n");
        if (contents) |data| {
            self.input_hasher.update(data);
        } else {
            self.input_hasher.update("<missing>");
        }
        self.input_hasher.update("\n");
    }

    fn finish(self: *BibliographyCollector) BibliographyState {
        var input_raw: [Md5.digest_length]u8 = undefined;
        var citation_raw: [Md5.digest_length]u8 = undefined;
        self.input_hasher.final(&input_raw);
        self.citation_hasher.final(&citation_raw);

        return .{
            .input_digest = hex_encode_digest(&input_raw),
            .citation_digest = hex_encode_digest(&citation_raw),
        };
    }
};

fn bibliography_state_recursive(io: Io, aux_path: []const u8, aux_contents: []const u8, visited: *std.ArrayListUnmanaged([]u8), collector: *BibliographyCollector) void {
    const allocator = std.heap.c_allocator;

    var lines = std.mem.splitScalar(u8, aux_contents, '\n');
    while (lines.next()) |line| {
        if (parse_bibdata(line)) |entries| {
            collector.record_citation(line);
            record_bib_inputs(io, aux_path, entries, ".bib", collector);
        }

        if (parse_bibstyle(line)) |style| {
            collector.record_citation(line);
            record_bib_inputs(io, aux_path, style, ".bst", collector);
        }

        if (parse_citation_line(line)) {
            collector.record_citation(line);
        }

        const include_path = parse_aux_input_path(line) orelse continue;
        const resolved_include = resolve_aux_path(allocator, aux_path, include_path) catch continue;

        if (path_was_visited(visited.items, resolved_include)) {
            allocator.free(resolved_include);
            continue;
        }

        visited.append(allocator, resolved_include) catch {
            allocator.free(resolved_include);
            continue;
        };

        const include_contents = read_file_contents(io, resolved_include) orelse continue;
        defer free_file_contents(include_contents);
        bibliography_state_recursive(io, resolved_include, include_contents, visited, collector);
    }
}

fn record_bib_inputs(io: Io, aux_path: []const u8, payload: []const u8, default_ext: []const u8, collector: *BibliographyCollector) void {
    const allocator = std.heap.c_allocator;
    var parts = std.mem.splitScalar(u8, payload, ',');
    while (parts.next()) |part_raw| {
        const part = std.mem.trim(u8, part_raw, " \t\r");
        if (part.len == 0) continue;

        const normalized = normalize_bib_input(allocator, part, default_ext) catch continue;
        defer allocator.free(normalized);

        const resolved = resolve_aux_path(allocator, aux_path, normalized) catch continue;
        defer allocator.free(resolved);

        const contents = read_file_contents(io, resolved);
        defer free_file_contents(contents);
        collector.record_input(resolved, contents);
    }
}

fn normalize_bib_input(allocator: std.mem.Allocator, value: []const u8, default_ext: []const u8) ![]u8 {
    if (std.fs.path.extension(value).len > 0) {
        return allocator.dupe(u8, value);
    }
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ value, default_ext });
}

fn parse_bibdata(line: []const u8) ?[]const u8 {
    return parse_aux_command_payload(line, "\\bibdata{");
}

fn parse_bibstyle(line: []const u8) ?[]const u8 {
    return parse_aux_command_payload(line, "\\bibstyle{");
}

fn parse_aux_command_payload(line: []const u8, prefix: []const u8) ?[]const u8 {
    const start = std.mem.indexOf(u8, line, prefix) orelse return null;
    const rest = line[start + prefix.len ..];
    const end = std.mem.indexOfScalar(u8, rest, '}') orelse return null;
    if (end == 0) return null;
    return rest[0..end];
}

fn parse_citation_line(line: []const u8) bool {
    return std.mem.startsWith(u8, line, "\\citation{") or std.mem.startsWith(u8, line, "\\abx@aux@");
}

fn copy_hex_digest(dst: []u8, src: []const u8) bool {
    if (src.len != dst.len) return false;
    for (src) |c| {
        switch (c) {
            '0'...'9', 'a'...'f' => {},
            else => return false,
        }
    }
    @memcpy(dst, src);
    return true;
}

fn hex_encode_digest(raw: []const u8) [Md5.digest_length * 2]u8 {
    var out: [Md5.digest_length * 2]u8 = undefined;
    const hex = "0123456789abcdef";
    for (raw, 0..) |byte, i| {
        out[i * 2] = hex[byte >> 4];
        out[i * 2 + 1] = hex[byte & 0x0f];
    }
    return out;
}

fn parse_aux_input_path(line: []const u8) ?[]const u8 {
    const prefix = "\\@input{";
    const start = std.mem.indexOf(u8, line, prefix) orelse return null;
    const rest = line[start + prefix.len ..];
    const end = std.mem.indexOfScalar(u8, rest, '}') orelse return null;
    if (end == 0) return null;
    return rest[0..end];
}

fn path_was_visited(paths: []const []const u8, candidate: []const u8) bool {
    for (paths) |path| {
        if (std.mem.eql(u8, path, candidate)) return true;
    }
    return false;
}

fn resolve_aux_path(allocator: std.mem.Allocator, parent_aux_path: ?[]const u8, aux_path: []const u8) ![]u8 {
    if (std.fs.path.isAbsolute(aux_path)) {
        return std.fs.path.resolve(allocator, &.{aux_path});
    }

    if (parent_aux_path) |parent| {
        const parent_dir = std.fs.path.dirname(parent) orelse ".";
        return std.fs.path.resolve(allocator, &.{ parent_dir, aux_path });
    }

    return std.fs.path.resolve(allocator, &.{aux_path});
}

test "aux_needs_bibtex detects bibliography markers in main aux" {
    try testing.expect(aux_needs_bibtex(testing.io, "main.aux", "\\relax\n\\bibdata{refs}\n"));
}

test "aux_is_biblatex detects biblatex markers in main aux" {
    try testing.expect(aux_is_biblatex(testing.io, "main.aux", "\\relax\n\\abx@aux@cite{0}{refA}\n"));
    try testing.expect(!aux_needs_bibtex(testing.io, "main.aux", "\\relax\n\\abx@aux@cite{0}{refA}\n"));
}

test "aux_is_biblatex detects companion bcf file" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "main.aux", .data = "\\relax\n" });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "main.bcf", .data = "<bcf/>\n" });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path = std.mem.sliceTo(dir_path_raw, 0);

    var main_buf: [4096]u8 = undefined;
    const main_aux_path = std.fmt.bufPrint(&main_buf, "{s}/main.aux", .{dir_path}) catch return error.Unexpected;
    const main_aux_contents = read_file_contents(testing.io, main_aux_path) orelse return error.Unexpected;
    defer free_file_contents(main_aux_contents);

    try testing.expect(aux_is_biblatex(testing.io, main_aux_path, main_aux_contents));
    try testing.expect(!aux_needs_bibtex(testing.io, main_aux_path, main_aux_contents));
}

test "classic bibtex markers win over biblatex markers" {
    const aux_contents = "\\relax\n\\abx@aux@cite{0}{refA}\n\\bibdata{refs}\n\\bibstyle{plain}\n";
    try testing.expect(aux_needs_bibtex(testing.io, "main.aux", aux_contents));
    try testing.expect(!aux_is_biblatex(testing.io, "main.aux", aux_contents));
}

test "aux_needs_bibtex follows input aux files" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "main.aux", .data = "\\relax\n\\@input{chapter.aux}\n" });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "chapter.aux", .data = "\\citation{refA}\n\\bibdata{refs}\n\\bibstyle{plain}\n" });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path = std.mem.sliceTo(dir_path_raw, 0);

    var main_buf: [4096]u8 = undefined;
    const main_aux_path = std.fmt.bufPrint(&main_buf, "{s}/main.aux", .{dir_path}) catch return error.Unexpected;
    const main_aux_contents = read_file_contents(testing.io, main_aux_path) orelse return error.Unexpected;
    defer free_file_contents(main_aux_contents);

    try testing.expect(aux_needs_bibtex(testing.io, main_aux_path, main_aux_contents));
}

test "aux_needs_bibtex ignores missing input aux files" {
    try testing.expect(!aux_needs_bibtex(testing.io, "main.aux", "\\relax\n\\@input{missing.aux}\n"));
}

test "bibliography_state tracks bib inputs and citations" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "main.aux", .data = "\\relax\n\\citation{refA}\n\\bibdata{refs}\n\\bibstyle{plain}\n" });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "refs.bib", .data = "@article{refA,title={One}}\n" });
    try tmp.dir.writeFile(testing.io, .{ .sub_path = "plain.bst", .data = "ENTRY{}{}{}\n" });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path = std.mem.sliceTo(dir_path_raw, 0);

    var main_buf: [4096]u8 = undefined;
    const main_aux_path = std.fmt.bufPrint(&main_buf, "{s}/main.aux", .{dir_path}) catch return error.Unexpected;
    const main_aux_contents = read_file_contents(testing.io, main_aux_path) orelse return error.Unexpected;
    defer free_file_contents(main_aux_contents);

    const first = bibliography_state(testing.io, main_aux_path, main_aux_contents) orelse return error.Unexpected;

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "refs.bib", .data = "@article{refA,title={Two}}\n" });
    const second = bibliography_state(testing.io, main_aux_path, main_aux_contents) orelse return error.Unexpected;
    try testing.expect(!std.mem.eql(u8, first.input_digest[0..], second.input_digest[0..]));

    try tmp.dir.writeFile(testing.io, .{ .sub_path = "main.aux", .data = "\\relax\n\\citation{refB}\n\\bibdata{refs}\n\\bibstyle{plain}\n" });
    const changed_aux_contents = read_file_contents(testing.io, main_aux_path) orelse return error.Unexpected;
    defer free_file_contents(changed_aux_contents);
    const third = bibliography_state(testing.io, main_aux_path, changed_aux_contents) orelse return error.Unexpected;
    try testing.expect(!std.mem.eql(u8, second.citation_digest[0..], third.citation_digest[0..]));
}

test "bibliography_state roundtrip and change helpers" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    const state = BibliographyState{
        .input_digest = "0123456789abcdef0123456789abcdef".*,
        .citation_digest = "fedcba9876543210fedcba9876543210".*,
    };

    try tmp.dir.writeFile(testing.io, .{
        .sub_path = "saved.bibstate",
        .data = "inputs=0123456789abcdef0123456789abcdef\ncitations=fedcba9876543210fedcba9876543210\n",
    });

    var rel_buf: [256]u8 = undefined;
    const tmp_path = std.fmt.bufPrintZ(&rel_buf, ".zig-cache/tmp/{s}", .{&tmp.sub_path}) catch return error.Unexpected;
    var path_buf: [4096]u8 = undefined;
    const dir_path_raw = std.c.realpath(tmp_path, &path_buf) orelse return error.Unexpected;
    const dir_path = std.mem.sliceTo(dir_path_raw, 0);

    var state_buf: [4096]u8 = undefined;
    const state_path = std.fmt.bufPrint(&state_buf, "{s}/saved.bibstate", .{dir_path}) catch return error.Unexpected;
    const loaded = read_bibliography_state(testing.io, state_path) orelse return error.Unexpected;
    try testing.expectEqualStrings(state.input_digest[0..], loaded.input_digest[0..]);
    try testing.expectEqualStrings(state.citation_digest[0..], loaded.citation_digest[0..]);
    try testing.expect(!bib_inputs_changed(state, loaded));
    try testing.expect(!bib_citations_changed(state, loaded));
}
