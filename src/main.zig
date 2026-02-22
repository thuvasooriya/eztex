const std = @import("std");
const fs = std.fs;
const fs_path = std.fs.path;
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const Config = @import("Config.zig");
const Compiler = @import("Compiler.zig");
const Watcher = @import("Watcher.zig");

const Format = Compiler.Format;

// -- CLI types --

const Command = enum {
    compile,
    watch,
    generate_format,
    init,
    help,
    version,
};

const Options = struct {
    command: Command = .help,
    input_file: ?[]const u8 = null,
    output_file: ?[]const u8 = null,
    format: Format = .latex,
    keep_intermediates: bool = false,
    verbose: bool = false,
    cache_dir: ?[]const u8 = null,
    deterministic: bool = false,
    synctex: bool = false,
    cli_set: CliSet = .{},

    const CliSet = packed struct {
        output_file: bool = false,
        format: bool = false,
        keep_intermediates: bool = false,
        deterministic: bool = false,
        synctex: bool = false,
    };

    fn apply_config(self: *Options, config: Config) void {
        if (!self.cli_set.output_file) {
            if (config.output) |o| self.output_file = o;
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
        if (!self.cli_set.deterministic) {
            if (config.deterministic) |d| self.deterministic = d;
        }
        if (!self.cli_set.synctex) {
            if (config.synctex) |s| self.synctex = s;
        }
    }

    fn to_compile_config(self: *const Options) Compiler.CompileConfig {
        return .{
            .input_file = self.input_file,
            .output_file = self.output_file,
            .format = self.format,
            .keep_intermediates = self.keep_intermediates,
            .verbose = self.verbose,
            .deterministic = self.deterministic,
            .synctex = self.synctex,
            .cache_dir = self.cache_dir,
        };
    }
};

// -- argument parsing --

fn parse_args() Options {
    const is_wasm = Host.is_wasm;
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
        Log.log("eztex", .err, "unknown option '{s}'", .{cmd_str});
        return opts;
    } else {
        opts.command = .compile;
        opts.input_file = cmd_str;
    }

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--output") or std.mem.eql(u8, arg, "-o")) {
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
        \\  eztex compile paper.tex -o output.pdf --verbose
        \\  eztex paper.tex --keep-intermediates
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

// -- init command --

fn do_init() u8 {
    const config_filename = Config.filename;
    fs.cwd().access(config_filename, .{}) catch |err| switch (err) {
        error.FileNotFound => {
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
    Log.log("eztex", .err, "{s} already exists", .{config_filename});
    return 1;
}

// -- entry point --

pub fn main() u8 {
    var opts = parse_args();

    var loaded_config: ?Config = null;
    if (opts.input_file) |input| {
        const config_dir = fs_path.dirname(input);
        if (Config.load(std.heap.c_allocator, config_dir)) |maybe_config| {
            if (maybe_config) |config| {
                opts.apply_config(config);
                loaded_config = config;
            }
        } else |_| {}
    } else if (opts.command == .compile or opts.command == .init) {
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
        .watch => return Watcher.do_watch(opts.to_compile_config()),
        .compile => {
            const cc = opts.to_compile_config();
            return Compiler.compile(&cc, loaded_config);
        },
        .generate_format => {
            const cc = opts.to_compile_config();
            return Compiler.generate_format(&cc);
        },
    }
}
