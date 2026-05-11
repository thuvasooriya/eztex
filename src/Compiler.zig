const Compiler = @This();
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const testing = std.testing;
const fs_path = std.fs.path;
const Bridge = @import("Engine.zig");
const EngineApi = @import("EngineInterface.zig");
const Log = @import("Log.zig");
const Host = @import("Host.zig");
const is_wasm = Host.is_wasm;
const Config = @import("Config.zig");
const FormatCache = @import("FormatCache.zig");
const Runtime = @import("Runtime.zig");
const seeds = @import("seeds.zig");
const Project = @import("Project.zig");
const diag = @import("compile/diagnostics.zig");
const aux = @import("compile/aux.zig");

pub const Backend = enum {
    xetex,
    pdftex,
};

pub const CompileMode = enum {
    preview,
    full,
};

pub const backend: Backend = .xetex;

pub fn engine_display_name(comptime b: Backend) []const u8 {
    return switch (b) {
        .xetex => "tectonic-zig",
        .pdftex => "pdftex",
    };
}

pub const Format = EngineApi.Format;
const engine_serial: u32 = 33;

pub const CompileConfig = struct {
    input_file: ?[]const u8 = null,
    output_file: ?[]const u8 = null,
    mode: CompileMode = .full,
    format: Format = .latex,
    keep_intermediates: bool = false,
    verbose: bool = false,
    deterministic: bool = false,
    paperspec: []const u8 = "letter",
    synctex: bool = false,
    cache_dir: ?[]const u8 = null,
};

pub const max_auto_passes: u8 = 5;
pub const max_preview_passes: u8 = 2;

const stabilization_extensions = [_][]const u8{
    ".aux",
    ".toc",
    ".out",
    ".nav",
    ".snm",
    ".lof",
    ".lot",
    ".vrb",
};

const aux_stabilization_index = 0;

const HISTORY_SPOTLESS: c_int = 0;
const HISTORY_WARNING_ISSUED: c_int = 1;

fn xetex_succeeded(result: c_int) bool {
    return result == HISTORY_SPOTLESS or result == HISTORY_WARNING_ISSUED;
}

const default_diag_handler = diag.default_diag_handler;
const diag_write_with_severity = diag.diag_write_with_severity;
const read_file_contents = aux.read_file_contents;
const free_file_contents = aux.free_file_contents;
const aux_changed = aux.aux_changed;
const aux_is_biblatex = aux.aux_is_biblatex;
const aux_needs_bibtex = aux.aux_needs_bibtex;
const bibliography_state = aux.bibliography_state;
const read_bibliography_state = aux.read_bibliography_state;
const write_bibliography_state = aux.write_bibliography_state;
const bib_inputs_changed = aux.bib_inputs_changed;
const bib_citations_changed = aux.bib_citations_changed;

const unsupported_biblatex_message = "BibLaTeX/biber documents are not yet supported. Please use classic BibTeX (\\bibliography + \\bibliographystyle) instead.";

const BibliographyAction = enum {
    none,
    run_bibtex,
    unsupported_biblatex,
};

fn bibliography_action(io: Io, aux_path: []const u8, aux_contents: ?[]const u8) BibliographyAction {
    if (aux_needs_bibtex(io, aux_path, aux_contents)) return .run_bibtex;
    if (aux_is_biblatex(io, aux_path, aux_contents)) return .unsupported_biblatex;
    return .none;
}

fn preview_needs_bibtex(io: Io, bbl_path: []const u8, current_state: ?aux.BibliographyState, bib_state_path: []const u8) bool {
    if (current_state == null) return true;

    if (Io.Dir.cwd().access(io, bbl_path, .{})) |_| {
        const previous_state = read_bibliography_state(io, bib_state_path);
        return bib_inputs_changed(current_state, previous_state) or bib_citations_changed(current_state, previous_state);
    } else |_| {
        return true;
    }
}

fn persist_bibliography_state(io: Io, path: []const u8, state: ?aux.BibliographyState) void {
    const bib_state = state orelse return;
    write_bibliography_state(io, path, bib_state) catch |err| {
        Log.dbg(io, "eztex", "failed to persist bibliography state '{s}': {}", .{ path, err });
    };
}

fn on_checkpoint(_: ?*anyopaque, id: c_int) void {
    _ = id;
}

fn get_stem(input_file: []const u8) []const u8 {
    return if (std.mem.endsWith(u8, input_file, ".tex"))
        input_file[0 .. input_file.len - 4]
    else
        input_file;
}

fn get_jobname(input_file: []const u8) []const u8 {
    return get_stem(fs_path.basename(input_file));
}

