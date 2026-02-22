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
    file: ?fs.File = null,
    // memory-backed input (null when file-backed)
    mem_data: ?[]const u8 = null,
    mem_pos: usize = 0,

    name: [512]u8 = .{0} ** 512,
    name_len: usize = 0,
    ungetc_byte: ?u8 = null,

    pub fn set_name(self: *InputSlot, n: []const u8) void {
        const copy_len = @min(n.len, self.name.len);
        @memcpy(self.name[0..copy_len], n[0..copy_len]);
        self.name_len = copy_len;
    }

    pub fn get_name(self: *const InputSlot) []const u8 {
        return self.name[0..self.name_len];
    }

    pub fn read(self: *InputSlot, dest: []u8) !usize {
        if (self.mem_data) |data| {
            if (self.mem_pos >= data.len) return 0;
            const avail = data.len - self.mem_pos;
            const n = @min(dest.len, avail);
            @memcpy(dest[0..n], data[self.mem_pos..][0..n]);
            self.mem_pos += n;
            return n;
        }
        return self.file.?.read(dest);
    }

    pub fn get_size(self: *InputSlot) !usize {
        if (self.mem_data) |data| return data.len;
        const stat = try self.file.?.stat();
        return @intCast(@min(stat.size, std.math.maxInt(usize)));
    }

    pub fn get_pos(self: *InputSlot) !u64 {
        if (self.mem_data != null) return @intCast(self.mem_pos);
        return self.file.?.getPos();
    }

    pub fn seek_to(self: *InputSlot, pos: u64) !void {
        if (self.mem_data) |data| {
            self.mem_pos = @min(@as(usize, @intCast(pos)), data.len);
            return;
        }
        try self.file.?.seekTo(pos);
    }

    pub fn seek_by(self: *InputSlot, offset: i64) !void {
        if (self.mem_data) |data| {
            const cur: i64 = @intCast(self.mem_pos);
            const new = cur + offset;
            self.mem_pos = if (new < 0) 0 else @min(@as(usize, @intCast(new)), data.len);
            return;
        }
        try self.file.?.seekBy(offset);
    }

    pub fn close(self: *InputSlot) void {
        if (self.file) |f| f.close();
        // memory-backed slots don't own the data; caller manages lifetime
        self.* = .{};
    }
};

pub const OutputSlot = struct {
    file: fs.File,
    name: [512]u8 = .{0} ** 512,
    name_len: usize = 0,
    is_stdout: bool = false,
    // When is_gz is true, all writes go into gz_buf; at close time the buffer
    // is gzip-compressed and written to `file` via gzdopen.
    is_gz: bool = false,
    gz_buf: ?*std.ArrayList(u8) = null,

    pub fn set_name(self: *OutputSlot, n: []const u8) void {
        const copy_len = @min(n.len, self.name.len);
        @memcpy(self.name[0..copy_len], n[0..copy_len]);
        self.name_len = copy_len;
    }

    pub fn get_name(self: *const OutputSlot) []const u8 {
        return self.name[0..self.name_len];
    }
};

// -- diagnostics --

pub const DiagnosticHandler = struct {
    on_warning: *const fn ([]const u8) void,
    on_error: *const fn ([]const u8) void,
    on_info: *const fn ([]const u8) void,
};

// -- World struct --

inputs: [MAX_HANDLES]?InputSlot = .{null} ** MAX_HANDLES,
outputs: [MAX_HANDLES]?OutputSlot = .{null} ** MAX_HANDLES,
input_count: usize = 0,
output_count: usize = 0,

search_dirs: [16]?[]const u8 = .{null} ** 16,
search_dir_count: usize = 0,

primary_input: [512]u8 = .{0} ** 512,
primary_input_len: usize = 0,

output_dir: [512]u8 = .{0} ** 512,
output_dir_len: usize = 0,

last_input_abspath: [1024]u8 = .{0} ** 1024,
last_input_abspath_len: usize = 0,

bundle_store: ?*BundleStore = null,

diagnostic_handler: ?*const DiagnosticHandler = null,

// in-memory format data: when set, ttbc_input_open for FORMAT files
// serves from this buffer instead of hitting the filesystem.
format_data: ?[]const u8 = null,
format_name: [64]u8 = .{0} ** 64,
format_name_len: usize = 0,

