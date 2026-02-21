const std = @import("std");
const fs = std.fs;
const posix = std.posix;
const fs_path = std.fs.path;
const bridge = @import("bridge.zig");
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const is_wasm = Host.is_wasm;

const Config = @import("Config.zig");
const MainDetect = @import("MainDetect.zig");
const seeds = @import("seeds.zig");

// engine entry point defined in xetex-engine-interface.c
extern fn tt_engine_xetex_main(
    api: ?*anyopaque,
    dump_name: [*:0]const u8,
    input_file_name: [*:0]const u8,
    build_date: u64,
) c_int;

extern fn tt_xetex_set_int_variable(
    var_name: [*:0]const u8,
    value: c_int,
) c_int;

// type-safe wrapper for tt_xetex_set_int_variable
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

// xdvipdfmx engine entry point
const XdvipdfmxConfig = extern struct {
    paperspec: [*:0]const u8,
    enable_compression: u8,
    deterministic_tags: u8,
    build_date: u64,
};

extern fn tt_engine_xdvipdfmx_main(
    api: ?*anyopaque,
    cfg: *const XdvipdfmxConfig,
    dviname: [*:0]const u8,
    pdfname: [*:0]const u8,
) c_int;

// bibtex engine entry point defined in engine_bibtex/bibtex.c
extern fn bibtex_main(api: ?*anyopaque, aux_file_name: [*:0]const u8) c_int;

// defined in support.c -- returns the format_buf filled by _tt_abort()
extern fn _ttbc_get_error_message() [*:0]const u8;

// -- CLI types --

const Command = enum {
    compile,
    watch,
    generate_format,
    init,
    help,
    version,
};

const PassMode = union(enum) {
    auto,
    single,
    fixed: u8,
};

const Format = enum {
    latex,
    plain,

    fn dump_name(self: Format) [*:0]const u8 {
        return switch (self) {
            .latex => "xelatex",
            .plain => "plain",
        };
    }

    fn fmt_filename(self: Format) []const u8 {
        return switch (self) {
            .latex => "xelatex.fmt",
            .plain => "plain.fmt",
        };
    }
};

const Options = struct {
    command: Command = .help,
    input_file: ?[]const u8 = null,
    output_file: ?[]const u8 = null,
    pass_mode: PassMode = .auto,
    format: Format = .latex,
    keep_intermediates: bool = false,
    verbose: bool = false,

    // xdvipdfmx
    paper: []const u8 = "letter",

    // cache override (native only, for testing/alternate locations)
    cache_dir: ?[]const u8 = null,

    // engine toggles
    deterministic: bool = false,
    synctex: bool = false,

    // tracks which fields were explicitly set by CLI (not just defaults)
    cli_set: CliSet = .{},

    const max_auto_passes: u8 = 5;

    const CliSet = packed struct {
        output_file: bool = false,
        pass_mode: bool = false,
        format: bool = false,
        keep_intermediates: bool = false,
        paper: bool = false,
        deterministic: bool = false,
        synctex: bool = false,
    };

    // apply config values for fields not explicitly set by CLI
    fn apply_config(self: *Options, config: Config) void {
        if (!self.cli_set.output_file) {
            if (config.output) |o| self.output_file = o;
        }
        if (!self.cli_set.pass_mode) {
            if (config.passes) |p| self.pass_mode = switch (p) {
                .auto => .auto,
                .single => .single,
                .fixed => |n| .{ .fixed = n },
            };
        }
        if (!self.cli_set.format) {
            if (config.format) |f| self.format = switch (f) {
                .latex => .latex,
                .plain => .plain,
            };
        }
        if (!self.cli_set.keep_intermediates) {
            if (config.keep_intermediates) |k| self.keep_intermediates = k;
        }
        if (!self.cli_set.paper) {
            if (config.paper) |p| self.paper = p;
        }
        if (!self.cli_set.deterministic) {
            if (config.deterministic) |d| self.deterministic = d;
        }
        if (!self.cli_set.synctex) {
            if (config.synctex) |s| self.synctex = s;
        }
        // config.entry: handled in do_compile (input_file fallback)
        // config.files: handled in do_compile (extra search dirs)
    }
};

// -- diagnostic handler (unified output channel) --
// routes engine diagnostics through stderr with severity prefix.
// on WASM, stderr is captured by the JS worker and classified by content.
// on native, messages go directly to the terminal.

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
    // engine terminal output already prints warnings -- suppress to avoid duplicates.
    // if we need structured warning capture later, route through here.
}

fn on_diag_error(text: []const u8) void {
    _ = text;
    // engine terminal output already prints errors -- suppress to avoid duplicates.
}

fn on_diag_info(text: []const u8) void {
    diag_write_stderr(text);
}

const default_diag_handler = bridge.World.DiagnosticHandler{
    .on_warning = on_diag_warning,
    .on_error = on_diag_error,
    .on_info = on_diag_info,
};

// -- format discovery and file helpers --

fn find_format_path(cache_dir: []const u8, buf: []u8, format_name: []const u8) ?[]const u8 {
    var dir_buf: [1024]u8 = undefined;
    const formats_path = std.fmt.bufPrint(&dir_buf, "{s}/formats", .{cache_dir}) catch return null;
    var dir = fs.openDirAbsolute(formats_path, .{ .iterate = true }) catch return null;
    defer dir.close();

    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".fmt")) continue;
        // match by name: "plain.fmt" for plain, "*latex*.fmt" for latex
        if (std.mem.indexOf(u8, entry.name, format_name) != null) {
            return std.fmt.bufPrint(buf, "{s}/{s}", .{ formats_path, entry.name }) catch return null;
        }
    }
    return null;
}

fn copy_file_from_absolute(src_abs: []const u8, dest_rel: []const u8) void {
    const src_dir_path = fs_path.dirname(src_abs) orelse return;
    const src_base = fs_path.basename(src_abs);
    var src_dir = fs.openDirAbsolute(src_dir_path, .{}) catch return;
    defer src_dir.close();
    src_dir.copyFile(src_base, fs.cwd(), dest_rel, .{}) catch {};
}

