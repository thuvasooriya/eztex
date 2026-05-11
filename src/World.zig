// World.zig -- core I/O abstraction for the TeX engine.
//
// The World struct manages input/output file handles, search directories,
// and bundle-based file resolution. It is platform-agnostic; platform-specific
// behavior (native vs WASM) is handled by BundleStore's comptime branching.
//
// Handle scheme: 0 = INVALID_HANDLE (not found / error).
// Nonzero uintptr_t = index+1 into the handle table.

const std = @import("std");
const fs = std.fs;
const Io = std.Io;
const posix = std.posix;
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const is_wasm = Host.is_wasm;
const BundleStore = @import("BundleStore.zig");

const World = @This();

// -- public types --

pub const Handle = usize;
pub const FileFormat = c_int;
pub const INVALID_HANDLE: Handle = 0;

// file format constants from bridge core header
pub const TTBC_FILE_FORMAT_AFM: c_int = 4;
pub const TTBC_FILE_FORMAT_BIB: c_int = 6;
pub const TTBC_FILE_FORMAT_BST: c_int = 7;
pub const TTBC_FILE_FORMAT_CMAP: c_int = 45;
pub const TTBC_FILE_FORMAT_CNF: c_int = 8;
pub const TTBC_FILE_FORMAT_ENC: c_int = 44;
pub const TTBC_FILE_FORMAT_FORMAT: c_int = 10;
pub const TTBC_FILE_FORMAT_FONT_MAP: c_int = 11;
pub const TTBC_FILE_FORMAT_MISC_FONTS: c_int = 41;
pub const TTBC_FILE_FORMAT_OFM: c_int = 20;
pub const TTBC_FILE_FORMAT_OPEN_TYPE: c_int = 47;
pub const TTBC_FILE_FORMAT_OVF: c_int = 23;
pub const TTBC_FILE_FORMAT_PICT: c_int = 25;
pub const TTBC_FILE_FORMAT_PK: c_int = 1;
pub const TTBC_FILE_FORMAT_PROGRAM_DATA: c_int = 39;
pub const TTBC_FILE_FORMAT_SFD: c_int = 46;
pub const TTBC_FILE_FORMAT_TECTONIC_PRIMARY: c_int = 59;
pub const TTBC_FILE_FORMAT_TEX: c_int = 26;
pub const TTBC_FILE_FORMAT_TEX_PS_HEADER: c_int = 30;
pub const TTBC_FILE_FORMAT_TFM: c_int = 3;
pub const TTBC_FILE_FORMAT_TRUE_TYPE: c_int = 36;
pub const TTBC_FILE_FORMAT_TYPE1: c_int = 32;
pub const TTBC_FILE_FORMAT_VF: c_int = 33;

pub const SEEK_SET: c_int = 0;
pub const SEEK_CUR: c_int = 1;
pub const SEEK_END: c_int = 2;

const MAX_HANDLES: usize = 256;

// -- slot types --

