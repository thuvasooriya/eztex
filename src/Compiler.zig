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

fn on_diag_warning(text: []const u8) void {
    _ = text;
}

fn on_diag_error(text: []const u8) void {
    _ = text;
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

// -- plain format generation --

var g_plain_fmt_buf: [1024]u8 = undefined;

fn setup_plain_format(world: *Engine.World, _: []const u8, _: bool) void {
    if (fs.cwd().access("tmp/plain.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing tmp/plain.fmt", .{});
        return;
    } else |_| {}

    Log.log("eztex", .info, "generating plain.fmt (first time only)...", .{});

    const initex_input = "tmp/_make_plain_fmt.tex";
    const initex_file = fs.cwd().createFile(initex_input, .{}) catch |err| {
        Log.log("eztex", .err, "failed to create initex input: {}", .{err});
        return;
    };
    initex_file.writeAll("\\input plain \\dump\n") catch |err| {
        initex_file.close();
        Log.log("eztex", .err, "failed to write initex input: {}", .{err});
        return;
    };
    initex_file.close();

    set_engine_var(.initex_mode, true);
    set_engine_var(.halt_on_error, true);
    set_engine_var(.synctex, false);

    world.set_primary_input(initex_input);
    world.set_output_dir("tmp");

    Log.dbg("eztex", "running initex to generate plain.fmt...", .{});

    const result = tt_engine_xetex_main(
        "plain",
        "_make_plain_fmt.tex",
        0,
    );

    set_engine_var(.initex_mode, false);
    fs.cwd().deleteFile(initex_input) catch {};

    if (xetex_succeeded(result)) {
        fs.cwd().rename("tmp/_make_plain_fmt.fmt", "tmp/plain.fmt") catch |err| {
            Log.log("eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io();
            return;
        };
        fs.cwd().deleteFile("tmp/_make_plain_fmt.log") catch {};
        Log.log("eztex", .info, "plain.fmt generated successfully", .{});
    } else {
        Log.log("eztex", .warn, "failed to generate plain.fmt (exit code {d})", .{result});
        fs.cwd().deleteFile("tmp/_make_plain_fmt.fmt") catch {};
        fs.cwd().deleteFile("tmp/_make_plain_fmt.log") catch {};
    }

    world.reset_io();
}

// -- xelatex format generation --

fn generate_xelatex_format(world: *Engine.World, _: ?[]const u8, _: bool) void {
    if (fs.cwd().access("tmp/xelatex.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing tmp/xelatex.fmt", .{});
        return;
    } else |_| {}

    if (fs.cwd().access("xelatex.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing xelatex.fmt", .{});
        return;
    } else |_| {}

    if (is_wasm) {
        Log.log("eztex", .info, "generating xelatex.fmt (first run, may take several minutes in browser)...", .{});
    } else {
        Log.log("eztex", .info, "generating xelatex.fmt (first time only, may take a minute)...", .{});
    }

    const initex_input = "tmp/_make_xelatex_fmt.tex";
    const initex_file = fs.cwd().createFile(initex_input, .{}) catch |err| {
        Log.log("eztex", .err, "failed to create initex input: {}", .{err});
        return;
    };
    initex_file.writeAll("\\input tectonic-format-latex.tex\n") catch |err| {
        initex_file.close();
        Log.log("eztex", .err, "failed to write initex input: {}", .{err});
        return;
    };
    initex_file.close();

    set_engine_var(.initex_mode, true);
    set_engine_var(.halt_on_error, true);
    set_engine_var(.synctex, false);

    world.set_primary_input(initex_input);
    world.set_output_dir("tmp");

    Log.dbg("eztex", "running initex to generate xelatex.fmt...", .{});

    const result = tt_engine_xetex_main(
        "xelatex",
        "_make_xelatex_fmt.tex",
        0,
    );

    set_engine_var(.initex_mode, false);
    fs.cwd().deleteFile(initex_input) catch {};

    if (xetex_succeeded(result)) {
        fs.cwd().rename("tmp/_make_xelatex_fmt.fmt", "tmp/xelatex.fmt") catch |err| {
            Log.log("eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io();
            return;
        };
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.log") catch {};
        Log.log("eztex", .info, "xelatex.fmt generated successfully", .{});
    } else {
        Log.log("eztex", .warn, "failed to generate xelatex.fmt (exit code {d})", .{result});
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.fmt") catch {};
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.log") catch {};
    }

    world.reset_io();
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
