// Engine.zig -- C export layer, global state, and re-exports.
//
// Contains:
//   - Global World / BundleStore / diagnostic state
//   - All ttbc_* C ABI exports called by support.c
//   - Re-exports of World.zig and BundleStore.zig for internal callers

const std = @import("std");
const fs = std.fs;
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const Config = @import("Config.zig");
const is_wasm = Host.is_wasm;
pub const World = @import("World.zig");
pub const BundleStore = @import("BundleStore.zig");

const Handle = World.Handle;
const FileFormat = World.FileFormat;
const INVALID_HANDLE = World.INVALID_HANDLE;

// ====================================================================
// Diagnostic type
// ====================================================================

const Diagnostic = struct {
    buf: [4096]u8 = .{0} ** 4096,
    len: usize = 0,
    is_error: bool = false,

    fn append(self: *Diagnostic, text: [*:0]const u8) void {
        const s = std.mem.span(text);
        const avail = self.buf.len - self.len;
        const copy_len = @min(s.len, avail);
        @memcpy(self.buf[self.len..][0..copy_len], s[0..copy_len]);
        self.len += copy_len;
    }

    fn slice(self: *const Diagnostic) []const u8 {
        return self.buf[0..self.len];
    }
};

// ====================================================================
// Global state
// file-scope globals required: C ABI callbacks have no user-data parameter
// ====================================================================

var global_world: World = .{};
var global_bundle_store: ?BundleStore = null;
var global_diag_handler: ?World.DiagnosticHandler = null;

pub fn get_world() *World {
    return &global_world;
}

pub fn set_bundle_store(bs: BundleStore) void {
    global_bundle_store = bs;
}

pub fn get_bundle_store() *BundleStore {
    return &(global_bundle_store.?);
}

// lazily create a default BundleStore if none exists yet.
// used by wasm_exports for the api_instance which never calls _start/main.
pub fn ensure_bundle_store() *BundleStore {
    if (global_bundle_store == null) {
        global_bundle_store = BundleStore.init(
            std.heap.c_allocator,
            Config.default_bundle_url,
            &Config.default_bundle_digest,
        );
    }
    return &(global_bundle_store.?);
}

pub fn deinit_bundle_store() void {
    if (global_bundle_store) |*bs| bs.deinit();
    global_bundle_store = null;
}

// ====================================================================
// Diagnostic handler
// ====================================================================

pub fn set_diagnostic_handler(handler: World.DiagnosticHandler) void {
    global_diag_handler = handler;
}

fn emit_warning(text: []const u8) void {
    if (global_diag_handler) |h| {
        h.on_warning(text);
    } else {
        Log.log_stderr("", "warning: {s}", .{text});
    }
}

fn emit_error(text: []const u8) void {
    if (global_diag_handler) |h| {
        h.on_error(text);
    } else {
        Log.log_stderr("", "error: {s}", .{text});
    }
}

fn emit_info(text: []const u8) void {
    if (global_diag_handler) |h| {
        h.on_info(text);
    } else {
        Log.log_stderr("", "{s}", .{text});
    }
}

// ====================================================================
// Diagnostic handler
// ====================================================================

var bridge_verbose: bool = false;

pub fn set_verbose(v: bool) void {
    bridge_verbose = v;
    World.set_verbose(v);
}

fn stderr_writer(buf: []u8) fs.File.Writer {
    return Log.stderr_writer(buf);
}

fn log_bridge_always(comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var writer = stderr_writer(&buf);
    const w = &writer.interface;
    w.print(fmt ++ "\n", args) catch {};
    w.flush() catch {};
}

pub fn log_bundle(comptime fmt: []const u8, args: anytype) void {
    if (!bridge_verbose) return;
    var buf: [4096]u8 = undefined;
    var writer = stderr_writer(&buf);
    const w = &writer.interface;
    w.print("[bundle] " ++ fmt ++ "\n", args) catch {};
    w.flush() catch {};
}

fn log_bridge(comptime fmt: []const u8, args: anytype) void {
    if (!bridge_verbose) return;
    var buf: [4096]u8 = undefined;
    var writer = stderr_writer(&buf);
    const w = &writer.interface;
    w.print("[bridge] " ++ fmt ++ "\n", args) catch {};
    w.flush() catch {};
}

// ====================================================================
// Exported C functions -- diagnostics
// ====================================================================

export fn ttbc_issue_warning(text: [*:0]const u8) void {
    emit_warning(std.mem.span(text));
}