fn find_format_path(io: Io, cache_dir: []const u8, buf: []u8, format_name: []const u8) ?[]const u8 {
    var dir_buf: [1024]u8 = undefined;
    const formats_path = std.fmt.bufPrint(&dir_buf, "{s}/formats", .{cache_dir}) catch return null;
    var dir = Io.Dir.openDirAbsolute(io, formats_path, .{ .iterate = true }) catch return null;
    defer dir.close(io);

    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (entry.kind != .file or std.mem.indexOf(u8, entry.name, ".fmt") == null) continue;
        if (std.mem.indexOf(u8, entry.name, format_name) != null) {
            return std.fmt.bufPrint(buf, "{s}/{s}", .{ formats_path, entry.name }) catch return null;
        }
    }
    return null;
}

fn current_build_date(deterministic: bool) u64 {
    if (deterministic) return 1;
    if (builtin.os.tag == .windows) {
        const windows = std.os.windows;
        const GetSystemTimeAsFileTime = @extern(*const fn (*windows.FILETIME) callconv(std.builtin.CallingConvention.winapi) void, .{ .name = "GetSystemTimeAsFileTime", .library_name = "kernel32" });
        var ft: windows.FILETIME = undefined;
        GetSystemTimeAsFileTime(&ft);
        const combined: u64 = (@as(u64, ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
        const unix_100ns = combined -% 116_444_736_000_000_000;
        return @intCast(unix_100ns / 10_000_000);
    }
    var ts: std.posix.timespec = undefined;
    const rc = std.posix.system.clock_gettime(std.posix.CLOCK.REALTIME, &ts);
    if (rc != 0) return 1;
    return @intCast(@max(ts.sec, 0));
}

fn create_default_engine(io: Io, world: *Bridge.World, opts: *const CompileConfig) !EngineApi.Engine {
    const cfg = EngineApi.EngineConfig{
        .allocator = std.heap.c_allocator,
        .io = io,
        .world = world,
        .format = opts.format,
        .build_date = current_build_date(opts.deterministic),
        .deterministic = opts.deterministic,
        .paperspec = opts.paperspec,
    };
    return EngineApi.tectonic.create(&cfg);
}

fn run_engine(engine: EngineApi.Engine, input_file: []const u8, format: Format, opts: *const CompileConfig) !EngineApi.EngineResult {
    try engine.setFormat(format);
    try engine.setVariable(.synctex, .{ .boolean = opts.synctex });
    try engine.setVariable(.halt_on_error, .{ .boolean = true });
    try engine.setPrimaryInput(input_file);
    return engine.run();
}

fn run_bibtex(io: Io, engine: EngineApi.Engine, aux_name: []const u8) EngineApi.EngineResult {
    return engine.runBibtex(aux_name) catch |err| {
        Log.log(io, "eztex", .err, "bibtex failed to start: {}", .{err});
        return .{ .code = 3 };
    };
}

fn run_initex(io: Io, world: *Bridge.World, engine: EngineApi.Engine, format: Format, force: bool) void {
    const fmt_path = engine.generatedFormatPath(format);

    if (force) {
        Io.Dir.cwd().deleteFile(io, fmt_path) catch {};
        Io.Dir.cwd().deleteFile(io, engine.formatFileName(format)) catch {};
    } else {
        if (Io.Dir.cwd().access(io, fmt_path, .{})) |_| {
            Log.dbg(io, "eztex", "found existing {s}", .{fmt_path});
            return;
        } else |_| {}

        if (format == .latex) {
            if (Io.Dir.cwd().access(io, engine.formatFileName(format), .{})) |_| {
                Log.dbg(io, "eztex", "found existing {s}", .{engine.formatFileName(format)});
                return;
            } else |_| {}
        }
    }

    Log.log(io, "eztex", .info, "generating {s} (first time only)...", .{engine.formatFileName(format)});

    const initex_input = engine.initexInput(format);
    const file = Io.Dir.cwd().createFile(io, initex_input, .{}) catch |err| {
        Log.log(io, "eztex", .err, "failed to create initex input: {}", .{err});
        return;
    };
    file.writeStreamingAll(io, engine.initexContent(format)) catch |err| {
        file.close(io);
        Log.log(io, "eztex", .err, "failed to write initex input: {}", .{err});
        return;
    };
    file.close(io);

    engine.prepareInitex("tmp") catch |err| {
        Io.Dir.cwd().deleteFile(io, initex_input) catch {};
        Log.log(io, "eztex", .err, "failed to prepare initex: {}", .{err});
        return;
    };

    engine.setFormat(format) catch |err| {
        engine.finishInitex() catch {};
        Io.Dir.cwd().deleteFile(io, initex_input) catch {};
        Log.log(io, "eztex", .err, "failed to set initex format: {}", .{err});
        return;
    };

    engine.setPrimaryInput(engine.initexBasename(format)) catch |err| {
        engine.finishInitex() catch {};
        Io.Dir.cwd().deleteFile(io, initex_input) catch {};
        Log.log(io, "eztex", .err, "failed to set initex input: {}", .{err});
        return;
    };

    Log.dbg(io, "eztex", "running initex to generate {s}...", .{engine.formatFileName(format)});

    const result = engine.run() catch |err| blk: {
        Log.log(io, "eztex", .err, "initex failed to start: {}", .{err});
        break :blk EngineApi.EngineResult{ .code = 3 };
    };

    engine.finishInitex() catch {};
    Io.Dir.cwd().deleteFile(io, initex_input) catch {};

    if (result.succeeded()) {
        Io.Dir.cwd().rename(engine.initexOutputFile(format), Io.Dir.cwd(), fmt_path, io) catch |err| {
            Log.log(io, "eztex", .err, "failed to rename format file: {}", .{err});
            world.reset_io(io);
            return;
        };
        Io.Dir.cwd().deleteFile(io, engine.initexLogFile(format)) catch {};
        Log.log(io, "eztex", .info, "{s} generated successfully", .{engine.formatFileName(format)});
    } else {
        Log.log(io, "eztex", .warn, "failed to generate {s} (exit code {d})", .{ engine.formatFileName(format), result.code });
        Io.Dir.cwd().deleteFile(io, engine.initexOutputFile(format)) catch {};
        Io.Dir.cwd().deleteFile(io, engine.initexLogFile(format)) catch {};
    }

    world.reset_io(io);
}

var g_fmt_buf: [1024]u8 = undefined;
var g_format_bytes: ?[]u8 = null;
var g_format_key: ?FormatCache.Key = null;

fn format_cache_type(format: Format) FormatCache.FormatType {
    return switch (backend) {
        .xetex => switch (format) {
            .latex => .xelatex,
            .plain => .plain,
        },
        .pdftex => switch (format) {
            .latex => .pdflatex,
            .plain => .plain,
        },
    };
}

fn make_format_cache_key(format: Format, active_digest: *const [64]u8) FormatCache.Key {
    var digest_bytes: [32]u8 = undefined;
    for (0..32) |i| {
        const hi = hex_digit(active_digest[i * 2]);
        const lo = hex_digit(active_digest[i * 2 + 1]);
        digest_bytes[i] = (hi << 4) | lo;
    }
    return .{
        .bundle_digest = digest_bytes,
        .engine_version = @intCast(engine_serial),
        .format_type = format_cache_type(format),
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

fn try_load_cached_format(io: Io, world: *Bridge.World, engine: EngineApi.Engine, cache_dir: []const u8, format: Format, active_digest: *const [64]u8) bool {
    const fmt_filename = engine.formatFileName(format);
    const key = make_format_cache_key(format, active_digest);

    if (g_format_bytes) |bytes| {
        if (g_format_key) |cached_key| {
            const key_matches = std.mem.eql(u8, &cached_key.bundle_digest, &key.bundle_digest) and
                cached_key.engine_version == key.engine_version and
                cached_key.format_type == key.format_type;
            if (key_matches) {
                world.set_format_data(bytes, fmt_filename);
                Log.dbg(io, "eztex", "reusing in-memory format ({d} bytes)", .{bytes.len});
                return true;
            }
        }
        // Different key, will load new one (old will be freed when new is set)
    }

    if (FormatCache.load(io, std.heap.c_allocator, cache_dir, key) catch null) |bytes| {
        set_format_memory(world, bytes, fmt_filename, key);
        Log.dbg(io, "eztex", "loaded format from content-addressed cache ({d} bytes, memory-backed)", .{bytes.len});
        return true;
    }

    if (find_format_path(io, cache_dir, &g_fmt_buf, if (format == .latex) "latex" else "plain")) |fmt_path| {
        Log.dbg(io, "eztex", "loading legacy format file: {s}", .{fmt_path});
        // Read file using Io API (same pattern as FormatCache.zig)
        const file = Io.Dir.openFileAbsolute(io, fmt_path, .{}) catch {
            Log.dbg(io, "eztex", "failed to open legacy format file: {s}", .{fmt_path});
            return false;
        };
        defer file.close(io);
        const stat = file.stat(io) catch {
            Log.dbg(io, "eztex", "failed to stat legacy format file: {s}", .{fmt_path});
            return false;
        };
        const size: usize = @intCast(stat.size);
        Log.dbg(io, "eztex", "legacy format file size: {d} bytes", .{size});
        if (size == 0) {
            Log.dbg(io, "eztex", "legacy format file is empty: {s}", .{fmt_path});
            return false;
        }
        const bytes = std.heap.c_allocator.alloc(u8, size) catch {
            Log.dbg(io, "eztex", "failed to allocate for format file: {s}", .{fmt_path});
            return false;
        };
        const bytes_read = file.readPositionalAll(io, bytes, 0) catch {
            std.heap.c_allocator.free(bytes);
            Log.dbg(io, "eztex", "failed to read legacy format file: {s}", .{fmt_path});
            return false;
        };
        if (bytes_read != size) {
            std.heap.c_allocator.free(bytes);
            Log.dbg(io, "eztex", "short read of format file: {d}/{d} bytes", .{ bytes_read, size });
            return false;
        }
        set_format_memory(world, bytes, fmt_filename, key);
        Log.dbg(io, "eztex", "loaded legacy format into memory ({d} bytes)", .{bytes.len});
        return true;
    }

    return false;
}

fn set_format_memory(world: *Bridge.World, bytes: []u8, name: []const u8, key: FormatCache.Key) void {
    // Take ownership of bytes (caller must transfer ownership to us)
    // Free old format data unconditionally when overwriting
    if (g_format_bytes) |old| {
        std.heap.c_allocator.free(old);
    }
    g_format_bytes = bytes;
    g_format_key = key;
    world.set_format_data(bytes, name);
}

fn clear_format_memory(world: *Bridge.World) void {
    if (g_format_bytes) |old| {
        std.heap.c_allocator.free(old);
        g_format_bytes = null;
    }
    g_format_key = null;
    world.clear_format_data();
}

fn cache_generated_format(io: Io, engine: EngineApi.Engine, cache_dir: []const u8, format: Format, key: FormatCache.Key) void {
    const file = Io.Dir.cwd().openFile(io, engine.generatedFormatPath(format), .{}) catch return;
    defer file.close(io);
    const stat = file.stat(io) catch return;
    if (stat.size == 0) return;

    const size: usize = @intCast(stat.size);
    const bytes = std.heap.c_allocator.alloc(u8, size) catch return;
    defer std.heap.c_allocator.free(bytes);

    const n = file.readPositionalAll(io, bytes, 0) catch return;
    if (n != size) return;

    FormatCache.store(io, std.heap.c_allocator, cache_dir, key, bytes) catch |err| {
        Log.dbg(io, "eztex", "failed to cache format: {}", .{err});
    };
}

fn load_generated_format(io: Io, world: *Bridge.World, engine: EngineApi.Engine, format: Format, key: FormatCache.Key) bool {
    const gen_path = engine.generatedFormatPath(format);
    const file = Io.Dir.cwd().openFile(io, gen_path, .{}) catch return false;
    defer file.close(io);
    const stat = file.stat(io) catch return false;
    if (stat.size == 0) return false;

    const size: usize = @intCast(stat.size);
    const bytes = std.heap.c_allocator.alloc(u8, size) catch return false;
    errdefer std.heap.c_allocator.free(bytes);

    const n = file.readPositionalAll(io, bytes, 0) catch {
        std.heap.c_allocator.free(bytes);
        return false;
    };
    if (n != size) {
        std.heap.c_allocator.free(bytes);
        return false;
    }

    set_format_memory(world, bytes, engine.formatFileName(format), key);
    return true;
}

fn setup_world(io: Io, engine: EngineApi.Engine, format: Format, verbose: bool, cache_dir_override: ?[]const u8, bundle: Config.ResolvedBundle, bundle_digest: *const [64]u8, deterministic: bool) void {
    const world = Bridge.get_world();
    world.reset_search_dirs();
    world.add_search_dir(".");
    world.deterministic_mtime = if (deterministic) 1 else null;

    Bridge.set_diagnostic_handler(default_diag_handler);
    Bridge.set_checkpoint_callback(.{
        .func = &on_checkpoint,
        .userdata = null,
    });

    Log.set_debug(verbose);

    const cache_dir = Host.setup(world, verbose, cache_dir_override, bundle.url, bundle.index_url, bundle_digest);

    Io.Dir.cwd().createDir(io, "tmp", Io.Dir.Permissions.default_dir) catch {};
    world.add_search_dir("tmp");

    const key = make_format_cache_key(format, bundle_digest);

    if (cache_dir) |cdir| {
        if (!try_load_cached_format(io, world, engine, cdir, format, bundle_digest)) {
            clear_format_memory(world);
            if (!is_wasm and format == .latex) seed_cache(io, &seeds.xelatex_fmt);
            run_initex(io, world, engine, format, true);
            if (load_generated_format(io, world, engine, format, key)) {
                cache_generated_format(io, engine, cdir, format, key);
            }
        }
    } else {
        clear_format_memory(world);
        run_initex(io, world, engine, format, false);
        _ = load_generated_format(io, world, engine, format, key);
    }
}

const default_seed_concurrency: usize = 6;

fn seed_cache(io: Io, names: []const []const u8) void {
    if (is_wasm) return;
    const bs = Bridge.get_bundle_store();
    const result = bs.seed_cache(io, names, default_seed_concurrency);
    Log.dbg(io, "eztex", "seed: {d} fetched, {d} cached, {d} unknown, {d} failed", .{
        result.fetched, result.skipped_cached, result.skipped_unknown, result.failed,
    });
}

fn reset_world_io(io: Io) void {
    Bridge.get_world().reset_io(io);
}

fn cleanup_intermediates(io: Io, stem: []const u8) void {
    const extensions = [_][]const u8{
        ".aux", ".log", ".xdv", ".lof", ".lot", ".out",
        ".toc", ".bbl", ".blg", ".bibstate", ".nav", ".snm", ".vrb",
    };
    for (extensions) |ext| {
        var buf: [512]u8 = undefined;
        const path = std.fmt.bufPrint(&buf, "{s}{s}", .{ stem, ext }) catch continue;
        Io.Dir.cwd().deleteFile(io, path) catch {};
    }
}

fn rename_output(io: Io, stem: []const u8, output_file: []const u8) void {
    var default_buf: [512]u8 = undefined;
    const default_pdf = std.fmt.bufPrint(&default_buf, "{s}.pdf", .{stem}) catch return;
    if (std.mem.eql(u8, default_pdf, output_file)) return;
    Io.Dir.cwd().rename(default_pdf, Io.Dir.cwd(), output_file, io) catch |err| {
        Log.log(io, "eztex", .err, "failed to rename output to '{s}': {}", .{ output_file, err });
    };
}

const StabilizationSnapshot = struct {
    files: [stabilization_extensions.len]?[]const u8 = std.mem.zeroes([stabilization_extensions.len]?[]const u8),

    fn deinit(self: *StabilizationSnapshot) void {
        for (&self.files) |*contents| {
            free_file_contents(contents.*);
            contents.* = null;
        }
    }
};

const StabilizationStatus = struct {
    aux_stable: bool,
    all_stable: bool,
    changed_extension: ?[]const u8,
};

fn build_job_file_path(buf: []u8, jobname: []const u8, ext: []const u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "{s}{s}", .{ jobname, ext });
}

fn read_stabilization_snapshot(io: Io, jobname: []const u8) !StabilizationSnapshot {
    var snapshot = StabilizationSnapshot{};
    errdefer snapshot.deinit();

    inline for (stabilization_extensions, 0..) |ext, i| {
        var path_buf: [512]u8 = undefined;
        const path = try build_job_file_path(&path_buf, jobname, ext);
        snapshot.files[i] = read_file_contents(io, path);
    }

    return snapshot;
}

fn compare_stabilization_snapshots(prev: *const StabilizationSnapshot, curr: *const StabilizationSnapshot) StabilizationStatus {
    if (aux_changed(prev.files[aux_stabilization_index], curr.files[aux_stabilization_index])) {
        return .{
            .aux_stable = false,
            .all_stable = false,
            .changed_extension = stabilization_extensions[aux_stabilization_index],
        };
    }

    inline for (stabilization_extensions, 0..) |ext, i| {
        if (i == aux_stabilization_index) continue;
        if (aux_changed(prev.files[i], curr.files[i])) {
            return .{
                .aux_stable = true,
                .all_stable = false,
                .changed_extension = ext,
            };
        }
    }

    return .{
        .aux_stable = true,
        .all_stable = true,
        .changed_extension = null,
    };
}

pub fn compile(io: Io, opts: *const CompileConfig, loaded_config: ?Config) u8 {
    const world = Bridge.get_world();
    var engine = create_default_engine(io, world, opts) catch |err| {
        Log.log(io, "eztex", .err, "failed to create engine: {}", .{err});
        return 1;
    };
    defer engine.destroy();
    return compileWithEngine(io, opts, loaded_config, engine);
}

pub fn compileWithEngine(io: Io, opts: *const CompileConfig, loaded_config: ?Config, engine: EngineApi.Engine) u8 {
    const old_engine = if (Runtime.instance) |rt| rt.active_engine else null;
    if (Runtime.instance) |rt| rt.active_engine = engine;
    defer {
        if (Runtime.instance) |rt| rt.active_engine = old_engine;
    }

    const raw_input = opts.input_file orelse {
        Log.log(io, "eztex", .err, "no input file specified", .{});
        return 1;
    };

    const project = if (!is_wasm)
        Project.resolve_project_input(io, std.heap.c_allocator, raw_input, opts.verbose) orelse return 1
    else
        Project.ProjectInput{ .tex_file = raw_input };

    defer if (project.temp_dir) |tmp| {
        Io.Dir.cwd().deleteTree(io, tmp) catch {};
    };

    const input_file = project.tex_file;

    Io.Dir.cwd().access(io, input_file, .{}) catch {
        Log.log(io, "eztex", .err, "input file '{s}' not found", .{input_file});
        return 1;
    };

    const jobname = get_jobname(input_file);
    const input_dir = fs_path.dirname(input_file);
    const verbose = opts.verbose;
    const format = opts.format;

    Log.log(io, "eztex", .info, "compiling '{s}' (mode: {s}, engine: {s}, format: {s})", .{
        input_file,
        @tagName(opts.mode),
        engine.name(),
        engine.formatFileName(format),
    });

    const bundle = if (loaded_config) |config|
        config.effective_bundle()
    else
        Config.default().effective_bundle();
    const bundle_digest = Config.digest_from_url(bundle.url);

    const is_custom_url = !std.mem.eql(u8, bundle.url, Config.default_bundle_url);
    const is_custom_index = !std.mem.eql(u8, bundle.index_url, Config.default_index_url);
    if (is_custom_url) {
        Log.dbg(io, "eztex", "bundle URL override: {s}", .{bundle.url});
    }
    if (is_custom_index) {
        Log.dbg(io, "eztex", "index URL override: {s}", .{bundle.index_url});
    }

    setup_world(io, engine, format, verbose, opts.cache_dir, bundle, &bundle_digest, opts.deterministic);

    const world = Bridge.get_world();

    if (!is_wasm) {
        seed_cache(io, &seeds.init);
    }

    if (input_dir) |idir| {
        world.add_search_dir(idir);
        Log.dbg(io, "eztex", "added input directory to search path: {s}", .{idir});
    }

    world.set_output_dir(".");

    const max_passes: u8 = if (opts.mode == .preview) max_preview_passes else max_auto_passes;

    var aux_path_buf: [512]u8 = undefined;
    const aux_path = std.fmt.bufPrint(&aux_path_buf, "{s}.aux", .{jobname}) catch {
        Log.log(io, "eztex", .err, "jobname too long", .{});
        return 1;
    };

    var bbl_path_buf: [512]u8 = undefined;
    const bbl_path = std.fmt.bufPrint(&bbl_path_buf, "{s}.bbl", .{jobname}) catch {
        Log.log(io, "eztex", .err, "jobname too long", .{});
        return 1;
    };

    var bib_state_path_buf: [512]u8 = undefined;
    const bib_state_path = std.fmt.bufPrint(&bib_state_path_buf, "{s}.bibstate", .{jobname}) catch {
        Log.log(io, "eztex", .err, "jobname too long", .{});
        return 1;
    };

    var prev_snapshot: ?StabilizationSnapshot = null;
    defer if (prev_snapshot) |*snapshot| snapshot.deinit();

    var last_result = EngineApi.EngineResult{ .code = -1 };
    var pass: u8 = 0;
    var total_passes: u8 = 0;
    var bibtex_ran = false;
    var aux_stable = false;
    var stabilization_stable = false;

    while (pass < max_passes) : (pass += 1) {
        Log.dbg(io, "eztex", "pass {d} (auto, max {d})...", .{ pass + 1, max_passes });

        if (pass > 0) reset_world_io(io);

        last_result = run_engine(engine, input_file, format, opts) catch |err| {
            Log.log(io, "eztex", .err, "engine failed to start on pass {d}: {}", .{ pass + 1, err });
            break;
        };
        total_passes = pass + 1;

        if (!last_result.succeeded()) {
            Log.log(io, "eztex", .err, "{s} failed on pass {d} (exit code {d})", .{ engine.name(), pass + 1, last_result.code });
            const msg_slice = engine.errorMessage();
            if (msg_slice.len > 0) {
                diag_write_with_severity(io, msg_slice, "error");
            }
            break;
        }

        if (last_result.code == HISTORY_WARNING_ISSUED) {
            Log.dbg(io, "eztex", "pass {d} completed with warnings", .{pass + 1});
        }

        var curr_snapshot = read_stabilization_snapshot(io, jobname) catch |err| {
            Log.log(io, "eztex", .err, "failed to read stabilization files after pass {d}: {}", .{ pass + 1, err });
            last_result = .{ .code = 3 };
            break;
        };
        const curr_aux = curr_snapshot.files[aux_stabilization_index];

        if (pass == 0) {
            if (curr_aux == null) {
                aux_stable = true;
                stabilization_stable = true;
                curr_snapshot.deinit();
                Log.log(io, "eztex", .info, "no aux file produced, single pass sufficient", .{});
                break;
            }

            const bib_action = bibliography_action(io, aux_path, curr_aux);
            const needs_bibtex = bib_action == .run_bibtex;
            const current_bib_state = if (needs_bibtex) bibliography_state(io, aux_path, curr_aux) else null;

            if (bib_action == .unsupported_biblatex) {
                last_result = .{ .code = 3 };
                Log.log(io, "eztex", .err, "{s}", .{unsupported_biblatex_message});
                curr_snapshot.deinit();
                break;
            }

            if (!bibtex_ran and needs_bibtex) {
                const should_run_bibtex = switch (opts.mode) {
                    .full => true,
                    .preview => preview_needs_bibtex(io, bbl_path, current_bib_state, bib_state_path),
                };

                if (should_run_bibtex) {
                    Log.log(io, "eztex", .info, "aux file contains bibliography commands, running bibtex...", .{});
                    const bib_result = run_bibtex(io, engine, aux_path);
                    bibtex_ran = true;
                    if (!bib_result.succeeded()) {
                        last_result = bib_result;
                        Log.log(io, "eztex", .err, "bibtex failed (exit code {d})", .{bib_result.code});

                        const msg_slice = engine.errorMessage();
                        if (msg_slice.len > 0) {
                            diag_write_with_severity(io, msg_slice, "error");
                        }

                        var blg_buf: [512]u8 = undefined;
                        const blg_path = std.fmt.bufPrint(&blg_buf, "{s}.blg", .{jobname}) catch null;
                        if (blg_path) |path| {
                            if (Io.Dir.cwd().access(io, path, .{})) |_| {
                                Log.log(io, "eztex", .info, "preserved bibtex log: {s}", .{path});
                            } else |_| {}
                        }

                        curr_snapshot.deinit();
                        break;
                    }

                    persist_bibliography_state(io, bib_state_path, current_bib_state);
                } else {
                    Log.dbg(io, "eztex", "preview mode reusing persisted bibliography outputs", .{});
                }
            }

            prev_snapshot = curr_snapshot;
            Log.dbg(io, "eztex", "stabilization files produced, will check stability on next pass", .{});
        } else {
            const status = compare_stabilization_snapshots(&prev_snapshot.?, &curr_snapshot);
            aux_stable = status.aux_stable;

            if (status.all_stable) {
                stabilization_stable = true;
                curr_snapshot.deinit();
                Log.log(io, "eztex", .info, "stabilization files stable after pass {d}, done", .{pass + 1});
                break;
            }

            if (prev_snapshot) |*snapshot| snapshot.deinit();
            prev_snapshot = curr_snapshot;

            if (status.changed_extension) |ext| {
                if (status.aux_stable) {
                    Log.dbg(io, "eztex", "aux file stable but {s} changed, another pass needed", .{ext});
                } else {
                    Log.dbg(io, "eztex", "aux file changed, another pass needed", .{});
                }
            }
        }
    }

    if (opts.mode == .preview and last_result.succeeded() and !stabilization_stable and total_passes == max_passes) {
        Log.log(io, "eztex", .info, "preview mode stopped after {d} passes before stabilization files converged", .{total_passes});
    }

    if (last_result.succeeded()) {
        var pdf_buf: [512]u8 = undefined;
        const pdf_name = std.fmt.bufPrint(&pdf_buf, "{s}.pdf", .{jobname}) catch {
            Log.log(io, "eztex", .err, "filename too long for pdf", .{});
            Bridge.deinit_bundle_store();
            return 1;
        };

        if (engine.outputFormat() == .xdv) {
            var xdv_buf: [512]u8 = undefined;
            const xdv_name = std.fmt.bufPrint(&xdv_buf, "{s}.xdv", .{jobname}) catch {
                Log.log(io, "eztex", .err, "filename too long for xdv", .{});
                Bridge.deinit_bundle_store();
                return 1;
            };

            reset_world_io(io);

            const pdf_result = engine.postProcess(xdv_name, pdf_name) catch |err| {
                Log.log(io, "eztex", .err, "post-processing failed to start: {}", .{err});
                Bridge.deinit_bundle_store();
                return 1;
            };

            if (pdf_result.code != 0) {
                Log.log(io, "eztex", .err, "post-processing failed (exit code {d})", .{pdf_result.code});
                const msg_slice = engine.errorMessage();
                if (msg_slice.len > 0) {
                    Log.log(io, "eztex", .err, "post-processing abort reason: {s}", .{msg_slice});
                }
                Bridge.deinit_bundle_store();
                return 1;
            }
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
            rename_output(io, jobname, final_pdf);
        }

        if (opts.synctex) {
            if (fs_path.dirname(final_pdf)) |out_dir| {
                if (!std.mem.eql(u8, out_dir, ".")) {
                    var synctex_src_buf: [512]u8 = undefined;
                    const synctex_src = std.fmt.bufPrint(&synctex_src_buf, "{s}.synctex.gz", .{jobname}) catch null;
                    if (synctex_src) |src| {
                        Io.Dir.cwd().createDirPath(io, out_dir) catch {};
                        var synctex_dst_buf: [512]u8 = undefined;
                        const synctex_dst = std.fmt.bufPrint(&synctex_dst_buf, "{s}/{s}.synctex.gz", .{ out_dir, jobname }) catch null;
                        if (synctex_dst) |dst| {
                            if (!std.mem.eql(u8, src, dst)) {
                                Io.Dir.cwd().rename(src, Io.Dir.cwd(), dst, io) catch {};
                            }
                        }
                    }
                }
            }
        }

        Log.log(io, "eztex", .info, "output: {s} ({d} pass{s})", .{
            final_pdf,
            total_passes,
            if (total_passes == 1) @as([]const u8, "") else "es",
        });
    }

    if (!opts.keep_intermediates and xetex_succeeded(last_result.code)) {
        cleanup_intermediates(io, jobname);

        if (!opts.synctex) {
            var synctex_buf: [512]u8 = undefined;
            const synctex_path = std.fmt.bufPrint(&synctex_buf, "{s}.synctex.gz", .{jobname}) catch null;
            if (synctex_path) |p| Io.Dir.cwd().deleteFile(io, p) catch {};
        }

        Log.dbg(io, "eztex", "cleaned up intermediate files", .{});
    }

    Bridge.deinit_bundle_store();

    if (!last_result.succeeded()) return 1;
    return 0;
}

pub fn generate_format(io: Io, opts: *const CompileConfig, loaded_config: ?Config) u8 {
    const world = Bridge.get_world();
    var engine = create_default_engine(io, world, opts) catch |err| {
        Log.log(io, "eztex", .err, "failed to create engine: {}", .{err});
        return 1;
    };
    defer engine.destroy();
    return generateFormatWithEngine(io, opts, loaded_config, engine);
}

pub fn generateFormatWithEngine(io: Io, opts: *const CompileConfig, loaded_config: ?Config, engine: EngineApi.Engine) u8 {
    const old_engine = if (Runtime.instance) |rt| rt.active_engine else null;
    if (Runtime.instance) |rt| rt.active_engine = engine;
    defer {
        if (Runtime.instance) |rt| rt.active_engine = old_engine;
    }

    const format = opts.format;

    Log.log(io, "eztex", .info, "generating {s} format...", .{engine.formatFileName(format)});

    const bundle = if (loaded_config) |config|
        config.effective_bundle()
    else
        Config.default().effective_bundle();
    const bundle_digest = Config.digest_from_url(bundle.url);

    setup_world(io, engine, format, opts.verbose, opts.cache_dir, bundle, &bundle_digest, opts.deterministic);
    defer Bridge.deinit_bundle_store();

    if (g_format_bytes == null) {
        Log.log(io, "eztex", .err, "format generation failed -- {s} not loaded into memory", .{engine.formatFileName(format)});
        return 1;
    }

    Log.log(io, "eztex", .info, "{s} ready", .{engine.formatFileName(format)});
    return 0;
}

test "stabilization comparison treats aux as primary" {
    var prev = StabilizationSnapshot{};
    defer prev.deinit();
    var curr = StabilizationSnapshot{};
    defer curr.deinit();

    prev.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "same aux");
    curr.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "different aux");
    prev.files[1] = try std.heap.c_allocator.dupe(u8, "same toc");
    curr.files[1] = try std.heap.c_allocator.dupe(u8, "changed toc");

    const status = compare_stabilization_snapshots(&prev, &curr);

    try testing.expect(!status.aux_stable);
    try testing.expect(!status.all_stable);
    try testing.expectEqualStrings(".aux", status.changed_extension.?);
}

test "stabilization comparison detects secondary file changes" {
    var prev = StabilizationSnapshot{};
    defer prev.deinit();
    var curr = StabilizationSnapshot{};
    defer curr.deinit();

    prev.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "same aux");
    curr.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "same aux");
    prev.files[1] = try std.heap.c_allocator.dupe(u8, "old toc");
    curr.files[1] = try std.heap.c_allocator.dupe(u8, "new toc");

    const status = compare_stabilization_snapshots(&prev, &curr);

    try testing.expect(status.aux_stable);
    try testing.expect(!status.all_stable);
    try testing.expectEqualStrings(".toc", status.changed_extension.?);
}