fn copy_file_to_cache_dir(cache_dir: []const u8, src_rel: []const u8, dest_rel: []const u8) void {
    var cache = fs.openDirAbsolute(cache_dir, .{}) catch return;
    defer cache.close();
    if (fs_path.dirname(dest_rel)) |parent| {
        cache.makePath(parent) catch {};
    }
    fs.cwd().copyFile(src_rel, cache, dest_rel, .{}) catch {};
}

// -- argument parsing --

fn parse_args() Options {
    var opts = Options{};
    var args = if (is_wasm) (std.process.argsWithAllocator(std.heap.c_allocator) catch return opts) else std.process.args();
    _ = args.next(); // skip argv[0]

    const cmd_str = args.next() orelse return opts;

    if (std.mem.eql(u8, cmd_str, "compile")) {
        opts.command = .compile;
    } else if (std.mem.eql(u8, cmd_str, "watch")) {
        opts.command = .watch;
    } else if (std.mem.eql(u8, cmd_str, "generate-format")) {
        opts.command = .generate_format;
    } else if (std.mem.eql(u8, cmd_str, "init")) {
        opts.command = .init;
        return opts;
    } else if (std.mem.eql(u8, cmd_str, "help") or std.mem.eql(u8, cmd_str, "--help") or std.mem.eql(u8, cmd_str, "-h")) {
        opts.command = .help;
        return opts;
    } else if (std.mem.eql(u8, cmd_str, "version") or std.mem.eql(u8, cmd_str, "--version")) {
        opts.command = .version;
        return opts;
    } else if (cmd_str.len > 0 and cmd_str[0] == '-') {
        // unknown flag at command position
        Log.log("eztex", .err, "unknown option '{s}'", .{cmd_str});
        return opts;
    } else {
        // treat bare argument as implicit "compile <file>"
        opts.command = .compile;
        opts.input_file = cmd_str;
    }

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--single-pass")) {
            opts.pass_mode = .single;
            opts.cli_set.pass_mode = true;
        } else if (std.mem.eql(u8, arg, "--passes")) {
            if (args.next()) |val| {
                const n = std.fmt.parseInt(u8, val, 10) catch {
                    Log.log("eztex", .err, "--passes requires a number (1-10), got '{s}'", .{val});
                    opts.command = .help;
                    return opts;
                };
                if (n == 0 or n > 10) {
                    Log.log("eztex", .err, "--passes must be between 1 and 10", .{});
                    opts.command = .help;
                    return opts;
                }
                opts.pass_mode = .{ .fixed = n };
                opts.cli_set.pass_mode = true;
            } else {
                Log.log("eztex", .err, "--passes requires a value", .{});
                opts.command = .help;
                return opts;
            }
        } else if (std.mem.eql(u8, arg, "--output") or std.mem.eql(u8, arg, "-o")) {
            opts.output_file = args.next();
            opts.cli_set.output_file = true;
            if (opts.output_file == null) {
                Log.log("eztex", .err, "{s} requires a value", .{arg});
                opts.command = .help;
                return opts;
            }
        } else if (std.mem.eql(u8, arg, "--keep-intermediates")) {
            opts.keep_intermediates = true;
            opts.cli_set.keep_intermediates = true;
        } else if (std.mem.eql(u8, arg, "--format")) {
            if (args.next()) |val| {
                if (std.mem.eql(u8, val, "latex") or std.mem.eql(u8, val, "xelatex")) {
                    opts.format = .latex;
                } else if (std.mem.eql(u8, val, "plain")) {
                    opts.format = .plain;
                } else {
                    Log.log("eztex", .err, "--format must be 'latex' or 'plain', got '{s}'", .{val});
                    opts.command = .help;
                    return opts;
                }
                opts.cli_set.format = true;
            } else {
                Log.log("eztex", .err, "--format requires a value (latex or plain)", .{});
                opts.command = .help;
                return opts;
            }
        } else if (std.mem.eql(u8, arg, "--verbose") or std.mem.eql(u8, arg, "-v")) {
            opts.verbose = true;
        } else if (std.mem.eql(u8, arg, "--paper")) {
            if (args.next()) |val| {
                opts.paper = val;
                opts.cli_set.paper = true;
            } else {
                Log.log("eztex", .err, "--paper requires a value (e.g. letter, a4, 210mm,297mm)", .{});
                opts.command = .help;
                return opts;
            }
        } else if (std.mem.eql(u8, arg, "--cache-dir")) {
            if (args.next()) |val| {
                opts.cache_dir = val;
            } else {
                Log.log("eztex", .err, "--cache-dir requires a path", .{});
                opts.command = .help;
                return opts;
            }
        } else if (std.mem.eql(u8, arg, "--deterministic")) {
            opts.deterministic = true;
            opts.cli_set.deterministic = true;
        } else if (std.mem.eql(u8, arg, "--synctex")) {
            opts.synctex = true;
            opts.cli_set.synctex = true;
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            opts.command = .help;
            return opts;
        } else if (arg.len > 0 and arg[0] == '-') {
            Log.log("eztex", .err, "unknown option '{s}'", .{arg});
            opts.command = .help;
            return opts;
        } else {
            // positional argument = input file
            if (opts.input_file == null) {
                opts.input_file = arg;
            } else {
                Log.log("eztex", .err, "unexpected argument '{s}'", .{arg});
                opts.command = .help;
                return opts;
            }
        }
    }

    return opts;
}