export fn ttbc_issue_error(text: [*:0]const u8) void {
    emit_error(std.mem.span(text));
}

export fn ttbc_diag_begin_warning() ?*Diagnostic {
    const alloc = std.heap.c_allocator;
    const d = alloc.create(Diagnostic) catch return null;
    d.* = .{ .is_error = false };
    return d;
}

export fn ttbc_diag_begin_error() ?*Diagnostic {
    const alloc = std.heap.c_allocator;
    const d = alloc.create(Diagnostic) catch return null;
    d.* = .{ .is_error = true };
    return d;
}

export fn ttbc_diag_append(diag: ?*Diagnostic, text: [*:0]const u8) void {
    if (diag) |d| d.append(text);
}

export fn ttbc_diag_finish(diag: ?*Diagnostic) void {
    if (diag) |d| {
        if (global_diag_handler != null and d.len > 0) {
            if (d.is_error) {
                emit_error(d.slice());
            } else {
                emit_warning(d.slice());
            }
        }
        std.heap.c_allocator.destroy(d);
    }
}

// ====================================================================
// Exported C functions -- MD5
// ====================================================================

const Md5 = std.crypto.hash.Md5;

export fn ttbc_get_file_md5(path: [*:0]const u8, digest: [*]u8) c_int {
    const path_slice = std.mem.span(path);
    const world = get_world();

    const file = world.try_open_input(path_slice, World.TTBC_FILE_FORMAT_TEX) orelse {
        @memset(digest[0..16], 0);
        return 1;
    };
    defer file.close();

    const content = file.readToEndAlloc(std.heap.c_allocator, 16 * 1024 * 1024) catch {
        @memset(digest[0..16], 0);
        return 1;
    };
    defer std.heap.c_allocator.free(content);

    Md5.hash(content, digest[0..16], .{});
    return 0;
}

export fn ttbc_get_data_md5(data: [*]const u8, len: usize, digest: [*]u8) c_int {
    Md5.hash(data[0..len], digest[0..16], .{});
    return 0;
}

// ====================================================================
// Exported C functions -- output
// ====================================================================

export fn ttbc_output_open(name: [*:0]const u8, is_gz: c_int) Handle {
    const name_slice = std.mem.span(name);
    Log.dbg("bridge", "output_open('{s}', is_gz={d})", .{ name_slice, is_gz });

    const world = get_world();
    const file = blk: {
        if (world.output_dir_len > 0) {
            const out_dir = world.output_dir[0..world.output_dir_len];
            const dir = fs.cwd().openDir(out_dir, .{}) catch {
                break :blk fs.cwd().createFile(name_slice, .{}) catch return INVALID_HANDLE;
            };
            var d = dir;
            defer d.close();
            break :blk d.createFile(name_slice, .{}) catch return INVALID_HANDLE;
        } else {
            break :blk fs.cwd().createFile(name_slice, .{}) catch return INVALID_HANDLE;
        }
    };

    return world.alloc_output(file, name_slice, false, is_gz != 0);
}

export fn ttbc_output_open_stdout() Handle {
    const world = get_world();
    return world.alloc_output(fs.File.stdout(), "stdout", true, false);
}

export fn ttbc_output_putc(handle: Handle, c: c_int) c_int {
    const world = get_world();
    const slot = world.get_output(handle) orelse return -1;
    const byte: [1]u8 = .{@intCast(c & 0xff)};
    if (slot.is_gz) {
        const buf = slot.gz_buf orelse return -1;
        buf.append(std.heap.c_allocator, byte[0]) catch return -1;
        return c;
    }
    slot.file.writeAll(&byte) catch return -1;
    return c;
}

export fn ttbc_output_write(handle: Handle, data: [*]const u8, len: usize) usize {
    const world = get_world();
    const slot = world.get_output(handle) orelse return 0;
    if (slot.is_gz) {
        const buf = slot.gz_buf orelse return 0;
        buf.appendSlice(std.heap.c_allocator, data[0..len]) catch return 0;
        return len;
    }
    slot.file.writeAll(data[0..len]) catch return 0;
    return len;
}

// No-op: Zig's std.fs.File.writeAll issues direct write() syscalls with no
// user-space buffering, so there is nothing to flush.
export fn ttbc_output_flush(handle: Handle) c_int {
    _ = handle;
    return 0;
}