pub const InputSlot = struct {
    // file-backed input (null when memory-backed)
    file: ?Io.File = null,
    // memory-backed input (null when file-backed)
    mem_data: ?[]const u8 = null,
    mem_pos: usize = 0,
    // true if this slot owns mem_data (lazily loaded from file)
    owns_mem: bool = false,
    name: [512]u8 = @splat(0),
    name_len: usize = 0,
    ungetc_byte: ?u8 = null,
    // mtime in seconds since epoch (0 for memory/bundle inputs without real filesystem backing)
    mtime_sec: i64 = 0,

    pub fn set_name(self: *InputSlot, n: []const u8) void {
        const copy_len = @min(n.len, self.name.len);
        @memcpy(self.name[0..copy_len], n[0..copy_len]);
        self.name_len = copy_len;
    }

    pub fn get_name(self: *const InputSlot) []const u8 {
        return self.name[0..self.name_len];
    }

    // Helper: ensure file-backed input is loaded into memory for seeking
    fn ensure_mem_loaded(self: *InputSlot, io: Io) !void {
        if (self.mem_data != null) return; // already memory-backed
        const f = self.file orelse return; // no file to load

        const stat = f.stat(io) catch return error.ReadError;
        const size: usize = @intCast(@min(stat.size, std.math.maxInt(usize)));
        // TODO: add a configurable maximum file size for file-backed inputs
        if (size == 0) {
            f.close(io);
            self.file = null;
            return;
        }
        const data = std.heap.c_allocator.alloc(u8, size) catch return error.OutOfMemory;
        const bytes_read = f.readPositionalAll(io, data, 0) catch |err| {
            std.heap.c_allocator.free(data);
            return err;
        };
        f.close(io);
        self.file = null;
        self.mem_data = data[0..bytes_read];
        self.mem_pos = 0;
        self.owns_mem = true;
    }

    pub fn read(self: *InputSlot, io: Io, dest: []u8) !usize {
        if (self.mem_data) |data| {
            if (self.mem_pos >= data.len) return 0;
            const avail = data.len - self.mem_pos;
            const n = @min(dest.len, avail);
            @memcpy(dest[0..n], data[self.mem_pos..][0..n]);
            self.mem_pos += n;
            return n;
        }
        // Lazy-load file into memory on first read, then use mem_data path
        if (self.file) |f| {
            const stat = f.stat(io) catch return 0;
            const size: usize = @intCast(@min(stat.size, std.math.maxInt(usize)));
            // TODO: add a configurable maximum file size for file-backed inputs
            if (size == 0) {
                f.close(io);
                self.file = null;
                return 0;
            }
            const data = std.heap.c_allocator.alloc(u8, size) catch return error.OutOfMemory;
            const bytes_read = f.readPositionalAll(io, data, 0) catch |err| {
                std.heap.c_allocator.free(data);
                return err;
            };
            f.close(io);
            self.file = null;
            self.mem_data = data[0..bytes_read];
            self.mem_pos = 0;
            self.owns_mem = true;
            // Recurse into mem_data path
            return self.read(io, dest);
        }
        return 0;
    }

    pub fn get_size(self: *InputSlot, io: Io) !usize {
        if (self.mem_data) |data| return data.len;
        const stat = try self.file.?.stat(io);
        return @intCast(@min(stat.size, std.math.maxInt(usize)));
    }

    pub fn get_pos(self: *InputSlot, io: Io) !u64 {
        if (self.mem_data != null) return @intCast(self.mem_pos);
        // Lazy-load file into memory so we can track position
        try self.ensure_mem_loaded(io);
        return @intCast(self.mem_pos);
    }

    pub fn seek_to(self: *InputSlot, io: Io, pos: u64) !void {
        if (self.mem_data) |data| {
            self.mem_pos = @min(@as(usize, @intCast(pos)), data.len);
            return;
        }
        // Lazy-load file into memory so we can seek
        try self.ensure_mem_loaded(io);
        if (self.mem_data) |data| {
            self.mem_pos = @min(@as(usize, @intCast(pos)), data.len);
        }
    }

    pub fn seek_by(self: *InputSlot, io: Io, offset: i64) !void {
        if (self.mem_data) |data| {
            const cur: i64 = @intCast(self.mem_pos);
            const new = cur + offset;
            self.mem_pos = if (new < 0) 0 else @min(@as(usize, @intCast(new)), data.len);
            return;
        }
        // Lazy-load file into memory so we can seek
        try self.ensure_mem_loaded(io);
        if (self.mem_data) |data| {
            const cur: i64 = @intCast(self.mem_pos);
            const new = cur + offset;
            self.mem_pos = if (new < 0) 0 else @min(@as(usize, @intCast(new)), data.len);
        }
    }

    pub fn close(self: *InputSlot, io: Io) void {
        if (self.file) |f| f.close(io);
        // Only free if we own the memory (lazily loaded from file)
        if (self.owns_mem) {
            if (self.mem_data) |data| {
                std.heap.c_allocator.free(data);
            }
        }
        self.* = .{};
    }
};