fn print_usage() void {
    const usage =
        \\eztex - TeX compiler (xetex engine, zig bridge)
        \\
        \\usage:
        \\  eztex compile <file.tex> [options]    compile a document
        \\  eztex compile <directory/> [options]   compile a project directory
        \\  eztex compile <project.zip> [options]  compile from zip archive
        \\  eztex <file.tex> [options]             shorthand for compile
        \\  eztex watch <file.tex> [options]       watch and recompile on changes
        \\  eztex init                             create eztex.zon in current directory
        \\  eztex help                             show this help
        \\  eztex version                          show version
        \\
        \\compile options:
        \\  --output, -o <file.pdf>     output path (default: <input>.pdf)
        \\  --format <latex|plain>      TeX format (default: latex)
        \\  --paper <spec>              paper size for PDF (default: letter)
        \\  --single-pass               force single xetex pass
        \\  --passes <n>                force exactly n xetex passes (1-10)
        \\  --deterministic             reproducible output (stable tags + timestamps)
        \\  --synctex                   enable synctex source references
        \\  --keep-intermediates        keep .aux, .log, .xdv files
        \\  --cache-dir <path>           override cache directory (native only)
        \\  --verbose, -v               show pass details and engine output
        \\  --help, -h                  show this help
        \\
        \\project mode:
        \\  pass a directory or .zip file to auto-detect the main .tex file.
        \\  detection heuristics: single .tex file, \documentclass, known names
        \\  (main.tex, thesis.tex, paper.tex, etc.), or alphabetically first.
        \\  use eztex.zon with .entry field to override detection.
        \\
        \\examples:
        \\  eztex compile paper.tex
        \\  eztex compile paper.tex --passes 3
        \\  eztex compile paper.tex -o output.pdf --verbose
        \\  eztex paper.tex --single-pass --keep-intermediates
        \\  eztex compile ./my-thesis/
        \\  eztex compile project.zip
        \\  eztex compile                          (uses main from eztex.zon)
        \\
    ;
    var buf: [4096]u8 = undefined;
    var w = Log.stderr_writer(&buf);
    const iface = &w.interface;
    iface.writeAll(usage) catch {};
    iface.flush() catch {};
}

fn print_version() void {
    Log.log("eztex", .info, "eztex 0.1.0 (xetex engine, zig bridge)", .{});
}

// -- stem / path utilities --

fn get_stem(input_file: []const u8) []const u8 {
    return if (std.mem.endsWith(u8, input_file, ".tex"))
        input_file[0 .. input_file.len - 4]
    else
        input_file;
}

// get the jobname: basename without extension (what xetex uses for output files)
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

// -- engine exit codes (from xetex-xetexd.h) --
const HISTORY_SPOTLESS: c_int = 0;
const HISTORY_WARNING_ISSUED: c_int = 1;
const HISTORY_ERROR_ISSUED: c_int = 2;
const HISTORY_FATAL_ERROR: c_int = 3;

fn xetex_succeeded(result: c_int) bool {
    return result == HISTORY_SPOTLESS or result == HISTORY_WARNING_ISSUED;
}

// -- engine invocation --

fn run_xetex(world: *bridge.World, input_file: []const u8, format: Format, _: bool, opts: *const Options) c_int {
    set_engine_var(.synctex, opts.synctex);
    set_engine_var(.halt_on_error, true);

    var input_name_buf: [512]u8 = undefined;
    const input_name_len = @min(input_file.len, input_name_buf.len - 1);
    @memcpy(input_name_buf[0..input_name_len], input_file[0..input_name_len]);
    input_name_buf[input_name_len] = 0;
    const input_name_z: [*:0]const u8 = input_name_buf[0..input_name_len :0];

    Log.dbg("eztex", "calling tt_engine_xetex_main (format={s})...", .{format.fmt_filename()});

    const result = tt_engine_xetex_main(
        @ptrCast(world),
        format.dump_name(),
        input_name_z,
        if (opts.deterministic) 1 else 0,
    );

    Log.dbg("eztex", "xetex returned: {d}", .{result});
    return result;
}