// zlib gzdopen/gzwrite/gzclose for gzip output (resolved via zlib_lib)
extern fn gzdopen(fd: c_int, mode: [*:0]const u8) ?*anyopaque;
extern fn gzwrite(gz: *anyopaque, buf: [*]const u8, len: c_uint) c_int;
extern fn gzclose(gz: *anyopaque) c_int;

export fn ttbc_output_close(handle: Handle) c_int {
    const world = get_world();
    const slot = world.get_output(handle) orelse return 0;
    defer world.outputs[handle - 1] = null;

    if (slot.is_gz) {
        if (slot.gz_buf) |buf| {
            defer {
                buf.deinit(std.heap.c_allocator);
                std.heap.c_allocator.destroy(buf);
            }
            // gzdopen takes ownership of the fd; dup so our fs.File.close() is
            // still valid after gzclose (which will close the dup'd fd).
            const raw_fd = slot.file.handle;
            const dup_fd = std.posix.dup(raw_fd) catch {
                slot.file.close();
                return -1;
            };
            const gz = gzdopen(dup_fd, "wb") orelse {
                std.posix.close(dup_fd);
                slot.file.close();
                return -1;
            };
            const data = buf.items;
            if (data.len > 0) {
                _ = gzwrite(gz, data.ptr, @intCast(data.len));
            }
            _ = gzclose(gz); // closes dup_fd, flushes gzip trailer
            slot.file.close(); // closes raw_fd (position already correct via dup)
        }
        return 0;
    }

    if (!slot.is_stdout) {
        slot.file.close();
    }
    return 0;
}

// ====================================================================
// Exported C functions -- input
// ====================================================================

export fn ttbc_input_open(name: [*:0]const u8, format: FileFormat, is_gz: c_int) Handle {
    _ = is_gz;
    const name_slice = std.mem.span(name);
    Log.dbg("bridge", "input_open('{s}', format={d})", .{ name_slice, format });

    const world = get_world();

    // serve format files from memory when available (avoids temp file I/O)
    if (format == World.TTBC_FILE_FORMAT_FORMAT) {
        if (world.format_data) |data| {
            const h = world.alloc_memory_input(data, name_slice);
            Log.dbg("bridge", "  -> memory-backed handle {d} ({d} bytes)", .{ h, data.len });
            return h;
        }
    }

    const file = world.try_open_input(name_slice, format) orelse {
        Log.dbg("bridge", "  -> not found", .{});
        return INVALID_HANDLE;
    };

    const h = world.alloc_input(file, name_slice);
    Log.dbg("bridge", "  -> handle {d}", .{h});
    return h;
}

export fn ttbc_input_open_primary() Handle {
    const world = get_world();
    if (world.primary_input_len == 0) {
        Log.dbg("bridge", "input_open_primary: no primary input set", .{});
        return INVALID_HANDLE;
    }
    const name = world.primary_input[0..world.primary_input_len];
    Log.dbg("bridge", "input_open_primary('{s}')", .{name});

    const file = world.try_open_input(name, World.TTBC_FILE_FORMAT_TEX) orelse {
        Log.dbg("bridge", "  -> not found", .{});
        return INVALID_HANDLE;
    };

    return world.alloc_input(file, name);
}

export fn ttbc_get_last_input_abspath(buffer: [*]u8, len: usize) isize {
    const world = get_world();
    if (world.last_input_abspath_len == 0) return 0;
    const path_len = world.last_input_abspath_len;
    if (path_len + 1 > len) return -2;
    @memcpy(buffer[0..path_len], world.last_input_abspath[0..path_len]);
    buffer[path_len] = 0;
    return @intCast(path_len + 1);
}

export fn ttbc_input_get_size(handle: Handle) usize {
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    return slot.get_size() catch return 0;
}

export fn ttbc_input_get_mtime(handle: Handle) i64 {
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    // memory-backed inputs have no mtime
    const f = slot.file orelse return 0;
    const stat = f.stat() catch return 0;
    return @intCast(@divTrunc(stat.mtime, std.time.ns_per_s));
}

