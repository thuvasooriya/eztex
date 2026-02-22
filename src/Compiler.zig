// Compiler.zig -- TeX compilation orchestration.
//
// Contains engine invocation (xetex, xdvipdfmx, bibtex), format generation,
// world setup, multi-pass logic, and intermediate file management.

const Compiler = @This();
const std = @import("std");
const fs = std.fs;
const fs_path = std.fs.path;
const Engine = @import("Engine.zig");
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const is_wasm = Host.is_wasm;
const Config = @import("Config.zig");
const FormatCache = @import("FormatCache.zig");
const seeds = @import("seeds.zig");
const Project = @import("Project.zig");

// -- compile configuration --

pub const CompileConfig = struct {
    input_file: ?[]const u8 = null,
    output_file: ?[]const u8 = null,
    format: Format = .latex,
    keep_intermediates: bool = false,
    verbose: bool = false,
    deterministic: bool = false,
    synctex: bool = false,
    cache_dir: ?[]const u8 = null,
};

pub const max_auto_passes: u8 = 5;

// -- extern declarations (engine entry points) --
// NOTE: no api:?*anyopaque parameter -- thunk layer was removed.

extern fn tt_engine_xetex_main(
    dump_name: [*:0]const u8,
    input_file_name: [*:0]const u8,
    build_date: u64,
) c_int;

extern fn tt_xetex_set_int_variable(
    var_name: [*:0]const u8,
    value: c_int,
) c_int;

const XdvipdfmxConfig = extern struct {
    paperspec: [*:0]const u8,
    enable_compression: u8,
    deterministic_tags: u8,
    build_date: u64,
};

extern fn tt_engine_xdvipdfmx_main(
    cfg: *const XdvipdfmxConfig,
    dviname: [*:0]const u8,
    pdfname: [*:0]const u8,
) c_int;

extern fn bibtex_main(aux_file_name: [*:0]const u8) c_int;

extern fn _ttbc_get_error_message() [*:0]const u8;

// -- engine variable helpers --

const EngineVar = enum {
    halt_on_error,
    initex_mode,
    synctex,
    semantic_pagination,
    shell_escape,

    fn name(self: EngineVar) [*:0]const u8 {
        return switch (self) {
            .halt_on_error => "halt_on_error_p",
            .initex_mode => "in_initex_mode",
            .synctex => "synctex_enabled",
            .semantic_pagination => "semantic_pagination_enabled",
            .shell_escape => "shell_escape_enabled",
        };
    }
};

fn set_engine_var(v: EngineVar, value: bool) void {
    _ = tt_xetex_set_int_variable(v.name(), if (value) 1 else 0);
}

fn set_engine_int(v: EngineVar, value: c_int) void {
    _ = tt_xetex_set_int_variable(v.name(), value);
}

// -- format enum --

pub const Format = enum {
    latex,
    plain,

    const engine_serial: u32 = 33;

    pub fn dump_name(self: Format) [*:0]const u8 {
        return switch (self) {
            .latex => "xelatex",
            .plain => "plain",
        };
    }

    pub fn fmt_filename(self: Format) []const u8 {
        return switch (self) {
            .latex => "xelatex.fmt",
            .plain => "plain.fmt",
        };
    }
};

// -- engine exit codes (from xetex-xetexd.h) --

const HISTORY_SPOTLESS: c_int = 0;
const HISTORY_WARNING_ISSUED: c_int = 1;
const HISTORY_ERROR_ISSUED: c_int = 2;
const HISTORY_FATAL_ERROR: c_int = 3;

fn xetex_succeeded(result: c_int) bool {
    return result == HISTORY_SPOTLESS or result == HISTORY_WARNING_ISSUED;
}

// -- diagnostic handler --

fn diag_write_stderr(text: []const u8) void {
    var buf: [4096]u8 = undefined;
    var w = Log.stderr_writer(&buf);
    const iface = &w.interface;
    iface.writeAll(text) catch {};
    iface.writeByte('\n') catch {};
    iface.flush() catch {};
}

// parsed diagnostic parts from the C engine's "file:line: message\ncontext..." format
const DiagParts = struct {
    file: ?[]const u8,
    line: ?[]const u8,
    message: []const u8,
    context: ?[]const u8, // remaining text after first line (l.N context, help text)
};