pub const OutputSlot = struct {
    file: Io.File,
    name: [512]u8 = @splat(0),
    name_len: usize = 0,
    is_stdout: bool = false,
    // When is_gz is true, all writes go into gz_buf; at close time the buffer
    // is gzip-compressed and written to `file` via gzdopen.
    is_gz: bool = false,
    gz_buf: ?*std.ArrayList(u8) = null,
    // Write buffer for non-gz outputs. Accumulates data between flushes.
    write_buf: [4096]u8 = undefined,
    write_len: usize = 0,

    pub fn set_name(self: *OutputSlot, n: []const u8) void {
        const copy_len = @min(n.len, self.name.len);
        @memcpy(self.name[0..copy_len], n[0..copy_len]);
        self.name_len = copy_len;
    }

    pub fn get_name(self: *const OutputSlot) []const u8 {
        return self.name[0..self.name_len];
    }

    // Append data to the write buffer. Flushes automatically when buffer is full.
    // For stdout, also flushes on newline to provide progressive output.
    pub fn write(self: *OutputSlot, io: Io, data: []const u8) Io.File.Writer.Error!void {
        if (self.is_gz) {
            const buf = self.gz_buf orelse return error.Unexpected;
            buf.appendSlice(std.heap.c_allocator, data) catch return error.SystemResources;
            return;
        }

        var src_idx: usize = 0;
        while (src_idx < data.len) {
            const avail = self.write_buf.len - self.write_len;
            if (avail == 0) {
                try self.flush(io);
                continue;
            }
            const copy_len = @min(avail, data.len - src_idx);
            @memcpy(self.write_buf[self.write_len..][0..copy_len], data[src_idx..][0..copy_len]);
            self.write_len += copy_len;
            src_idx += copy_len;

            if (self.is_stdout) {
                const written = self.write_buf[self.write_len - copy_len .. self.write_len];
                if (std.mem.indexOfScalar(u8, written, '\n') != null) {
                    try self.flush(io);
                }
            }
        }
    }

    pub fn writeByte(self: *OutputSlot, io: Io, byte: u8) Io.File.Writer.Error!void {
        if (self.is_gz) {
            const buf = self.gz_buf orelse return error.Unexpected;
            buf.append(std.heap.c_allocator, byte) catch return error.SystemResources;
            return;
        }

        if (self.write_len >= self.write_buf.len) {
            try self.flush(io);
        }
        self.write_buf[self.write_len] = byte;
        self.write_len += 1;

        if (self.is_stdout and byte == '\n') {
            try self.flush(io);
        }
    }

    pub fn flush(self: *OutputSlot, io: Io) Io.File.Writer.Error!void {
        if (self.is_gz) return;
        if (self.write_len == 0) return;
        try self.file.writeStreamingAll(io, self.write_buf[0..self.write_len]);
        self.write_len = 0;
    }

    pub fn close(self: *OutputSlot, io: Io) void {
        if (self.is_gz) {
            if (self.gz_buf) |buf| {
                buf.deinit(std.heap.c_allocator);
                std.heap.c_allocator.destroy(buf);
                self.gz_buf = null;
            }
        } else {
            self.flush(io) catch {};
        }
        if (!self.is_stdout) {
            self.file.close(io);
        }
    }
};

// -- diagnostics --

pub const DiagnosticHandler = struct {
    on_warning: *const fn (Io, []const u8) void,
    on_error: *const fn (Io, []const u8) void,
    on_info: *const fn (Io, []const u8) void,
};

// -- World struct --

inputs: [MAX_HANDLES]?InputSlot = @splat(null),
outputs: [MAX_HANDLES]?OutputSlot = @splat(null),
input_count: usize = 0,
output_count: usize = 0,

search_dirs: [16]?[]const u8 = @splat(null),
search_dir_count: usize = 0,

primary_input: [512]u8 = @splat(0),
primary_input_len: usize = 0,