test "stabilization comparison accepts unchanged optional set" {
    var prev = StabilizationSnapshot{};
    defer prev.deinit();
    var curr = StabilizationSnapshot{};
    defer curr.deinit();

    prev.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "same aux");
    curr.files[aux_stabilization_index] = try std.heap.c_allocator.dupe(u8, "same aux");
    prev.files[1] = try std.heap.c_allocator.dupe(u8, "same toc");
    curr.files[1] = try std.heap.c_allocator.dupe(u8, "same toc");

    const status = compare_stabilization_snapshots(&prev, &curr);

    try testing.expect(status.aux_stable);
    try testing.expect(status.all_stable);
    try testing.expect(status.changed_extension == null);
}

test "bibliography_action rejects pure biblatex aux" {
    try testing.expectEqual(BibliographyAction.unsupported_biblatex, bibliography_action(testing.io, "main.aux", "\\relax\n\\abx@aux@cite{0}{refA}\n"));
}

test "bibliography_action prefers bibtex for mixed markers" {
    const aux_contents = "\\relax\n\\abx@aux@cite{0}{refA}\n\\bibdata{refs}\n\\bibstyle{plain}\n";
    try testing.expectEqual(BibliographyAction.run_bibtex, bibliography_action(testing.io, "main.aux", aux_contents));
}
