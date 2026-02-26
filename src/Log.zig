// Log.zig -- structured logging with platform-correct stderr writer.
//
// For target detection elsewhere, use Host.is_wasm (canonical source).
// The is_wasm here is private to Log's stderr writer logic.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

const is_wasm = builtin.cpu.arch == .wasm32;

// stderr writer using streaming mode (fd_write, not positional pwrite).
// each Log call creates a new Writer, so positional writes would overwrite
// earlier output when stderr is redirected to a file.
pub fn stderr_writer(io: Io, buf: []u8) Io.File.Writer {
    return Io.File.stderr().writerStreaming(io, buf);
}

pub const Level = enum { info, warn, err };

// debug mode: off by default, can be enabled at runtime.
// on WASM: JS host sets this via an exported function.
// on native: set via --debug flag or env var.
// atomic: written from any thread (WASM export, CLI flag), read from any thread.
var debug_enabled: std.atomic.Value(bool) = .init(false);

pub fn set_debug(enabled: bool) void {
    debug_enabled.store(enabled, .monotonic);
}

pub fn is_debug() bool {
    return debug_enabled.load(.monotonic);
}

// debug log: only emits when debug_enabled is true.
// zero cost when debug is off (just an atomic bool load).
pub fn dbg(io: Io, comptime scope: []const u8, comptime fmt: []const u8, args: anytype) void {
    if (!debug_enabled.load(.monotonic)) return;
    log_stderr(io, "[dbg:" ++ scope ++ "] ", fmt, args);
}

// structured log: [scope] level: message (info omits level tag for clean output)
pub fn log(io: Io, comptime scope: []const u8, comptime level: Level, comptime fmt: []const u8, args: anytype) void {
    const prefix = switch (level) {
        .info => "[" ++ scope ++ "] ",
        .warn => "[" ++ scope ++ "] warn: ",
        .err => "[" ++ scope ++ "] error: ",
    };
    log_stderr(io, prefix, fmt, args);
}

// low-level: write prefix ++ fmt ++ newline to stderr and flush
pub fn log_stderr(io: Io, comptime prefix: []const u8, comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    var writer = stderr_writer(io, &buf);
    const w = &writer.interface;
    w.print(prefix ++ fmt ++ "\n", args) catch {};
    w.flush() catch {};
}