output_dir: [512]u8 = @splat(0),
output_dir_len: usize = 0,

last_input_abspath: [1024]u8 = @splat(0),
last_input_abspath_len: usize = 0,

bundle_store: ?*BundleStore = null,

diagnostic_handler: ?*const DiagnosticHandler = null,

// when set, ttbc_input_get_mtime returns this fixed value instead of real file mtimes.
// used for reproducible/deterministic builds.
deterministic_mtime: ?i64 = null,

// in-memory format data: when set, ttbc_input_open for FORMAT files
// serves from this buffer instead of hitting the filesystem.
format_data: ?[]const u8 = null,
format_name: [64]u8 = @splat(0),
format_name_len: usize = 0,

pub fn add_search_dir(self: *World, dir: []const u8) void {
    if (self.search_dir_count < self.search_dirs.len) {
        self.search_dirs[self.search_dir_count] = dir;
        self.search_dir_count += 1;
    }
}

pub fn reset_search_dirs(self: *World) void {
    self.search_dirs = @splat(null);
    self.search_dir_count = 0;
}

pub fn set_primary_input(self: *World, path: []const u8) void {
    const copy_len = @min(path.len, self.primary_input.len);
    @memcpy(self.primary_input[0..copy_len], path[0..copy_len]);
    self.primary_input_len = copy_len;
}

pub fn set_output_dir(self: *World, dir: []const u8) void {
    const copy_len = @min(dir.len, self.output_dir.len);
    @memcpy(self.output_dir[0..copy_len], dir[0..copy_len]);
    self.output_dir_len = copy_len;
}

// set in-memory format data to be served when engine opens a FORMAT file.
// caller owns the data lifetime (must outlive the engine run).
pub fn set_format_data(self: *World, data: []const u8, name: []const u8) void {
    self.format_data = data;
    const copy_len = @min(name.len, self.format_name.len);
    @memcpy(self.format_name[0..copy_len], name[0..copy_len]);
    self.format_name_len = copy_len;
}

pub fn clear_format_data(self: *World) void {
    self.format_data = null;
    self.format_name_len = 0;
}

pub fn reset_io(self: *World, io: Io) void {
    for (self.inputs[0..self.input_count]) |*slot| {
        if (slot.*) |*s| {
            s.close(io);
            slot.* = null;
        }
    }
    for (self.outputs[0..self.output_count]) |*slot| {
        if (slot.*) |*s| {
            s.close(io);
            slot.* = null;
        }
    }
    self.input_count = 0;
    self.output_count = 0;
    self.reset_search_dirs();
}

pub fn alloc_input(self: *World, io: Io, file: Io.File, name: []const u8) Handle {
    var slot = InputSlot{ .file = file };
    // capture mtime from file stat if available
    if (file.stat(io)) |stat| {
        slot.mtime_sec = @intCast(@divTrunc(stat.mtime.nanoseconds, 1_000_000_000));
    } else |_| {
        slot.mtime_sec = 0;
    }
    return self.alloc_input_slot(slot, name);
}

pub fn alloc_memory_input(self: *World, data: []const u8, name: []const u8) Handle {
    return self.alloc_input_slot(.{ .mem_data = data }, name);
}

fn alloc_input_slot(self: *World, slot_init: InputSlot, name: []const u8) Handle {
    for (self.inputs[0..self.input_count], 0..) |*slot, idx| {
        if (slot.* == null) {
            slot.* = slot_init;
            slot.*.?.set_name(name);
            return idx + 1;
        }
    }
    if (self.input_count >= MAX_HANDLES) return INVALID_HANDLE;
    const idx = self.input_count;
    self.inputs[idx] = slot_init;
    self.inputs[idx].?.set_name(name);
    self.input_count += 1;
    return idx + 1;
}

pub fn get_input(self: *World, handle: Handle) ?*InputSlot {
    if (handle == INVALID_HANDLE) return null;
    const idx = handle - 1;
    if (idx >= self.input_count) return null;
    return if (self.inputs[idx] != null) &(self.inputs[idx].?) else null;
}