fn run_xdvipdfmx(world: *bridge.World, xdv_name: []const u8, pdf_name: []const u8, _: bool, opts: *const Options) c_int {
    var xdv_buf: [512]u8 = undefined;
    var pdf_buf: [512]u8 = undefined;
    var paper_buf: [128]u8 = undefined;

    @memcpy(xdv_buf[0..xdv_name.len], xdv_name);
    xdv_buf[xdv_name.len] = 0;
    const xdv_z: [*:0]const u8 = xdv_buf[0..xdv_name.len :0];

    @memcpy(pdf_buf[0..pdf_name.len], pdf_name);
    pdf_buf[pdf_name.len] = 0;
    const pdf_z: [*:0]const u8 = pdf_buf[0..pdf_name.len :0];

    if (opts.paper.len == 0) {
        Log.log("eztex", .err, "--paper must be non-empty", .{});
        return 1;
    }
    if (opts.paper.len >= paper_buf.len) {
        Log.log("eztex", .err, "--paper value too long (max {d} bytes)", .{paper_buf.len - 1});
        return 1;
    }
    @memcpy(paper_buf[0..opts.paper.len], opts.paper);
    paper_buf[opts.paper.len] = 0;
    const paper_z: [*:0]const u8 = paper_buf[0..opts.paper.len :0];

    const config = XdvipdfmxConfig{
        .paperspec = paper_z,
        .enable_compression = 1,
        .deterministic_tags = if (opts.deterministic) 1 else 0,
        .build_date = if (opts.deterministic) 1 else 0,
    };

    Log.log("eztex", .info, "calling xdvipdfmx('{s}' -> '{s}')...", .{ xdv_name, pdf_name });

    const result = tt_engine_xdvipdfmx_main(
        @ptrCast(world),
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

// -- bibtex invocation --

fn run_bibtex(world: *bridge.World, aux_name: []const u8, _: bool) c_int {
    var aux_buf: [512]u8 = undefined;
    const name_len = @min(aux_name.len, aux_buf.len - 1);
    @memcpy(aux_buf[0..name_len], aux_name[0..name_len]);
    aux_buf[name_len] = 0;
    const aux_z: [*:0]const u8 = aux_buf[0..name_len :0];

    Log.log("eztex", .info, "running bibtex on '{s}'...", .{aux_name});

    reset_world_io();
    const result = bibtex_main(@ptrCast(world), aux_z);

    Log.dbg("eztex", "bibtex returned: {d}", .{result});
    return result;
}

// scan aux file contents for markers that indicate bibtex/biblatex processing is needed.
// traditional bibtex: \bibdata{...}, \bibstyle{...}
// biblatex: \abx@aux@refcontext, \abx@aux@cite, \abx@aux@defaultrefcontext, etc.
fn aux_needs_bibtex(aux_contents: ?[]const u8) bool {
    const content = aux_contents orelse return false;
    return std.mem.indexOf(u8, content, "\\bibdata{") != null or
        std.mem.indexOf(u8, content, "\\bibstyle{") != null or
        std.mem.indexOf(u8, content, "\\abx@aux@") != null;
}

// -- plain format generation --
// plain.fmt is generated by running the engine in initex mode with plain.tex as input.
// the format file is cached in the eztex cache directory for reuse.

var g_plain_fmt_buf: [1024]u8 = undefined;

fn setup_plain_format(world: *bridge.World, cache_dir: []const u8, _: bool) void {
    // check if plain.fmt already exists in cache
    var cached_path_buf: [1024]u8 = undefined;
    const cached_path = std.fmt.bufPrint(&cached_path_buf, "{s}/formats/plain.fmt", .{cache_dir}) catch return;

    if (fs.cwd().access(cached_path, .{})) |_| {
        Log.dbg("eztex", "found cached plain.fmt: {s}", .{cached_path});
        fs.cwd().deleteFile("tmp/plain.fmt") catch {};
        posix.symlink(cached_path, "tmp/plain.fmt") catch |err| {
            Log.dbg("eztex", "warning: symlink failed: {}, copying instead", .{err});
            fs.cwd().copyFile(cached_path, fs.cwd(), "tmp/plain.fmt", .{}) catch {};
        };
        return;
    } else |_| {}

    // check if plain.fmt exists in tmp/ from a previous run
    if (fs.cwd().access("tmp/plain.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing tmp/plain.fmt", .{});
        return;
    } else |_| {}

    // generate plain.fmt using initex mode
    // write a wrapper file that inputs plain.tex (from bundle) and dumps the format
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

    // set up for initex mode
    set_engine_var(.initex_mode, true);
    set_engine_var(.halt_on_error, true);
    set_engine_var(.synctex, false);

    world.set_primary_input(initex_input);
    world.set_output_dir("tmp");

    Log.dbg("eztex", "running initex to generate plain.fmt...", .{});

    const result = tt_engine_xetex_main(
        @ptrCast(world),
        "plain", // dump name -- output will be "plain.fmt"
        "_make_plain_fmt.tex",
        0,
    );

    // reset initex mode for subsequent runs
    set_engine_var(.initex_mode, false);

    // clean up the wrapper file
    fs.cwd().deleteFile(initex_input) catch {};

    if (xetex_succeeded(result)) {
        // the engine derives format output name from job name (input filename),
        // so _make_plain_fmt.tex produces _make_plain_fmt.fmt -- rename it
        fs.cwd().rename("tmp/_make_plain_fmt.fmt", "tmp/plain.fmt") catch |err| {
            Log.log("eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io();
            return;
        };

        // clean up the initex log file
        fs.cwd().deleteFile("tmp/_make_plain_fmt.log") catch {};

        Log.log("eztex", .info, "plain.fmt generated successfully", .{});

        // cache the generated format for future use
        copy_file_to_cache_dir(cache_dir, "tmp/plain.fmt", "formats/plain.fmt");
    } else {
        Log.log("eztex", .warn, "failed to generate plain.fmt (exit code {d})", .{result});
        // clean up any partial output
        fs.cwd().deleteFile("tmp/_make_plain_fmt.fmt") catch {};
        fs.cwd().deleteFile("tmp/_make_plain_fmt.log") catch {};
    }

    // reset I/O for the actual compilation
    world.reset_io();
}

// -- xelatex format generation --
// generates xelatex.fmt by running the engine in initex mode with latex.ltx.
// the bundle provides tectonic-format-latex.tex which does \input latex.ltx.
// the format file is cached for reuse across compilations.

fn generate_xelatex_format(world: *bridge.World, cache_dir: ?[]const u8, _: bool) void {
    // check if xelatex.fmt exists in tmp/ from a previous run
    if (fs.cwd().access("tmp/xelatex.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing tmp/xelatex.fmt", .{});
        return;
    } else |_| {}

    // check root dir (WASM: format may be pre-loaded from OPFS by JS host)
    if (fs.cwd().access("xelatex.fmt", .{})) |_| {
        Log.dbg("eztex", "found existing xelatex.fmt", .{});
        return;
    } else |_| {}

    if (is_wasm) {
        Log.log("eztex", .info, "generating xelatex.fmt (first run, may take several minutes in browser)...", .{});
    } else {
        Log.log("eztex", .info, "generating xelatex.fmt (first time only, may take a minute)...", .{});
    }

    // tectonic-format-latex.tex is the entry point that inputs latex.ltx
    // this file is fetched from the bundle on demand by the BundleStore
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

    // set up for initex mode
    set_engine_var(.initex_mode, true);
    set_engine_var(.halt_on_error, true);
    set_engine_var(.synctex, false);

    world.set_primary_input(initex_input);
    world.set_output_dir("tmp");

    Log.dbg("eztex", "running initex to generate xelatex.fmt...", .{});

    const result = tt_engine_xetex_main(
        @ptrCast(world),
        "xelatex",
        "_make_xelatex_fmt.tex",
        0,
    );

    // reset initex mode for subsequent runs
    set_engine_var(.initex_mode, false);

    // clean up the wrapper file
    fs.cwd().deleteFile(initex_input) catch {};

    if (xetex_succeeded(result)) {
        // engine uses job name for format output: _make_xelatex_fmt.tex -> _make_xelatex_fmt.fmt
        fs.cwd().rename("tmp/_make_xelatex_fmt.fmt", "tmp/xelatex.fmt") catch |err| {
            Log.log("eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io();
            return;
        };

        // clean up initex log
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.log") catch {};

        Log.log("eztex", .info, "xelatex.fmt generated successfully", .{});

        // cache for future use (skip on WASM where cache_dir is null)
        if (cache_dir) |cdir| {
            copy_file_to_cache_dir(cdir, "tmp/xelatex.fmt", "formats/xelatex.fmt");
        }
    } else {
        Log.log("eztex", .warn, "failed to generate xelatex.fmt (exit code {d})", .{result});
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.fmt") catch {};
        fs.cwd().deleteFile("tmp/_make_xelatex_fmt.log") catch {};
    }

    // reset I/O for the actual compilation
    world.reset_io();
}

// -- world setup --
var g_fmt_buf: [1024]u8 = undefined;

fn setup_world(format: Format, verbose: bool, cache_dir_override: ?[]const u8) void {
    const world = bridge.get_world();
    world.add_search_dir(".");

    // set up unified diagnostic handler (prevents duplicate output)
    bridge.set_diagnostic_handler(default_diag_handler);

    // enable debug logging if --verbose was set
    Log.set_debug(verbose);

    // platform-specific setup: cache discovery + PM init (native) or JS host init (WASM)
    const cache_dir = Host.setup(world, verbose, cache_dir_override);

    fs.cwd().makeDir("tmp") catch {};

    if (format == .latex) {
        if (cache_dir) |cdir| {
            // native: look for cached xelatex.fmt
            if (find_format_path(cdir, &g_fmt_buf, "latex")) |fmt_path| {
                Log.dbg("eztex", "found format file: {s}", .{fmt_path});
                fs.cwd().deleteFile("tmp/xelatex.fmt") catch {};
                posix.symlink(fmt_path, "tmp/xelatex.fmt") catch |err| {
                    Log.dbg("eztex", "warning: symlink failed: {}, copying instead", .{err});
                    copy_file_from_absolute(fmt_path, "tmp/xelatex.fmt");
                };
            } else {
                // format not cached -- prefetch format gen seed files before generating
                if (!is_wasm) {
                    seed_cache(&seeds.xelatex_fmt, verbose);
                }
                generate_xelatex_format(world, cache_dir, verbose);
            }
        } else {
            // WASM: no cache dir, generate directly (JS host may have pre-loaded from OPFS)
            generate_xelatex_format(world, null, verbose);
        }
    } else if (format == .plain) {
        if (cache_dir) |cdir| {
            setup_plain_format(world, cdir, verbose);
        }
    }
    world.add_search_dir("tmp");
}

const default_seed_concurrency: usize = 6;

// batch seed files via BundleStore.
// guard: WASM seeding is managed by JS host, not during Zig startup.
fn seed_cache(names: []const []const u8, _: bool) void {
    if (is_wasm) return;
    const bs = bridge.get_bundle_store();
    const result = bs.seed_cache(names, default_seed_concurrency);
    Log.dbg("eztex", "seed: {d} fetched, {d} cached, {d} unknown, {d} failed", .{
        result.fetched, result.skipped_cached, result.skipped_unknown, result.failed,
    });
}

fn reset_world_io() void {
    bridge.get_world().reset_io();
}

// -- cleanup --

fn cleanup_intermediates(stem: []const u8) void {
    const extensions = [_][]const u8{
        ".aux", // aux references
        ".log", // compilation log
        ".xdv", // xdv intermediate
        ".lof", // list of figures
        ".lot", // list of tables
        ".out", // hyperref bookmarks
        ".toc", // table of contents
        ".bbl", // bibliography output
        ".blg", // bibtex log
        ".nav", // beamer navigation
        ".snm", // beamer snowman
        ".vrb", // beamer verbatim
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

// -- watch command --

fn do_watch(opts: Options) u8 {
    if (is_wasm) {
        Log.log("eztex", .err, "watch mode is not supported on WASM", .{});
        return 1;
    }

    const input_file = opts.input_file orelse {
        Log.log("eztex", .err, "no input file specified", .{});
        print_usage();
        return 1;
    };

    // resolve project input to get watch directory
    const project = resolve_project_input(std.heap.c_allocator, input_file, opts.verbose) orelse return 1;
    defer if (project.temp_dir) |tmp| {
        fs.cwd().deleteTree(tmp) catch {};
    };

    // verify resolved tex file exists
    fs.cwd().access(project.tex_file, .{}) catch {
        Log.log("eztex", .err, "input file '{s}' not found", .{project.tex_file});
        return 1;
    };

    // determine watch directory: project dir, or dirname of input file, or cwd
    const watch_root = project.project_dir orelse fs_path.dirname(project.tex_file) orelse ".";

    const Watcher = @import("Watcher.zig");
    var watcher = Watcher.init(std.heap.c_allocator) catch |err| {
        Log.log("eztex", .err, "failed to initialize file watcher: {}", .{err});
        return 1;
    };
    defer watcher.deinit();

    // set up initial watches
    watcher.watch_dir_recursive(watch_root) catch |err| {
        Log.log("eztex", .err, "failed to watch directory '{s}': {}", .{ watch_root, err });
        return 1;
    };

    Log.log("eztex", .info, "watching '{s}' ({d} files) for changes... (Ctrl+C to stop)", .{ watch_root, watcher.watched_count() });

    // initial compile
    Log.log("eztex", .info, "initial compile...", .{});
    _ = do_compile(&opts, null);

    // event loop with 200ms debounce
    const debounce_ms: u32 = 200;
    while (true) {
        // block until a filesystem event (or 60s timeout to keep things alive)
        const got_event = watcher.wait_for_event(60_000) catch |err| {
            Log.log("eztex", .warn, "watcher error: {}", .{err});
            // fall back to a short sleep and retry
            std.Thread.sleep(1000 * std.time.ns_per_ms);
            continue;
        };
        if (!got_event) continue;

        // debounce: wait for changes to settle (editors may write multiple times)
        while (true) {
            const more = watcher.wait_for_event(debounce_ms) catch break;
            if (!more) break;
        }

        Log.log("eztex", .info, "change detected, recompiling...", .{});
        _ = do_compile(&opts, null);

        // reset watches to pick up any new files created by compilation or user
        watcher.reset();
        watcher.watch_dir_recursive(watch_root) catch |err| {
            Log.log("eztex", .warn, "failed to re-watch directory: {}", .{err});
        };
        Log.dbg("eztex", "re-watching {d} files", .{watcher.watched_count()});
    }
}

// -- init command --

fn do_init() u8 {
    const config_filename = Config.filename;
    fs.cwd().access(config_filename, .{}) catch |err| switch (err) {
        error.FileNotFound => {
            // file doesn't exist, create it
            const template =
                \\.{
                \\    .entry = "main.tex",
                \\}
                \\
            ;
            const file = fs.cwd().createFile(config_filename, .{ .exclusive = true }) catch |e| {
                Log.log("eztex", .err, "failed to create {s}: {}", .{ config_filename, e });
                return 1;
            };
            defer file.close();
            file.writeAll(template) catch |e| {
                Log.log("eztex", .err, "failed to write {s}: {}", .{ config_filename, e });
                return 1;
            };
            Log.log("eztex", .info, "created {s}", .{config_filename});
            return 0;
        },
        else => {
            Log.log("eztex", .err, "cannot check {s}: {}", .{ config_filename, err });
            return 1;
        },
    };
    // file exists (access succeeded)
    Log.log("eztex", .err, "{s} already exists", .{config_filename});
    return 1;
}

// -- compile command --

const ProjectInput = struct {
    // resolved .tex file path to compile
    tex_file: []const u8,
    // directory to chdir into before compiling (for project mode)
    project_dir: ?[]const u8 = null,
    // temp directory to clean up after compile (for zip mode)
    temp_dir: ?[]const u8 = null,
    // original cwd to restore after project mode compile
    original_cwd: ?fs.Dir = null,
};

// detect whether input is a directory, zip file, or plain .tex file.
// for directories: scan for main .tex file using heuristics.
// for zip files: extract to temp dir, then scan for main .tex file.
// returns resolved ProjectInput or null on error.
fn resolve_project_input(alloc: std.mem.Allocator, input: []const u8, verbose: bool) ?ProjectInput {
    // check if input is a directory
    if (is_directory(input)) {
        return resolve_directory_project(alloc, input, verbose);
    }

    // check if input is a .zip file
    if (std.mem.endsWith(u8, input, ".zip")) {
        return resolve_zip_project(alloc, input, verbose);
    }

    // plain .tex file (or other) -- pass through as-is
    return ProjectInput{ .tex_file = input };
}

fn is_directory(path: []const u8) bool {
    const stat = fs.cwd().statFile(path) catch return false;
    return stat.kind == .directory;
}

fn resolve_directory_project(alloc: std.mem.Allocator, dir_path: []const u8, _: bool) ?ProjectInput {
    Log.dbg("eztex", "project mode: scanning directory '{s}'", .{dir_path});

    var dir = fs.cwd().openDir(dir_path, .{ .iterate = true }) catch |err| {
        Log.log("eztex", .err, "cannot open directory '{s}': {}", .{ dir_path, err });
        return null;
    };
    defer dir.close();

    // collect filenames
    var files: std.ArrayList([]const u8) = .empty;
    defer {
        for (files.items) |f| alloc.free(f);
        files.deinit(alloc);
    }

    var iter = dir.iterate();
    while (iter.next() catch null) |entry| {
        if (entry.kind != .file and entry.kind != .sym_link) continue;
        const name = alloc.dupe(u8, entry.name) catch continue;
        files.append(alloc, name) catch {
            alloc.free(name);
            continue;
        };
    }

    if (files.items.len == 0) {
        Log.log("eztex", .err, "directory '{s}' contains no files", .{dir_path});
        return null;
    }

    // read callback for \documentclass scanning
    const Ctx = struct {
        dir: fs.Dir,
        fn read_file(self_dir: fs.Dir, name: []const u8) ?[]const u8 {
            const file = self_dir.openFile(name, .{}) catch return null;
            defer file.close();
            return file.readToEndAlloc(std.heap.c_allocator, 4096) catch null;
        }
    };
    _ = Ctx;

    // use MainDetect (without read_fn for simplicity -- heuristics 1,3,4 are usually enough)
    // we can't easily pass a closure with captured dir, so use null read_fn
    const main_file = MainDetect.detect(alloc, files.items, null) orelse {
        Log.log("eztex", .err, "no main .tex file found in '{s}'", .{dir_path});
        return null;
    };

    // build full path: dir_path/main_file
    var path_buf: [1024]u8 = undefined;
    const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir_path, main_file }) catch {
        Log.log("eztex", .err, "path too long", .{});
        return null;
    };
    // dupe to stable memory
    const result_path = alloc.dupe(u8, full_path) catch return null;

    Log.log("eztex", .info, "project mode: detected main file '{s}'", .{main_file});
    return ProjectInput{
        .tex_file = result_path,
        .project_dir = dir_path,
    };
}

fn resolve_zip_project(alloc: std.mem.Allocator, zip_path: []const u8, _: bool) ?ProjectInput {
    Log.dbg("eztex", "project mode: extracting zip '{s}'", .{zip_path});

    // create temp directory for extraction
    const tmp_dir_path = "tmp/zip_extract";
    // clean any previous extraction
    fs.cwd().deleteTree(tmp_dir_path) catch {};
    fs.cwd().makePath(tmp_dir_path) catch |err| {
        Log.log("eztex", .err, "cannot create temp directory: {}", .{err});
        return null;
    };

    // open zip file
    const zip_file = fs.cwd().openFile(zip_path, .{}) catch |err| {
        Log.log("eztex", .err, "cannot open zip file '{s}': {}", .{ zip_path, err });
        return null;
    };
    defer zip_file.close();

    // open dest directory
    var dest_dir = fs.cwd().openDir(tmp_dir_path, .{ .iterate = true }) catch |err| {
        Log.log("eztex", .err, "cannot open temp directory: {}", .{err});
        return null;
    };
    defer dest_dir.close();

    // extract using std.zip
    var read_buf: [64 * 1024]u8 = undefined;
    var file_reader = fs.File.Reader.init(zip_file, &read_buf);
    std.zip.extract(dest_dir, &file_reader, .{}) catch |err| {
        Log.log("eztex", .err, "zip extraction failed: {}", .{err});
        return null;
    };

    Log.dbg("eztex", "zip extracted to '{s}'", .{tmp_dir_path});

    // collect extracted filenames
    var files: std.ArrayList([]const u8) = .empty;
    defer {
        for (files.items) |f| alloc.free(f);
        files.deinit(alloc);
    }

    var dir_iter = dest_dir.iterate();
    while (dir_iter.next() catch null) |entry| {
        if (entry.kind != .file and entry.kind != .sym_link) continue;
        const name = alloc.dupe(u8, entry.name) catch continue;
        files.append(alloc, name) catch {
            alloc.free(name);
            continue;
        };
    }

    if (files.items.len == 0) {
        Log.log("eztex", .err, "zip file '{s}' contains no files", .{zip_path});
        return null;
    }

    const main_file = MainDetect.detect(alloc, files.items, null) orelse {
        Log.log("eztex", .err, "no main .tex file found in zip '{s}'", .{zip_path});
        return null;
    };

    // build full path: tmp_dir/main_file
    var path_buf: [1024]u8 = undefined;
    const full_path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ tmp_dir_path, main_file }) catch {
        Log.log("eztex", .err, "path too long", .{});
        return null;
    };
    const result_path = alloc.dupe(u8, full_path) catch return null;

    Log.log("eztex", .info, "project mode: detected main file '{s}' from zip", .{main_file});
    return ProjectInput{
        .tex_file = result_path,
        .project_dir = tmp_dir_path,
        .temp_dir = tmp_dir_path,
    };
}

fn do_compile(opts: *const Options, loaded_config: ?Config) u8 {
    const raw_input = opts.input_file orelse {
        Log.log("eztex", .err, "no input file specified", .{});
        print_usage();
        return 1;
    };

    // resolve project input (directory, zip, or plain file)
    const project = if (!is_wasm)
        resolve_project_input(std.heap.c_allocator, raw_input, opts.verbose) orelse return 1
    else
        ProjectInput{ .tex_file = raw_input };

    // clean up temp dir on exit (for zip projects)
    defer if (project.temp_dir) |tmp| {
        fs.cwd().deleteTree(tmp) catch {};
    };

    const input_file = project.tex_file;

    // verify input exists
    fs.cwd().access(input_file, .{}) catch {
        Log.log("eztex", .err, "input file '{s}' not found", .{input_file});
        return 1;
    };

    // jobname = basename without extension (what xetex uses for output filenames)
    // e.g. "examples/q2report.tex" -> "q2report"
    // intermediate files (.xdv, .aux, .log) are written to output_dir using jobname
    const jobname = get_jobname(input_file);

    // input_dir is used for placing the final PDF next to the source file
    const input_dir = fs_path.dirname(input_file);

    const verbose = opts.verbose;
    const format = opts.format;

    Log.log("eztex", .info, "compiling '{s}' (format: {s})", .{ input_file, format.fmt_filename() });

    setup_world(format, verbose, opts.cache_dir);

    // apply bundle URL/digest override from config if present
    if (loaded_config) |config| {
        const bundle = config.effective_bundle();
        const bs = bridge.get_bundle_store();
        const is_custom_url = !std.mem.eql(u8, bundle.url, Config.default_bundle_url);
        const is_custom_index = !std.mem.eql(u8, bundle.index_url, Config.default_index_url);
        const is_custom_digest = !std.mem.eql(u8, bundle.digest, &Config.default_bundle_digest);
        if (is_custom_url or is_custom_index) {
            bs.url = bundle.url;
            Host.init(null, bundle.url, bundle.index_url, bs.digest);
            Log.dbg("eztex", "bundle URL override: {s}", .{bundle.url});
            if (is_custom_index) {
                Log.dbg("eztex", "index URL override: {s}", .{bundle.index_url});
            }
        }
        if (is_custom_digest) {
            bs.digest = bundle.digest;
            Log.dbg("eztex", "bundle digest override: {s}", .{bundle.digest});
        }
    }

    const world = bridge.get_world();
    world.set_primary_input(input_file);

    // seed compile-time init files
    if (!is_wasm) {
        seed_cache(&seeds.init, verbose);
    }

    // add input file's directory as a search path so \input and \include work
    if (input_dir) |idir| {
        world.add_search_dir(idir);
        Log.dbg("eztex", "added input directory to search path: {s}", .{idir});
    }

    world.set_output_dir(".");

    // determine pass count
    const max_passes: u8 = switch (opts.pass_mode) {
        .single => 1,
        .fixed => |n| n,
        .auto => Options.max_auto_passes,
    };
    const is_auto = opts.pass_mode == .auto;

    // intermediate files use jobname (basename), since output_dir is "."
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
        // display pass info
        if (is_auto) {
            Log.log("eztex", .info, "pass {d} (auto, max {d})...", .{ pass + 1, max_passes });
        } else {
            Log.log("eztex", .info, "pass {d}/{d}...", .{ pass + 1, max_passes });
        }

        // reset I/O handles between passes (keep bundle/search config)
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

        // fixed/single mode: just run the requested number of passes
        if (!is_auto) continue;

        // auto mode: compare aux file after this pass to the previous pass
        const curr_aux = read_file_contents(aux_path);

        if (pass == 0) {
            if (curr_aux == null) {
                // no aux produced = simple doc, one pass is enough
                Log.log("eztex", .info, "no aux file produced, single pass sufficient", .{});
                break;
            }

            // run bibtex if the aux file requests it (has \bibdata{ or \bibstyle{)
            if (!bibtex_ran and aux_needs_bibtex(curr_aux)) {
                Log.log("eztex", .info, "aux file contains bibliography commands, running bibtex...", .{});
                const bib_result = run_bibtex(world, aux_path, verbose);
                bibtex_ran = true;
                if (!xetex_succeeded(bib_result)) {
                    Log.log("eztex", .info, "bibtex failed (exit code {d}), continuing without bibliography", .{bib_result});
                }
            }

            // first pass produced aux; save it and do at least one more
            prev_aux = curr_aux;
            Log.dbg("eztex", "aux file produced, will check stability on next pass", .{});
        } else {
            // compare with previous pass
            if (!aux_changed(prev_aux, curr_aux)) {
                free_file_contents(curr_aux);
                Log.log("eztex", .info, "aux file stable after pass {d}, done", .{pass + 1});
                break;
            }
            // changed: save new version, continue
            free_file_contents(prev_aux);
            prev_aux = curr_aux;
            Log.dbg("eztex", "aux file changed, another pass needed", .{});
        }
    }

    // convert XDV -> PDF only if last xetex pass succeeded
    if (xetex_succeeded(last_xetex_result)) {
        var xdv_buf: [512]u8 = undefined;
        var pdf_buf: [512]u8 = undefined;

        // xdv file is in output_dir (cwd) with jobname as basename
        const xdv_name = std.fmt.bufPrint(&xdv_buf, "{s}.xdv", .{jobname}) catch {
            Log.log("eztex", .err, "filename too long for xdv", .{});
            bridge.deinit_bundle_store();
            return 1;
        };

        // pdf output also goes to cwd first, then we move it
        const pdf_name = std.fmt.bufPrint(&pdf_buf, "{s}.pdf", .{jobname}) catch {
            Log.log("eztex", .err, "filename too long for pdf", .{});
            bridge.deinit_bundle_store();
            return 1;
        };

        // reset I/O for the pdf conversion pass
        reset_world_io();

        const pdf_result = run_xdvipdfmx(world, xdv_name, pdf_name, verbose, opts);

        if (pdf_result != 0) {
            Log.log("eztex", .info, "xdvipdfmx failed (exit code {d})", .{pdf_result});
            bridge.deinit_bundle_store();
            return 1;
        }

        // determine final output path:
        // - if --output/-o given, use that
        // - for zip projects: place PDF in cwd (not inside temp dir)
        // - otherwise, place PDF next to the input file (e.g. examples/q2report.pdf)
        var final_pdf_buf: [512]u8 = undefined;
        const final_pdf = if (opts.output_file) |out|
            out
        else if (project.temp_dir != null)
            pdf_name // zip project: keep in cwd
        else if (input_dir) |idir|
            std.fmt.bufPrint(&final_pdf_buf, "{s}/{s}.pdf", .{ idir, jobname }) catch pdf_name
        else
            pdf_name;

        // move pdf to final location if different from where it was written
        if (!std.mem.eql(u8, pdf_name, final_pdf)) {
            rename_output(jobname, final_pdf);
        }

        // if synctex was enabled, move the synctex sidecar next to the final PDF
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

    // cleanup intermediate files (in cwd, using jobname)
    if (!opts.keep_intermediates and xetex_succeeded(last_xetex_result)) {
        cleanup_intermediates(jobname);

        // remove any stale synctex output when synctex is disabled
        if (!opts.synctex) {
            var synctex_buf: [512]u8 = undefined;
            const synctex_path = std.fmt.bufPrint(&synctex_buf, "{s}.synctex.gz", .{jobname}) catch null;
            if (synctex_path) |p| fs.cwd().deleteFile(p) catch {};
        }

        Log.dbg("eztex", "cleaned up intermediate files", .{});
    }

    bridge.deinit_bundle_store();

    if (!xetex_succeeded(last_xetex_result)) return 1;
    return 0;
}

// -- generate-format command --
// generates xelatex.fmt without compiling a document.
// on WASM, JS calls wasi.start() with ["eztex", "generate-format"] args.
// this avoids the JS-side workaround of compiling a trivial document.

fn do_generate_format(opts: *const Options) u8 {
    const verbose = opts.verbose;
    const format = opts.format;

    Log.log("eztex", .info, "generating {s} format...", .{format.fmt_filename()});

    setup_world(format, verbose, opts.cache_dir);
    defer bridge.deinit_bundle_store();

    // setup_world already handles format generation (checks cache, generates if needed)
    // verify the format file exists
    const fmt_path = if (format == .latex) "tmp/xelatex.fmt" else "tmp/plain.fmt";
    fs.cwd().access(fmt_path, .{}) catch {
        Log.log("eztex", .err, "format generation failed -- {s} not found", .{fmt_path});
        return 1;
    };

    Log.log("eztex", .info, "{s} ready", .{format.fmt_filename()});
    return 0;
}

// -- entry point --

pub fn main() u8 {
    var opts = parse_args();

    // load eztex.zon config from input file's directory (if present)
    // works on both native (filesystem) and WASM (WASI cwd); missing config is fine
    var loaded_config: ?Config = null;
    if (opts.input_file) |input| {
        const config_dir = fs_path.dirname(input);
        if (Config.load(std.heap.c_allocator, config_dir)) |maybe_config| {
            if (maybe_config) |config| {
                // config.entry: fallback if no input file on CLI (already have one here)
                opts.apply_config(config);
                loaded_config = config;
                // note: config strings are from c_allocator, valid for program lifetime
            }
        } else |_| {}
    } else if (opts.command == .compile or opts.command == .init) {
        // no input file specified; try loading config from cwd for .entry
        if (Config.load(std.heap.c_allocator, null)) |maybe_config| {
            if (maybe_config) |config| {
                if (config.entry) |main_file| {
                    opts.input_file = main_file;
                }
                opts.apply_config(config);
                loaded_config = config;
            }
        } else |_| {}
    }

    switch (opts.command) {
        .help => {
            print_usage();
            return 0;
        },
        .version => {
            print_version();
            return 0;
        },
        .init => return do_init(),
        .watch => return do_watch(opts),
        .compile => return do_compile(&opts, loaded_config),
        .generate_format => return do_generate_format(&opts),
    }
}
