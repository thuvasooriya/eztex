// Project.zig -- project input resolution (directory, zip, plain file).
//
// Detects whether input is a directory, zip, or plain .tex file.
// For directories/zips: scans for main .tex using MainDetect heuristics.

const Project = @This();
const std = @import("std");
const fs = std.fs;
const Io = std.Io;
const fs_path = std.fs.path;
const Log = @import("Log.zig");
const MainDetect = @import("MainDetect.zig");

pub const ProjectInput = struct {
    // resolved .tex file path to compile
    tex_file: []const u8,
    // directory to chdir into before compiling (for project mode)
    project_dir: ?[]const u8 = null,
    // temp directory to clean up after compile (for zip mode)
    temp_dir: ?[]const u8 = null,
    // original cwd to restore after project mode compile
    original_cwd: ?Io.Dir = null,
};

// detect whether input is a directory, zip file, or plain .tex file.
// for directories: scan for main .tex file using heuristics.
// for zip files: extract to temp dir, then scan for main .tex file.
// returns resolved ProjectInput or null on error.
pub fn resolve_project_input(io: Io, alloc: std.mem.Allocator, input: []const u8, verbose: bool) ?ProjectInput {
    _ = verbose;
    // check if input is a directory
    if (is_directory(io, input)) {
        return resolve_directory_project(io, alloc, input);
    }

    // check if input is a .zip file
    if (std.mem.endsWith(u8, input, ".zip")) {
        return resolve_zip_project(io, alloc, input);
    }

    // plain .tex file (or other) -- pass through as-is
    return ProjectInput{ .tex_file = input };
}

fn is_directory(io: Io, path: []const u8) bool {
    const st = Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return st.kind == .directory;
}

fn resolve_directory_project(io: Io, alloc: std.mem.Allocator, dir_path: []const u8) ?ProjectInput {
    Log.dbg(io, "eztex", "project mode: scanning directory '{s}'", .{dir_path});

    var dir = Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch |err| {
        Log.log(io, "eztex", .err, "cannot open directory '{s}': {}", .{ dir_path, err });
        return null;
    };
    defer dir.close(io);

    var files: std.ArrayList([]const u8) = .empty;
    defer {
        for (files.items) |f| alloc.free(f);
        files.deinit(alloc);
    }

    var iter = dir.iterate();
    while (iter.next(io) catch null) |entry| {
        if (entry.kind != .file and entry.kind != .sym_link) continue;
        const name = alloc.dupe(u8, entry.name) catch continue;
        files.append(alloc, name) catch {
            alloc.free(name);
            continue;
        };
    }

    if (files.items.len == 0) {
        Log.log(io, "eztex", .err, "directory '{s}' contains no files", .{dir_path});
        return null;
    }

    const Ctx = struct {
        io: Io,
        dir: Io.Dir,
        fn read_file(ctx: ?*anyopaque, name: []const u8) ?[]const u8 {
            const self: *@This() = @ptrCast(@alignCast(ctx.?));
            const file = self.dir.openFile(self.io, name, .{}) catch return null;
            defer file.close(self.io);
            var read_buf: [4096]u8 = undefined;
            var reader = Io.File.Reader.init(file, self.io, &read_buf);
            return reader.interface.allocRemaining(std.heap.c_allocator, .limited(4096)) catch null;
        }
    };
    var ctx = Ctx{ .io = io, .dir = dir };

    const main_file = MainDetect.detect(alloc, files.items, &ctx, Ctx.read_file) orelse {
        Log.log(io, "eztex", .err, "no main .tex file found in '{s}'", .{dir_path});
        return null;
    };

    var path_buf: [1024]u8 = undefined;
    const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir_path, main_file }) catch {
        Log.log(io, "eztex", .err, "path too long", .{});
        return null;
    };
    const result_path = alloc.dupe(u8, full_path) catch return null;

    Log.log(io, "eztex", .info, "project mode: detected main file '{s}'", .{main_file});
    return ProjectInput{
        .tex_file = result_path,
        .project_dir = dir_path,
    };
}

fn resolve_zip_project(io: Io, alloc: std.mem.Allocator, zip_path: []const u8) ?ProjectInput {
    Log.dbg(io, "eztex", "project mode: extracting zip '{s}'", .{zip_path});

    const tmp_dir_path = "tmp/zip_extract";
    Io.Dir.cwd().deleteTree(io, tmp_dir_path) catch {};
    Io.Dir.cwd().createDirPath(io, tmp_dir_path) catch |err| {
        Log.log(io, "eztex", .err, "cannot create temp directory: {}", .{err});
        return null;
    };

    const zip_file = Io.Dir.cwd().openFile(io, zip_path, .{}) catch |err| {
        Log.log(io, "eztex", .err, "cannot open zip file '{s}': {}", .{ zip_path, err });
        return null;
    };
    defer zip_file.close(io);

    var dest_dir = Io.Dir.cwd().openDir(io, tmp_dir_path, .{ .iterate = true }) catch |err| {
        Log.log(io, "eztex", .err, "cannot open temp directory: {}", .{err});
        return null;
    };
    defer dest_dir.close(io);

    var read_buf: [64 * 1024]u8 = undefined;
    var file_reader = Io.File.Reader.init(zip_file, io, &read_buf);
    std.zip.extract(dest_dir, &file_reader, .{}) catch |err| {
        Log.log(io, "eztex", .err, "zip extraction failed: {}", .{err});
        return null;
    };

    Log.dbg(io, "eztex", "zip extracted to '{s}'", .{tmp_dir_path});

    var files: std.ArrayList([]const u8) = .empty;
    defer {
        for (files.items) |f| alloc.free(f);
        files.deinit(alloc);
    }

    var dir_iter = dest_dir.iterate();
    while (dir_iter.next(io) catch null) |entry| {
        if (entry.kind != .file and entry.kind != .sym_link) continue;
        const name = alloc.dupe(u8, entry.name) catch continue;
        files.append(alloc, name) catch {
            alloc.free(name);
            continue;
        };
    }

    if (files.items.len == 0) {
        Log.log(io, "eztex", .err, "zip file '{s}' contains no files", .{zip_path});
        return null;
    }

    const main_file = MainDetect.detect(alloc, files.items, null, null) orelse {
        Log.log(io, "eztex", .err, "no main .tex file found in zip '{s}'", .{zip_path});
        return null;
    };

    var path_buf: [1024]u8 = undefined;
    const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ tmp_dir_path, main_file }) catch {
        Log.log(io, "eztex", .err, "path too long", .{});
        return null;
    };
    const result_path = alloc.dupe(u8, full_path) catch return null;

    Log.log(io, "eztex", .info, "project mode: detected main file '{s}' from zip", .{main_file});
    return ProjectInput{
        .tex_file = result_path,
        .project_dir = tmp_dir_path,
        .temp_dir = tmp_dir_path,
    };
}