// parse "file:line: message" prefix from diagnostic text.
// the C engine's diagnostic_print_file_line() emits "%s:%d: " at the start.
// handles both "./file.tex:5: msg" and bare "msg" (no prefix).
fn parse_diag_text(text: []const u8) DiagParts {
    // find first newline to separate first line from context
    const first_nl = std.mem.indexOfScalar(u8, text, '\n');
    const first_line = if (first_nl) |nl| text[0..nl] else text;
    const context = if (first_nl) |nl| (if (nl + 1 < text.len) text[nl + 1 ..] else null) else null;

    // try to parse "file:line: message" from first line
    // look for pattern: anything, colon, digits, colon, space
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

const FileLinePrefix = struct {
    file: []const u8,
    line_str: []const u8,
    rest: []const u8,
};

fn parse_file_line_prefix(line: []const u8) ?FileLinePrefix {
    // scan backwards from end to find ": " preceded by "digits:" preceded by the filename
    // pattern: <file>:<digits>: <message>
    // find the LAST occurrence of a ":<digits>: " pattern
    var i: usize = 0;
    while (i < line.len) {
        if (line[i] == ':' and i > 0) {
            // check if followed by digits then ": "
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

fn detect_use_color() bool {
    if (is_wasm) return false;
    const tty_conf = std.io.tty.detectConfig(fs.File.stderr());
    return tty_conf != .no_color;
}

fn diag_write_with_severity(text: []const u8, comptime severity: []const u8) void {
    if (text.len == 0) return;
    var buf: [8192]u8 = undefined;
    var w = Log.stderr_writer(&buf);
    const iface = &w.interface;
    const use_color = detect_use_color();
    const parsed = parse_diag_text(text);

    // severity label
    if (use_color) {
        const color = if (comptime std.mem.eql(u8, severity, "error")) "\x1b[1;31m" else "\x1b[1;33m";
        iface.writeAll(color) catch {};
        iface.writeAll(severity) catch {};
        iface.writeAll(":\x1b[0m ") catch {};
    } else {
        iface.writeAll(severity) catch {};
        iface.writeAll(": ") catch {};
    }

    // message (first line, without file:line prefix)
    iface.writeAll(parsed.message) catch {};
    iface.writeByte('\n') catch {};

    // file:line arrow (if available)
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

    // context lines (indented with pipe)
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

fn on_diag_warning(text: []const u8) void {
    diag_write_with_severity(text, "warning");
}

fn on_diag_error(text: []const u8) void {
    diag_write_with_severity(text, "error");
}

fn on_diag_info(text: []const u8) void {
    diag_write_stderr(text);
}

const default_diag_handler = Engine.World.DiagnosticHandler{
    .on_warning = on_diag_warning,
    .on_error = on_diag_error,
    .on_info = on_diag_info,
};

// -- checkpoint handler --

fn on_checkpoint(_: ?*anyopaque, id: Engine.CheckpointId) void {
    switch (id) {
        .format_loaded => Log.dbg("eztex", "checkpoint: format loaded", .{}),
        _ => Log.dbg("eztex", "checkpoint: unknown ({d})", .{@intFromEnum(id)}),
    }
}

// -- stem / path utilities --

fn get_stem(input_file: []const u8) []const u8 {
    return if (std.mem.endsWith(u8, input_file, ".tex"))
        input_file[0 .. input_file.len - 4]
    else
        input_file;
}

fn get_jobname(input_file: []const u8) []const u8 {
    return get_stem(fs_path.basename(input_file));
}

// -- aux file comparison --

fn read_file_contents(path: []const u8) ?[]const u8 {
    const file = fs.cwd().openFile(path, .{}) catch return null;
    defer file.close();
    return file.readToEndAlloc(std.heap.c_allocator, 4 * 1024 * 1024) catch null;
}

fn free_file_contents(contents: ?[]const u8) void {
    if (contents) |c| std.heap.c_allocator.free(c);
}

fn aux_changed(prev: ?[]const u8, curr: ?[]const u8) bool {
    if (prev == null and curr == null) return false;
    if (prev == null or curr == null) return true;
    return !std.mem.eql(u8, prev.?, curr.?);
}

// -- format discovery and file helpers --

fn find_format_path(cache_dir: []const u8, buf: []u8, format_name: []const u8) ?[]const u8 {
    var dir_buf: [1024]u8 = undefined;
    const formats_path = std.fmt.bufPrint(&dir_buf, "{s}/formats", .{cache_dir}) catch return null;
    var dir = fs.openDirAbsolute(formats_path, .{ .iterate = true }) catch return null;
    defer dir.close();

    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".fmt")) continue;
        if (std.mem.indexOf(u8, entry.name, format_name) != null) {
            return std.fmt.bufPrint(buf, "{s}/{s}", .{ formats_path, entry.name }) catch return null;
        }
    }
    return null;
}

fn copy_file_to_cache_dir(cache_dir: []const u8, src_rel: []const u8, dest_rel: []const u8) void {
    var cache = fs.openDirAbsolute(cache_dir, .{}) catch return;
    defer cache.close();
    if (fs_path.dirname(dest_rel)) |parent| {
        cache.makePath(parent) catch {};
    }
    fs.cwd().copyFile(src_rel, cache, dest_rel, .{}) catch {};
}

// -- build date --

fn current_build_date(deterministic: bool) u64 {
    return if (deterministic) 1 else @as(u64, @intCast(std.time.timestamp()));
}

// -- engine invocation --

fn run_xetex(_: *Engine.World, input_file: []const u8, format: Format, _: bool, opts: *const CompileConfig) c_int {
    set_engine_var(.synctex, opts.synctex);
    set_engine_var(.halt_on_error, true);

    var input_name_buf: [512]u8 = undefined;
    const input_name_len = @min(input_file.len, input_name_buf.len - 1);
    @memcpy(input_name_buf[0..input_name_len], input_file[0..input_name_len]);
    input_name_buf[input_name_len] = 0;
    const input_name_z: [*:0]const u8 = input_name_buf[0..input_name_len :0];

    Log.dbg("eztex", "calling tt_engine_xetex_main (format={s})...", .{format.fmt_filename()});

    const result = tt_engine_xetex_main(
        format.dump_name(),
        input_name_z,
        current_build_date(opts.deterministic),
    );

    Log.dbg("eztex", "xetex returned: {d}", .{result});
    return result;
}

fn run_xdvipdfmx(_: *Engine.World, xdv_name: []const u8, pdf_name: []const u8, _: bool, opts: *const CompileConfig) c_int {
    var xdv_buf: [512]u8 = undefined;
    var pdf_buf: [512]u8 = undefined;

    @memcpy(xdv_buf[0..xdv_name.len], xdv_name);
    xdv_buf[xdv_name.len] = 0;
    const xdv_z: [*:0]const u8 = xdv_buf[0..xdv_name.len :0];

    @memcpy(pdf_buf[0..pdf_name.len], pdf_name);
    pdf_buf[pdf_name.len] = 0;
    const pdf_z: [*:0]const u8 = pdf_buf[0..pdf_name.len :0];

    const config = XdvipdfmxConfig{
        .paperspec = "letter",
        .enable_compression = 1,
        .deterministic_tags = if (opts.deterministic) 1 else 0,
        .build_date = current_build_date(opts.deterministic),
    };

    Log.log("eztex", .info, "calling xdvipdfmx('{s}' -> '{s}')...", .{ xdv_name, pdf_name });

    const result = tt_engine_xdvipdfmx_main(
        &config,
        xdv_z,
        pdf_z,
    );

    Log.log("eztex", .info, "xdvipdfmx returned: {d}", .{result});

    if (result != 0) {
        const err_msg = _ttbc_get_error_message();
        const msg_slice = std.mem.span(err_msg);
        if (msg_slice.len > 0) {
            Log.log("eztex", .info, "xdvipdfmx abort reason: {s}", .{msg_slice});
        } else {
            Log.log("eztex", .info, "xdvipdfmx abort: no error message in format_buf", .{});
        }
    }

    return result;
}

fn run_bibtex(_: *Engine.World, aux_name: []const u8, _: bool) c_int {
    var aux_buf: [512]u8 = undefined;
    const name_len = @min(aux_name.len, aux_buf.len - 1);
    @memcpy(aux_buf[0..name_len], aux_name[0..name_len]);
    aux_buf[name_len] = 0;
    const aux_z: [*:0]const u8 = aux_buf[0..name_len :0];

    Log.log("eztex", .info, "running bibtex on '{s}'...", .{aux_name});

    reset_world_io();
    const result = bibtex_main(aux_z);

    Log.dbg("eztex", "bibtex returned: {d}", .{result});
    return result;
}

// -- aux file bibtex detection --

fn aux_needs_bibtex(aux_contents: ?[]const u8) bool {
    const content = aux_contents orelse return false;
    return std.mem.indexOf(u8, content, "\\bibdata{") != null or
        std.mem.indexOf(u8, content, "\\bibstyle{") != null or
        std.mem.indexOf(u8, content, "\\abx@aux@") != null;
}

// -- format generation --

const FormatSpec = struct {
    dump_name: [*:0]const u8,
    fmt_path: []const u8,
    initex_input: []const u8,
    initex_basename: [*:0]const u8,
    tmp_fmt: []const u8,
    tmp_log: []const u8,
    tex_content: []const u8,
    extra_cache_path: ?[]const u8 = null,
    // comptime log messages (Log.log/dbg require comptime fmt)
    msg_generating: []const u8,
    msg_found_fmt: []const u8,
    msg_found_extra: []const u8 = "",
    msg_running: []const u8,
    msg_success: []const u8,
    msg_failure: []const u8,
};

const plain_format_spec = FormatSpec{
    .dump_name = "plain",
    .fmt_path = "tmp/plain.fmt",
    .initex_input = "tmp/_make_plain_fmt.tex",
    .initex_basename = "_make_plain_fmt.tex",
    .tmp_fmt = "tmp/_make_plain_fmt.fmt",
    .tmp_log = "tmp/_make_plain_fmt.log",
    .tex_content = "\\input plain \\dump\n",
    .msg_generating = "generating plain.fmt (first time only)...",
    .msg_found_fmt = "found existing tmp/plain.fmt",
    .msg_running = "running initex to generate plain.fmt...",
    .msg_success = "plain.fmt generated successfully",
    .msg_failure = "failed to generate plain.fmt (exit code {d})",
};

const xelatex_format_spec = FormatSpec{
    .dump_name = "xelatex",
    .fmt_path = "tmp/xelatex.fmt",
    .initex_input = "tmp/_make_xelatex_fmt.tex",
    .initex_basename = "_make_xelatex_fmt.tex",
    .tmp_fmt = "tmp/_make_xelatex_fmt.fmt",
    .tmp_log = "tmp/_make_xelatex_fmt.log",
    .tex_content = "\\input tectonic-format-latex.tex\n",
    .extra_cache_path = "xelatex.fmt",
    .msg_generating = if (is_wasm)
        "generating xelatex.fmt (first run, may take several minutes in browser)..."
    else
        "generating xelatex.fmt (first time only, may take a minute)...",
    .msg_found_fmt = "found existing tmp/xelatex.fmt",
    .msg_found_extra = "found existing xelatex.fmt",
    .msg_running = "running initex to generate xelatex.fmt...",
    .msg_success = "xelatex.fmt generated successfully",
    .msg_failure = "failed to generate xelatex.fmt (exit code {d})",
};

fn run_initex(world: *Engine.World, comptime spec: FormatSpec) void {
    if (fs.cwd().access(spec.fmt_path, .{})) |_| {
        Log.dbg("eztex", spec.msg_found_fmt, .{});
        return;
    } else |_| {}

    if (comptime spec.extra_cache_path) |extra| {
        if (fs.cwd().access(extra, .{})) |_| {
            Log.dbg("eztex", spec.msg_found_extra, .{});
            return;
        } else |_| {}
    }

    Log.log("eztex", .info, spec.msg_generating, .{});

    const initex_file = fs.cwd().createFile(spec.initex_input, .{}) catch |err| {
        Log.log("eztex", .err, "failed to create initex input: {}", .{err});
        return;
    };
    initex_file.writeAll(spec.tex_content) catch |err| {
        initex_file.close();
        Log.log("eztex", .err, "failed to write initex input: {}", .{err});
        return;
    };
    initex_file.close();

    set_engine_var(.initex_mode, true);
    set_engine_var(.halt_on_error, true);
    set_engine_var(.synctex, false);

    world.set_primary_input(spec.initex_input);
    world.set_output_dir("tmp");

    Log.dbg("eztex", spec.msg_running, .{});

    const result = tt_engine_xetex_main(spec.dump_name, spec.initex_basename, 0);

    set_engine_var(.initex_mode, false);
    fs.cwd().deleteFile(spec.initex_input) catch {};

    if (xetex_succeeded(result)) {
        fs.cwd().rename(spec.tmp_fmt, spec.fmt_path) catch |err| {
            Log.log("eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io();
            return;
        };
        fs.cwd().deleteFile(spec.tmp_log) catch {};
        Log.log("eztex", .info, spec.msg_success, .{});
    } else {
        Log.log("eztex", .warn, spec.msg_failure, .{result});
        fs.cwd().deleteFile(spec.tmp_fmt) catch {};
        fs.cwd().deleteFile(spec.tmp_log) catch {};
    }

    world.reset_io();
}

fn setup_plain_format(world: *Engine.World, _: []const u8, _: bool) void {
    run_initex(world, plain_format_spec);
}

fn generate_xelatex_format(world: *Engine.World, _: ?[]const u8, _: bool) void {
    run_initex(world, xelatex_format_spec);
}

// -- format caching (content-addressed) --

var g_fmt_buf: [1024]u8 = undefined;
var g_format_bytes: ?[]u8 = null;

fn make_format_cache_key(format: Format) FormatCache.Key {
    var digest_bytes: [32]u8 = undefined;
    const hex = &Config.default_bundle_digest;
    for (0..32) |i| {
        const hi = hex_digit(hex[i * 2]);
        const lo = hex_digit(hex[i * 2 + 1]);
        digest_bytes[i] = (hi << 4) | lo;
    }
    return .{
        .bundle_digest = digest_bytes,
        .engine_version = @intCast(Format.engine_serial),
        .format_type = switch (format) {
            .latex => .xelatex,
            .plain => .plain,
        },
    };
}

fn hex_digit(c: u8) u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => 0,
    };
}

fn try_load_cached_format(world: *Engine.World, cache_dir: []const u8, format: Format) bool {
    const fmt_filename = format.fmt_filename();

    // fast path: format bytes already in memory (watch mode recompile)
    if (g_format_bytes) |bytes| {
        world.set_format_data(bytes, fmt_filename);
        Log.dbg("eztex", "reusing in-memory format ({d} bytes)", .{bytes.len});
        return true;
    }

    const key = make_format_cache_key(format);
    if (FormatCache.load(std.heap.c_allocator, cache_dir, key) catch null) |bytes| {
        set_format_memory(world, bytes, fmt_filename);
        Log.dbg("eztex", "loaded format from content-addressed cache ({d} bytes, memory-backed)", .{bytes.len});
        return true;
    }

    if (find_format_path(cache_dir, &g_fmt_buf, if (format == .latex) "latex" else "plain")) |fmt_path| {
        Log.dbg("eztex", "found legacy format file: {s}", .{fmt_path});
        const data = blk: {
            const file = fs.openFileAbsolute(fmt_path, .{}) catch return false;
            defer file.close();
            break :blk file.readToEndAlloc(std.heap.c_allocator, 64 * 1024 * 1024) catch return false;
        };
        set_format_memory(world, data, fmt_filename);
        Log.dbg("eztex", "loaded legacy format into memory ({d} bytes)", .{data.len});
        return true;
    }

    return false;
}

fn set_format_memory(world: *Engine.World, bytes: []u8, name: []const u8) void {
    if (g_format_bytes) |old| std.heap.c_allocator.free(old);
    g_format_bytes = bytes;
    world.set_format_data(bytes, name);
}

fn cache_generated_format(world: *Engine.World, cache_dir: []const u8, format: Format) void {
    const fmt_filename = format.fmt_filename();
    var src_buf: [128]u8 = undefined;
    const src_path = std.fmt.bufPrint(&src_buf, "tmp/{s}", .{fmt_filename}) catch return;

    const data = blk: {
        const file = fs.cwd().openFile(src_path, .{}) catch return;
        defer file.close();
        break :blk file.readToEndAlloc(std.heap.c_allocator, 64 * 1024 * 1024) catch return;
    };

    const key = make_format_cache_key(format);
    FormatCache.store(std.heap.c_allocator, cache_dir, key, data) catch |err| {
        Log.dbg("eztex", "failed to store format in cache: {}", .{err});
    };

    var dest_buf: [128]u8 = undefined;
    const dest_rel = std.fmt.bufPrint(&dest_buf, "formats/{s}", .{fmt_filename}) catch return;
    copy_file_to_cache_dir(cache_dir, src_path, dest_rel);

    set_format_memory(world, data, fmt_filename);
    Log.dbg("eztex", "cached and loaded generated format into memory ({d} bytes)", .{data.len});
}

// -- world setup --

fn setup_world(format: Format, verbose: bool, cache_dir_override: ?[]const u8) void {
    const world = Engine.get_world();
    world.add_search_dir(".");

    Engine.set_diagnostic_handler(default_diag_handler);

    Engine.set_checkpoint_callback(.{
        .func = &on_checkpoint,
        .userdata = null,
    });

    Log.set_debug(verbose);

    const cache_dir = Host.setup(world, verbose, cache_dir_override);

    fs.cwd().makeDir("tmp") catch {};

    if (format == .latex) {
        if (cache_dir) |cdir| {
            if (!try_load_cached_format(world, cdir, format)) {
                if (!is_wasm) {
                    seed_cache(&seeds.xelatex_fmt, verbose);
                }
                generate_xelatex_format(world, cache_dir, verbose);
                cache_generated_format(world, cdir, format);
            }
        } else {
            generate_xelatex_format(world, null, verbose);
        }
    } else if (format == .plain) {
        if (cache_dir) |cdir| {
            if (!try_load_cached_format(world, cdir, format)) {
                setup_plain_format(world, cdir, verbose);
                cache_generated_format(world, cdir, format);
            }
        }
    }
    world.add_search_dir("tmp");
}

const default_seed_concurrency: usize = 6;

fn seed_cache(names: []const []const u8, _: bool) void {
    if (is_wasm) return;
    const bs = Engine.get_bundle_store();
    const result = bs.seed_cache(names, default_seed_concurrency);
    Log.dbg("eztex", "seed: {d} fetched, {d} cached, {d} unknown, {d} failed", .{
        result.fetched, result.skipped_cached, result.skipped_unknown, result.failed,
    });
}

fn reset_world_io() void {
    Engine.get_world().reset_io();
}

// -- cleanup --

fn cleanup_intermediates(stem: []const u8) void {
    const extensions = [_][]const u8{
        ".aux", ".log", ".xdv", ".lof", ".lot", ".out",
        ".toc", ".bbl", ".blg", ".nav", ".snm", ".vrb",
    };
    for (extensions) |ext| {
        var buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&buf, "{s}{s}", .{ stem, ext }) catch continue;
        fs.cwd().deleteFile(path) catch {};
    }
}