pub fn alloc_output(self: *World, file: Io.File, name: []const u8, is_stdout: bool, is_gz: bool) Handle {
    const new_slot = blk: {
        var s = OutputSlot{ .file = file, .is_stdout = is_stdout, .is_gz = is_gz };
        if (is_gz) {
            const buf = std.heap.c_allocator.create(std.ArrayList(u8)) catch return INVALID_HANDLE;
            buf.* = .empty;
            s.gz_buf = buf;
        }
        break :blk s;
    };
    for (self.outputs[0..self.output_count], 0..) |*slot, idx| {
        if (slot.* == null) {
            slot.* = new_slot;
            slot.*.?.set_name(name);
            return idx + 1;
        }
    }
    if (self.output_count >= MAX_HANDLES) return INVALID_HANDLE;
    const idx = self.output_count;
    self.outputs[idx] = new_slot;
    self.outputs[idx].?.set_name(name);
    self.output_count += 1;
    return idx + 1;
}

pub fn get_output(self: *World, handle: Handle) ?*OutputSlot {
    if (handle == INVALID_HANDLE) return null;
    const idx = handle - 1;
    if (idx >= self.output_count) return null;
    return if (self.outputs[idx] != null) &(self.outputs[idx].?) else null;
}

// extensions to try for a given file format
pub fn extensions_for_format(format: FileFormat) []const []const u8 {
    return switch (format) {
        TTBC_FILE_FORMAT_AFM => &.{"afm"},
        TTBC_FILE_FORMAT_BIB => &.{"bib"},
        TTBC_FILE_FORMAT_BST => &.{"bst"},
        TTBC_FILE_FORMAT_CNF => &.{"cnf"},
        TTBC_FILE_FORMAT_ENC => &.{"enc"},
        TTBC_FILE_FORMAT_FORMAT => &.{"fmt"},
        TTBC_FILE_FORMAT_FONT_MAP => &.{"map"},
        TTBC_FILE_FORMAT_OFM => &.{"ofm"},
        TTBC_FILE_FORMAT_OPEN_TYPE => &.{ "otf", "OTF" },
        TTBC_FILE_FORMAT_OVF => &.{ "ovf", "vf" },
        TTBC_FILE_FORMAT_PICT => &.{ "pdf", "jpg", "eps", "epsi" },
        TTBC_FILE_FORMAT_PK => &.{"pk"},
        TTBC_FILE_FORMAT_SFD => &.{"sfd"},
        TTBC_FILE_FORMAT_TEX => &.{ "tex", "sty", "cls", "fd", "aux", "bbl", "def", "clo", "ldf" },
        TTBC_FILE_FORMAT_TEX_PS_HEADER => &.{"pro"},
        TTBC_FILE_FORMAT_TFM => &.{"tfm"},
        TTBC_FILE_FORMAT_TRUE_TYPE => &.{ "ttf", "ttc", "TTF", "TTC", "dfont" },
        TTBC_FILE_FORMAT_TYPE1 => &.{ "pfa", "pfb" },
        TTBC_FILE_FORMAT_VF => &.{"vf"},
        else => &.{},
    };
}

// try to open a file by name, searching directories, extensions, and package manager
pub fn try_open_input(self: *World, io: Io, name: []const u8, format: FileFormat) ?Io.File {
    // 1. filesystem + search_dirs (direct path and with extensions)
    if (self.try_open_path(io, name)) |f| return f;

    const exts = extensions_for_format(format);
    for (exts) |ext| {
        var buf: [1024]u8 = undefined;
        const full = std.fmt.bufPrint(&buf, "{s}.{s}", .{ name, ext }) catch continue;
        if (self.try_open_path(io, full)) |f| return f;
    }

    // 2. bundle store (unified cache + network fetch)
    if (self.bundle_store) |bs| {
        if (self.try_open_from_bundle_store(io, bs, name)) |f| return f;
        for (exts) |ext| {
            var buf: [1024]u8 = undefined;
            const full = std.fmt.bufPrint(&buf, "{s}.{s}", .{ name, ext }) catch continue;
            if (self.try_open_from_bundle_store(io, bs, full)) |f| return f;
        }
    } else {
        Log.dbg(io, "world", "  -> no bundle store available for: '{s}'", .{name});
    }

    return null;
}