export fn ttbc_input_seek(handle: Handle, offset: isize, whence: c_int, internal_error: ?*c_int) usize {
    const world = get_world();
    const slot = world.get_input(handle) orelse {
        if (internal_error) |e| e.* = 1;
        return 0;
    };

    const has_ungetc = slot.ungetc_byte != null;

    const new_pos: u64 = switch (whence) {
        World.SEEK_SET => blk: {
            slot.seek_to(@intCast(offset)) catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            slot.ungetc_byte = null;
            break :blk @intCast(offset);
        },
        World.SEEK_CUR => blk: {
            if (offset == 0) {
                const pos = slot.get_pos() catch {
                    if (internal_error) |e| e.* = 1;
                    return 0;
                };
                break :blk if (has_ungetc) pos - 1 else pos;
            }
            const adj: i64 = if (has_ungetc) -1 else 0;
            slot.seek_by(@as(i64, @intCast(offset)) + adj) catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            slot.ungetc_byte = null;
            const pos = slot.get_pos() catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            break :blk pos;
        },
        World.SEEK_END => blk: {
            const size = slot.get_size() catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            const size_i: i64 = @intCast(size);
            const target: u64 = @intCast(size_i + @as(i64, @intCast(offset)));
            slot.seek_to(target) catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            slot.ungetc_byte = null;
            break :blk target;
        },
        else => {
            if (internal_error) |e| e.* = 1;
            return 0;
        },
    };

    return @intCast(new_pos);
}

export fn ttbc_input_getc(handle: Handle) c_int {
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;

    if (slot.ungetc_byte) |b| {
        slot.ungetc_byte = null;
        return @intCast(b);
    }

    var buf: [1]u8 = undefined;
    const n = slot.read(&buf) catch return -1;
    if (n == 0) return -1;
    return @intCast(buf[0]);
}

export fn ttbc_input_ungetc(handle: Handle, ch: c_int) c_int {
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;
    slot.ungetc_byte = @intCast(ch & 0xff);
    return 0;
}

export fn ttbc_input_read(handle: Handle, data: [*]u8, len: usize) isize {
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;

    var dest = data[0..len];
    var total: usize = 0;

    if (slot.ungetc_byte) |b| {
        if (len > 0) {
            dest[0] = b;
            dest = dest[1..];
            total = 1;
            slot.ungetc_byte = null;
        }
    }

    while (dest.len > 0) {
        const n = slot.read(dest) catch return if (total > 0) @as(isize, @intCast(total)) else -1;
        if (n == 0) return if (total > 0) @as(isize, @intCast(total)) else -1;
        dest = dest[n..];
        total += n;
    }

    return @intCast(total);
}

export fn ttbc_input_read_partial(handle: Handle, data: [*]u8, len: usize) isize {
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;

    if (slot.ungetc_byte) |b| {
        if (len > 0) {
            data[0] = b;
            slot.ungetc_byte = null;
            return 1;
        }
    }

    const n = slot.read(data[0..len]) catch return -1;
    if (n == 0) return -1;
    return @intCast(n);
}

export fn ttbc_input_close(handle: Handle) c_int {
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    slot.close();
    world.inputs[handle - 1] = null;
    return 0;
}

// ====================================================================
// Exported C functions -- shell escape
// ====================================================================

export fn ttbc_shell_escape(cmd: [*]const u16, len: usize) c_int {
    _ = cmd;
    _ = len;
    return 1; // disallowed
}

// ====================================================================
// Force export fn emission for modules with C ABI exports
// ====================================================================

comptime {
    _ = @import("Flate.zig");
    _ = @import("Layout.zig");
    _ = @import("wasm_exports.zig");
}

// ====================================================================
// Checkpoint callback -- engine lifecycle events from C side
// ====================================================================

pub const CheckpointId = enum(c_int) {
    format_loaded = 1,
    _,
};

pub const CheckpointCallback = struct {
    func: *const fn (userdata: ?*anyopaque, id: CheckpointId) void,
    userdata: ?*anyopaque,
};

extern fn ttbc_set_checkpoint_callback(
    func: ?*const fn (userdata: ?*anyopaque, id: c_int) callconv(.c) void,
    userdata: ?*anyopaque,
) void;

var checkpoint_handler: ?CheckpointCallback = null;

fn checkpoint_trampoline(userdata: ?*anyopaque, raw_id: c_int) callconv(.c) void {
    _ = userdata;
    const id: CheckpointId = @enumFromInt(raw_id);
    if (checkpoint_handler) |h| {
        h.func(h.userdata, id);
    }
}

pub fn set_checkpoint_callback(callback: ?CheckpointCallback) void {
    checkpoint_handler = callback;
    if (callback != null) {
        ttbc_set_checkpoint_callback(&checkpoint_trampoline, null);
    } else {
        ttbc_set_checkpoint_callback(null, null);
    }
}

pub fn clear_checkpoint_callback() void {
    checkpoint_handler = null;
    ttbc_set_checkpoint_callback(null, null);
}
