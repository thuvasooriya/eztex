// Log.zig -- structured logging with platform-correct stderr writer.
//
// For target detection elsewhere, use Host.is_wasm (canonical source).
// The is_wasm here is private to Log's stderr writer logic.

const std = @import("std");
const builtin = @import("builtin");
const fs = std.fs;

const is_wasm = builtin.cpu.arch == .wasm32;

// platform-correct stderr writer.
// on WASI, fd_pwrite is not supported for stderr (ConsoleStdout in browser_wasi_shim
// only implements fd_write). use streaming mode to avoid silent data loss from the
// positional-to-streaming fallback that drops the first write.
pub fn stderr_writer(buf: []u8) fs.File.Writer {
    const f = fs.File.stderr();
    if (is_wasm) return f.writerStreaming(buf);
    return f.writer(buf);
}

pub const Level = enum { info, warn, err };

// debug mode: off by default, can be enabled at runtime.
// on WASM: JS host sets this via an exported function.
// on native: set via --debug flag or env var.
var debug_enabled: bool = false;

pub fn set_debug(enabled: bool) void {
    debug_enabled = enabled;
}

pub fn is_debug() bool {
    return debug_enabled;
}

// debug log: only emits when debug_enabled is true.
// zero cost when debug is off (just a bool check).
pub fn dbg(comptime scope: []const u8, comptime fmt: []const u8, args: anytype) void {
    if (!debug_enabled) return;
    log_stderr("[dbg:" ++ scope ++ "] ", fmt, args);
}

// structured log: [scope] level: message (info omits level tag for clean output)
pub fn log(comptime scope: []const u8, comptime level: Level, comptime fmt: []const u8, args: anytype) void {
    const prefix = switch (level) {
        .info => "[" ++ scope ++ "] ",
        .warn => "[" ++ scope ++ "] warn: ",
        .err => "[" ++ scope ++ "] error: ",
    };
    log_stderr(prefix, fmt, args);
}

// low-level: write prefix ++ fmt ++ newline to stderr and flush
pub fn log_stderr(comptime prefix: []const u8, comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var writer = stderr_writer(&buf);
    const w = &writer.interface;
    w.print(prefix ++ fmt ++ "\n", args) catch {};
    w.flush() catch {};
}