fn try_open_from_bundle_store(self: *World, io: Io, bs: *BundleStore, name: []const u8) ?Io.File {
    const file = bs.open_file(io, name) catch |err| {
        Log.dbg(io, "world", "  -> bundle store error for '{s}': {}", .{ name, err });
        return null;
    };
    Log.dbg(io, "world", "  -> found via bundle store: '{s}'", .{name});
    self.last_input_abspath_len = 0;
    return file;
}

fn try_open_path(self: *World, io: Io, name: []const u8) ?Io.File {
    if (open_file_relative(io, Io.Dir.cwd(), name)) |f| {
        self.record_abspath(io, name);
        return f;
    }

    // jobname prefix fallback: if primary input is "foo.tex" and name is "foo/bar.jpg",
    // try opening "bar.jpg" from cwd. this handles projects where the LaTeX source
    // references files with the project folder name as a prefix (common in native CLI
    // projects where the project lives inside a named directory).
    if (self.primary_input_len > 0) {
        const primary = self.primary_input[0..self.primary_input_len];
        const basename_start = if (std.mem.lastIndexOfScalar(u8, primary, '/')) |slash| slash + 1 else 0;
        const basename = primary[basename_start..];
        const dot_idx = std.mem.lastIndexOfScalar(u8, basename, '.') orelse basename.len;
        const jobname = basename[0..dot_idx];

        if (jobname.len > 0 and name.len > jobname.len + 1) {
            var prefix_buf: [512]u8 = undefined;
            const prefix = std.fmt.bufPrint(&prefix_buf, "{s}/", .{jobname}) catch null;
            if (prefix) |p| {
                if (std.mem.startsWith(u8, name, p)) {
                    const stripped = name[p.len..];
                    if (open_file_relative(io, Io.Dir.cwd(), stripped)) |f| {
                        Log.dbg(io, "world", "  -> jobname fallback: '{s}' -> '{s}'", .{ name, stripped });
                        self.record_abspath(io, stripped);
                        return f;
                    }
                }
            }
        }
    }

    for (self.search_dirs[0..self.search_dir_count]) |maybe_dir| {
        const dir_path = maybe_dir orelse continue;
        const dir = Io.Dir.cwd().openDir(io, dir_path, .{}) catch continue;
        var dir_handle = dir;
        defer dir_handle.close(io);
        if (open_file_relative(io, dir_handle, name)) |f| {
            self.record_abspath_in_dir(dir_path, name);
            return f;
        }
    }

    return null;
}

fn record_abspath(self: *World, io: Io, name: []const u8) void {
    var cwd_buf: [512]u8 = undefined;
    const cwd_len = Io.Dir.cwd().realPath(io, &cwd_buf) catch {
        self.last_input_abspath_len = 0;
        return;
    };
    const cwd = cwd_buf[0..cwd_len];
    const result = std.fmt.bufPrint(&self.last_input_abspath, "{s}/{s}", .{ cwd, name }) catch {
        self.last_input_abspath_len = 0;
        return;
    };
    self.last_input_abspath_len = result.len;
}

fn record_abspath_in_dir(self: *World, dir: []const u8, name: []const u8) void {
    const result = std.fmt.bufPrint(&self.last_input_abspath, "{s}/{s}", .{ dir, name }) catch {
        self.last_input_abspath_len = 0;
        return;
    };
    self.last_input_abspath_len = result.len;
}

fn open_file_relative(io: Io, dir: Io.Dir, name: []const u8) ?Io.File {
    return dir.openFile(io, name, .{}) catch null;
}

// -- tests --

