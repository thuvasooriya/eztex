// bridge.zig -- C export layer, global state, and re-exports.
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

const StatePtr = ?*anyopaque;
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

export fn ttbc_issue_warning(es: StatePtr, text: [*:0]const u8) void {
    _ = es;
    emit_warning(std.mem.span(text));
}

export fn ttbc_issue_error(es: StatePtr, text: [*:0]const u8) void {
    _ = es;
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

export fn ttbc_diag_finish(es: StatePtr, diag: ?*Diagnostic) void {
    _ = es;
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

export fn ttbc_get_file_md5(es: StatePtr, path: [*:0]const u8, digest: [*]u8) c_int {
    _ = es;
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

export fn ttbc_output_open(es: StatePtr, name: [*:0]const u8, is_gz: c_int) Handle {
    _ = es;
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

export fn ttbc_output_open_stdout(es: StatePtr) Handle {
    _ = es;
    const world = get_world();
    return world.alloc_output(fs.File.stdout(), "stdout", true, false);
}

export fn ttbc_output_putc(es: StatePtr, handle: Handle, c: c_int) c_int {
    _ = es;
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

export fn ttbc_output_write(es: StatePtr, handle: Handle, data: [*]const u8, len: usize) usize {
    _ = es;
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

export fn ttbc_output_flush(es: StatePtr, handle: Handle) c_int {
    _ = es;
    _ = handle;
    return 0;
}

// zlib gzdopen/gzwrite/gzclose for gzip output (resolved via zlib_lib)
extern fn gzdopen(fd: c_int, mode: [*:0]const u8) ?*anyopaque;
extern fn gzwrite(gz: *anyopaque, buf: [*]const u8, len: c_uint) c_int;
extern fn gzclose(gz: *anyopaque) c_int;

export fn ttbc_output_close(es: StatePtr, handle: Handle) c_int {
    _ = es;
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

export fn ttbc_input_open(es: StatePtr, name: [*:0]const u8, format: FileFormat, is_gz: c_int) Handle {
    _ = es;
    _ = is_gz;
    const name_slice = std.mem.span(name);
    Log.dbg("bridge", "input_open('{s}', format={d})", .{ name_slice, format });

    const world = get_world();
    const file = world.try_open_input(name_slice, format) orelse {
        Log.dbg("bridge", "  -> not found", .{});
        return INVALID_HANDLE;
    };

    const h = world.alloc_input(file, name_slice);
    Log.dbg("bridge", "  -> handle {d}", .{h});
    return h;
}

export fn ttbc_input_open_primary(es: StatePtr) Handle {
    _ = es;
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

export fn ttbc_get_last_input_abspath(es: StatePtr, buffer: [*]u8, len: usize) isize {
    _ = es;
    const world = get_world();
    if (world.last_input_abspath_len == 0) return 0;
    const path_len = world.last_input_abspath_len;
    if (path_len + 1 > len) return -2;
    @memcpy(buffer[0..path_len], world.last_input_abspath[0..path_len]);
    buffer[path_len] = 0;
    return @intCast(path_len + 1);
}

export fn ttbc_input_get_size(es: StatePtr, handle: Handle) usize {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    const stat = slot.file.stat() catch return 0;
    return @intCast(@min(stat.size, std.math.maxInt(usize)));
}

export fn ttbc_input_get_mtime(es: StatePtr, handle: Handle) i64 {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    const stat = slot.file.stat() catch return 0;
    return @intCast(@divTrunc(stat.mtime, std.time.ns_per_s));
}

export fn ttbc_input_seek(es: StatePtr, handle: Handle, offset: isize, whence: c_int, internal_error: ?*c_int) usize {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse {
        if (internal_error) |e| e.* = 1;
        return 0;
    };

    const has_ungetc = slot.ungetc_byte != null;

    const new_pos: u64 = switch (whence) {
        World.SEEK_SET => blk: {
            slot.file.seekTo(@intCast(offset)) catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            slot.ungetc_byte = null;
            break :blk @intCast(offset);
        },
        World.SEEK_CUR => blk: {
            if (offset == 0) {
                // position query: return logical position, preserve ungetc state
                const pos = slot.file.getPos() catch {
                    if (internal_error) |e| e.* = 1;
                    return 0;
                };
                break :blk if (has_ungetc) pos - 1 else pos;
            }
            // non-zero seek: adjust for pending ungetc byte so the seek is
            // relative to the logical position, then discard the pushed-back byte
            const adj: i64 = if (has_ungetc) -1 else 0;
            slot.file.seekBy(@as(i64, @intCast(offset)) + adj) catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            slot.ungetc_byte = null;
            const pos = slot.file.getPos() catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            break :blk pos;
        },
        World.SEEK_END => blk: {
            const stat = slot.file.stat() catch {
                if (internal_error) |e| e.* = 1;
                return 0;
            };
            const size: i64 = @intCast(stat.size);
            const target: u64 = @intCast(size + @as(i64, @intCast(offset)));
            slot.file.seekTo(target) catch {
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

export fn ttbc_input_getc(es: StatePtr, handle: Handle) c_int {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;

    if (slot.ungetc_byte) |b| {
        slot.ungetc_byte = null;
        return @intCast(b);
    }

    var buf: [1]u8 = undefined;
    const n = slot.file.read(&buf) catch return -1;
    if (n == 0) return -1;
    return @intCast(buf[0]);
}

export fn ttbc_input_ungetc(es: StatePtr, handle: Handle, ch: c_int) c_int {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;
    slot.ungetc_byte = @intCast(ch & 0xff);
    return 0;
}

export fn ttbc_input_read(es: StatePtr, handle: Handle, data: [*]u8, len: usize) isize {
    _ = es;
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
        const n = slot.file.read(dest) catch return if (total > 0) @as(isize, @intCast(total)) else -1;
        if (n == 0) return if (total > 0) @as(isize, @intCast(total)) else -1;
        dest = dest[n..];
        total += n;
    }

    return @intCast(total);
}

export fn ttbc_input_read_partial(es: StatePtr, handle: Handle, data: [*]u8, len: usize) isize {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return -1;

    if (slot.ungetc_byte) |b| {
        if (len > 0) {
            data[0] = b;
            slot.ungetc_byte = null;
            return 1;
        }
    }

    const n = slot.file.read(data[0..len]) catch return -1;
    if (n == 0) return -1;
    return @intCast(n);
}

export fn ttbc_input_close(es: StatePtr, handle: Handle) c_int {
    _ = es;
    const world = get_world();
    const slot = world.get_input(handle) orelse return 0;
    slot.file.close();
    world.inputs[handle - 1] = null;
    return 0;
}

// ====================================================================
// Exported C functions -- shell escape
// ====================================================================

export fn ttbc_shell_escape(es: StatePtr, cmd: [*]const u16, len: usize) c_int {
    _ = es;
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