pub fn add_search_dir(self: *World, dir: []const u8) void {
    if (self.search_dir_count < self.search_dirs.len) {
        self.search_dirs[self.search_dir_count] = dir;
        self.search_dir_count += 1;
    }
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

pub fn reset_io(self: *World) void {
    for (self.inputs[0..self.input_count]) |*slot| {
        if (slot.*) |*s| {
            s.close();
            slot.* = null;
        }
    }
    for (self.outputs[0..self.output_count]) |*slot| {
        if (slot.*) |*s| {
            if (!s.is_stdout) s.file.close();
            slot.* = null;
        }
    }
    self.input_count = 0;
    self.output_count = 0;
}

pub fn alloc_input(self: *World, file: fs.File, name: []const u8) Handle {
    return self.alloc_input_slot(.{ .file = file }, name);
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

pub fn alloc_output(self: *World, file: fs.File, name: []const u8, is_stdout: bool, is_gz: bool) Handle {
    const new_slot = blk: {
        var s = OutputSlot{ .file = file, .is_stdout = is_stdout, .is_gz = is_gz };
        if (is_gz) {
            const buf = std.heap.c_allocator.create(std.ArrayList(u8)) catch return INVALID_HANDLE;
            buf.* = std.ArrayList(u8){};
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
pub fn try_open_input(self: *World, name: []const u8, format: FileFormat) ?fs.File {
    // 1. filesystem + search_dirs (direct path and with extensions)
    if (self.try_open_path(name)) |f| return f;

    const exts = extensions_for_format(format);
    for (exts) |ext| {
        var buf: [1024]u8 = undefined;
        const full = std.fmt.bufPrint(&buf, "{s}.{s}", .{ name, ext }) catch continue;
        if (self.try_open_path(full)) |f| return f;
    }

    // 2. bundle store (unified cache + network fetch)
    if (self.bundle_store) |bs| {
        if (self.try_open_from_bundle_store(bs, name)) |f| return f;
        for (exts) |ext| {
            var buf: [1024]u8 = undefined;
            const full = std.fmt.bufPrint(&buf, "{s}.{s}", .{ name, ext }) catch continue;
            if (self.try_open_from_bundle_store(bs, full)) |f| return f;
        }
    } else {
        Log.dbg("world", "  -> no bundle store available for: '{s}'", .{name});
    }

    return null;
}

fn try_open_from_bundle_store(self: *World, bs: *BundleStore, name: []const u8) ?fs.File {
    const file = bs.open_file(name) catch |err| {
        Log.dbg("world", "  -> bundle store error for '{s}': {}", .{ name, err });
        return null;
    };
    Log.dbg("world", "  -> found via bundle store: '{s}'", .{name});
    self.last_input_abspath_len = 0;
    return file;
}

fn try_open_path(self: *World, name: []const u8) ?fs.File {
    if (open_file_relative(fs.cwd(), name)) |f| {
        self.record_abspath(name);
        return f;
    }

    for (self.search_dirs[0..self.search_dir_count]) |maybe_dir| {
        const dir_path = maybe_dir orelse continue;
        const dir = fs.cwd().openDir(dir_path, .{}) catch continue;
        var dir_handle = dir;
        defer dir_handle.close();
        if (open_file_relative(dir_handle, name)) |f| {
            self.record_abspath_in_dir(dir_path, name);
            return f;
        }
    }

    return null;
}

fn record_abspath(self: *World, name: []const u8) void {
    var cwd_buf: [512]u8 = undefined;
    const cwd = posix.getcwd(&cwd_buf) catch {
        self.last_input_abspath_len = 0;
        return;
    };
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

fn open_file_relative(dir: fs.Dir, name: []const u8) ?fs.File {
    return dir.openFile(name, .{}) catch null;
}

// -- tests --

test "memory input: read sequential" {
    const data = "hello world";
    var slot = InputSlot{ .mem_data = data };
    var buf: [5]u8 = undefined;
    const n1 = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 5), n1);
    try std.testing.expectEqualStrings("hello", buf[0..5]);
    const n2 = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 5), n2);
    try std.testing.expectEqualStrings(" worl", buf[0..5]);
    const n3 = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 1), n3);
    try std.testing.expectEqual(@as(u8, 'd'), buf[0]);
    const n4 = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 0), n4);
}

test "memory input: seek and get_pos" {
    const data = "abcdefghij";
    var slot = InputSlot{ .mem_data = data };
    try std.testing.expectEqual(@as(u64, 0), try slot.get_pos());

    try slot.seek_to(5);
    try std.testing.expectEqual(@as(u64, 5), try slot.get_pos());

    var buf: [3]u8 = undefined;
    const n = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 3), n);
    try std.testing.expectEqualStrings("fgh", buf[0..3]);
    try std.testing.expectEqual(@as(u64, 8), try slot.get_pos());

    try slot.seek_by(-4);
    try std.testing.expectEqual(@as(u64, 4), try slot.get_pos());

    const n2 = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 3), n2);
    try std.testing.expectEqualStrings("efg", buf[0..3]);
}

test "memory input: seek past end clamps" {
    const data = "abc";
    var slot = InputSlot{ .mem_data = data };
    try slot.seek_to(100);
    try std.testing.expectEqual(@as(u64, 3), try slot.get_pos());
    var buf: [1]u8 = undefined;
    const n = try slot.read(&buf);
    try std.testing.expectEqual(@as(usize, 0), n);
}

test "memory input: seek_by negative clamps to zero" {
    const data = "abc";
    var slot = InputSlot{ .mem_data = data };
    try slot.seek_to(1);
    try slot.seek_by(-10);
    try std.testing.expectEqual(@as(u64, 0), try slot.get_pos());
}

test "memory input: get_size" {
    const data = "twelve chars";
    var slot = InputSlot{ .mem_data = data };
    try std.testing.expectEqual(@as(usize, 12), try slot.get_size());
}

test "memory input: ungetc integration" {
    const data = "ab";
    var slot = InputSlot{ .mem_data = data };
    var buf: [1]u8 = undefined;
    _ = try slot.read(&buf);
    try std.testing.expectEqual(@as(u8, 'a'), buf[0]);
    slot.ungetc_byte = 'Z';
    // ungetc is handled by bridge layer, not by slot.read directly
    // but verify the field exists and works
    try std.testing.expectEqual(@as(?u8, 'Z'), slot.ungetc_byte);
}

test "world: alloc_memory_input and get_input" {
    var world = World{};
    const data = "format bytes here";
    const h = world.alloc_memory_input(data, "test.fmt");
    try std.testing.expect(h != INVALID_HANDLE);
    const slot = world.get_input(h).?;
    try std.testing.expectEqualStrings("test.fmt", slot.get_name());
    try std.testing.expectEqual(@as(usize, 17), try slot.get_size());
    var buf: [6]u8 = undefined;
    const n = try slot.read(&buf);
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