test "memory input: read sequential" {
    const io = std.testing.io;
    const data = "hello world";
    var slot = InputSlot{ .mem_data = data };
    var buf: [5]u8 = undefined;
    const n1 = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 5), n1);
    try std.testing.expectEqualStrings("hello", buf[0..5]);
    const n2 = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 5), n2);
    try std.testing.expectEqualStrings(" worl", buf[0..5]);
    const n3 = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 1), n3);
    try std.testing.expectEqual(@as(u8, 'd'), buf[0]);
    const n4 = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 0), n4);
}

test "memory input: seek and get_pos" {
    const io = std.testing.io;
    const data = "abcdefghij";
    var slot = InputSlot{ .mem_data = data };
    try std.testing.expectEqual(@as(u64, 0), try slot.get_pos(io));

    try slot.seek_to(io, 5);
    try std.testing.expectEqual(@as(u64, 5), try slot.get_pos(io));

    var buf: [3]u8 = undefined;
    const n = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 3), n);
    try std.testing.expectEqualStrings("fgh", buf[0..3]);
    try std.testing.expectEqual(@as(u64, 8), try slot.get_pos(io));

    try slot.seek_by(io, -4);
    try std.testing.expectEqual(@as(u64, 4), try slot.get_pos(io));

    const n2 = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 3), n2);
    try std.testing.expectEqualStrings("efg", buf[0..3]);
}

test "memory input: seek past end clamps" {
    const io = std.testing.io;
    const data = "abc";
    var slot = InputSlot{ .mem_data = data };
    try slot.seek_to(io, 100);
    try std.testing.expectEqual(@as(u64, 3), try slot.get_pos(io));
    var buf: [1]u8 = undefined;
    const n = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 0), n);
}

test "memory input: seek_by negative clamps to zero" {
    const io = std.testing.io;
    const data = "abc";
    var slot = InputSlot{ .mem_data = data };
    try slot.seek_to(io, 1);
    try slot.seek_by(io, -10);
    try std.testing.expectEqual(@as(u64, 0), try slot.get_pos(io));
}

test "memory input: get_size" {
    const io = std.testing.io;
    const data = "twelve chars";
    var slot = InputSlot{ .mem_data = data };
    try std.testing.expectEqual(@as(usize, 12), try slot.get_size(io));
}

test "memory input: ungetc integration" {
    const io = std.testing.io;
    const data = "ab";
    var slot = InputSlot{ .mem_data = data };
    var buf: [1]u8 = undefined;
    _ = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(u8, 'a'), buf[0]);
    slot.ungetc_byte = 'Z';
    // ungetc is handled by bridge layer, not by slot.read directly
    // but verify the field exists and works
    try std.testing.expectEqual(@as(?u8, 'Z'), slot.ungetc_byte);
}

test "world: alloc_memory_input and get_input" {
    const io = std.testing.io;
    var world = World{};
    const data = "format bytes here";
    const h = world.alloc_memory_input(data, "test.fmt");
    try std.testing.expect(h != INVALID_HANDLE);
    const slot = world.get_input(h).?;
    try std.testing.expectEqualStrings("test.fmt", slot.get_name());
    try std.testing.expectEqual(@as(usize, 17), try slot.get_size(io));
    var buf: [6]u8 = undefined;
    const n = try slot.read(io, &buf);
    try std.testing.expectEqual(@as(usize, 6), n);
    try std.testing.expectEqualStrings("format", buf[0..6]);
}

test "world: set_format_data and clear_format_data" {
    var world = World{};
    const data = "fake format";
    world.set_format_data(data, "xelatex.fmt");
    try std.testing.expectEqualStrings("fake format", world.format_data.?);
    try std.testing.expectEqualStrings("xelatex.fmt", world.format_name[0..world.format_name_len]);
    world.clear_format_data();
    try std.testing.expectEqual(@as(?[]const u8, null), world.format_data);
    try std.testing.expectEqual(@as(usize, 0), world.format_name_len);
}