fn rename_output(stem: []const u8, output_file: []const u8) void {
    var default_buf: [512]u8 = undefined;
    const default_pdf = std.fmt.bufPrint(&default_buf, "{s}.pdf", .{stem}) catch return;
    if (std.mem.eql(u8, default_pdf, output_file)) return;
    fs.cwd().rename(default_pdf, output_file) catch |err| {
        Log.log("eztex", .err, "failed to rename output to '{s}': {}", .{ output_file, err });
    };
}

// -- public API: compile --

pub fn compile(opts: *const CompileConfig, loaded_config: ?Config) u8 {
    const raw_input = opts.input_file orelse {
        Log.log("eztex", .err, "no input file specified", .{});
        return 1;
    };

    const project = if (!is_wasm)
        Project.resolve_project_input(std.heap.c_allocator, raw_input, opts.verbose) orelse return 1
    else
        Project.ProjectInput{ .tex_file = raw_input };

    defer if (project.temp_dir) |tmp| {
        fs.cwd().deleteTree(tmp) catch {};
    };

    const input_file = project.tex_file;

    fs.cwd().access(input_file, .{}) catch {
        Log.log("eztex", .err, "input file '{s}' not found", .{input_file});
        return 1;
    };

    const jobname = get_jobname(input_file);
    const input_dir = fs_path.dirname(input_file);
    const verbose = opts.verbose;
    const format = opts.format;

    Log.log("eztex", .info, "compiling '{s}' (format: {s})", .{ input_file, format.fmt_filename() });

    setup_world(format, verbose, opts.cache_dir);

    if (loaded_config) |config| {
        const bundle = config.effective_bundle();
        const bs = Engine.get_bundle_store();
        const is_custom_url = !std.mem.eql(u8, bundle.url, Config.default_bundle_url);
        const is_custom_index = !std.mem.eql(u8, bundle.index_url, Config.default_index_url);
        if (is_custom_url or is_custom_index) {
            const digest = Config.digest_from_url(bundle.url);
            bs.url = bundle.url;
            bs.digest = digest;
            Host.init(null, bundle.url, bundle.index_url, digest);
            Log.dbg("eztex", "bundle URL override: {s}", .{bundle.url});
            if (is_custom_index) {
                Log.dbg("eztex", "index URL override: {s}", .{bundle.index_url});
            }
        }
    }

    const world = Engine.get_world();
    world.set_primary_input(input_file);

    if (!is_wasm) {
        seed_cache(&seeds.init, verbose);
    }

    if (input_dir) |idir| {
        world.add_search_dir(idir);
        Log.dbg("eztex", "added input directory to search path: {s}", .{idir});
    }

    world.set_output_dir(".");

    const max_passes: u8 = max_auto_passes;

    var aux_path_buf: [512]u8 = undefined;
    const aux_path = std.fmt.bufPrint(&aux_path_buf, "{s}.aux", .{jobname}) catch {
        Log.log("eztex", .err, "jobname too long", .{});
        return 1;
    };

    var prev_aux: ?[]const u8 = null;
    defer free_file_contents(prev_aux);

    var last_xetex_result: c_int = -1;
    var pass: u8 = 0;
    var total_passes: u8 = 0;
    var bibtex_ran: bool = false;

    while (pass < max_passes) : (pass += 1) {
        Log.log("eztex", .info, "pass {d} (auto, max {d})...", .{ pass + 1, max_passes });

        if (pass > 0) reset_world_io();

        last_xetex_result = run_xetex(world, input_file, format, verbose, opts);
        total_passes = pass + 1;

        if (!xetex_succeeded(last_xetex_result)) {
            Log.log("eztex", .info, "xetex failed on pass {d} (exit code {d})", .{ pass + 1, last_xetex_result });
            // retrieve fatal error message from C engine (longjmp-based errors)
            const err_msg = _ttbc_get_error_message();
            const msg_slice = std.mem.span(err_msg);
            if (msg_slice.len > 0) {
                diag_write_with_severity(msg_slice, "error");
            }
            break;
        }

        if (last_xetex_result == HISTORY_WARNING_ISSUED) {
            Log.dbg("eztex", "pass {d} completed with warnings", .{pass + 1});
        }

        const curr_aux = read_file_contents(aux_path);

        if (pass == 0) {
            if (curr_aux == null) {
                Log.log("eztex", .info, "no aux file produced, single pass sufficient", .{});
                break;
            }

            if (!bibtex_ran and aux_needs_bibtex(curr_aux)) {
                Log.log("eztex", .info, "aux file contains bibliography commands, running bibtex...", .{});
                const bib_result = run_bibtex(world, aux_path, verbose);
                bibtex_ran = true;
                if (!xetex_succeeded(bib_result)) {
                    Log.log("eztex", .info, "bibtex failed (exit code {d}), continuing without bibliography", .{bib_result});
                }
            }

            prev_aux = curr_aux;
            Log.dbg("eztex", "aux file produced, will check stability on next pass", .{});
        } else {
            if (!aux_changed(prev_aux, curr_aux)) {
                free_file_contents(curr_aux);
                Log.log("eztex", .info, "aux file stable after pass {d}, done", .{pass + 1});
                break;
            }
            free_file_contents(prev_aux);
            prev_aux = curr_aux;
            Log.dbg("eztex", "aux file changed, another pass needed", .{});
        }
    }

    if (xetex_succeeded(last_xetex_result)) {
        var xdv_buf: [512]u8 = undefined;
        var pdf_buf: [512]u8 = undefined;

        const xdv_name = std.fmt.bufPrint(&xdv_buf, "{s}.xdv", .{jobname}) catch {
            Log.log("eztex", .err, "filename too long for xdv", .{});
            Engine.deinit_bundle_store();
            return 1;
        };

        const pdf_name = std.fmt.bufPrint(&pdf_buf, "{s}.pdf", .{jobname}) catch {
            Log.log("eztex", .err, "filename too long for pdf", .{});
            Engine.deinit_bundle_store();
            return 1;
        };

        reset_world_io();

        const pdf_result = run_xdvipdfmx(world, xdv_name, pdf_name, verbose, opts);

        if (pdf_result != 0) {
            Log.log("eztex", .info, "xdvipdfmx failed (exit code {d})", .{pdf_result});
            Engine.deinit_bundle_store();
            return 1;
        }

        var final_pdf_buf: [512]u8 = undefined;
        const final_pdf = if (opts.output_file) |out|
            out
        else if (project.temp_dir != null)
            pdf_name
        else if (input_dir) |idir|
            std.fmt.bufPrint(&final_pdf_buf, "{s}/{s}.pdf", .{ idir, jobname }) catch pdf_name
        else
            pdf_name;

        if (!std.mem.eql(u8, pdf_name, final_pdf)) {
            rename_output(jobname, final_pdf);
        }

        if (opts.synctex) {
            if (fs_path.dirname(final_pdf)) |out_dir| {
                if (!std.mem.eql(u8, out_dir, ".")) {
                    var synctex_src_buf: [512]u8 = undefined;
                    const synctex_src = std.fmt.bufPrint(&synctex_src_buf, "{s}.synctex.gz", .{jobname}) catch null;
                    if (synctex_src) |src| {
                        fs.cwd().makePath(out_dir) catch {};
                        var synctex_dst_buf: [512]u8 = undefined;
                        const synctex_dst = std.fmt.bufPrint(&synctex_dst_buf, "{s}/{s}.synctex.gz", .{ out_dir, jobname }) catch null;
                        if (synctex_dst) |dst| {
                            if (!std.mem.eql(u8, src, dst)) {
                                fs.cwd().rename(src, dst) catch {};
                            }
                        }
                    }
                }
            }
        }

        Log.log("eztex", .info, "output: {s} ({d} pass{s})", .{
            final_pdf,
            total_passes,
            if (total_passes == 1) @as([]const u8, "") else "es",
        });
    }

    if (!opts.keep_intermediates and xetex_succeeded(last_xetex_result)) {
        cleanup_intermediates(jobname);

        if (!opts.synctex) {
            var synctex_buf: [512]u8 = undefined;
            const synctex_path = std.fmt.bufPrint(&synctex_buf, "{s}.synctex.gz", .{jobname}) catch null;
            if (synctex_path) |p| fs.cwd().deleteFile(p) catch {};
        }

        Log.dbg("eztex", "cleaned up intermediate files", .{});
    }

    Engine.deinit_bundle_store();

    if (!xetex_succeeded(last_xetex_result)) return 1;
    return 0;
}

// -- public API: generate_format --

pub fn generate_format(opts: *const CompileConfig) u8 {
    const verbose = opts.verbose;
    const format = opts.format;

    Log.log("eztex", .info, "generating {s} format...", .{format.fmt_filename()});

    setup_world(format, verbose, opts.cache_dir);
    defer Engine.deinit_bundle_store();

    if (g_format_bytes == null) {
        Log.log("eztex", .err, "format generation failed -- {s} not loaded into memory", .{format.fmt_filename()});
        return 1;
    }

    Log.log("eztex", .info, "{s} ready", .{format.fmt_filename()});
    return 0;
}

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
