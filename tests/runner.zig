// tests/runner.zig -- zig-native integration test runner for eztex
// replaces tests/run_tests.sh with parallel execution via std.Thread.Pool
//
// usage: zig build test-integration
//   argv[1] = path to eztex binary (injected by build.zig via addArtifactArg)
//   argv[2] = path to tests/ directory

const std = @import("std");
const fs = std.fs;
const posix = std.posix;

// -- test case definition --

const Format = enum { latex, plain };

const ValidateMode = enum {
    pdf_exists,
    synctex_valid,
};

const TestCase = struct {
    name: []const u8,
    tex_dir: []const u8, // relative to tests_root: "latex" or "plain"
    format: Format,
    extra_args: []const []const u8 = &.{},
    assets: []const []const u8 = &.{}, // filenames in tests/assets/
    companions: []const []const u8 = &.{}, // files in same tex_dir
    validate: ValidateMode = .pdf_exists,
    expect_fail: bool = false, // test passes when eztex exits non-zero
    skip: bool = false,
    skip_reason: []const u8 = "",
};

// -- comptime test table -- ported faithfully from run_tests.sh --

const test_cases = [_]TestCase{
    // --- latex tests (tests/latex/*.tex) ---
    .{ .name = "basic_text", .tex_dir = "latex", .format = .latex },
    .{ .name = "bibtex_basic", .tex_dir = "latex", .format = .latex, .assets = &.{"refs.bib"} },
    .{ .name = "fonts", .tex_dir = "latex", .format = .latex },
    .{ .name = "footnotes", .tex_dir = "latex", .format = .latex },
    .{ .name = "lists_and_tables", .tex_dir = "latex", .format = .latex },
    .{ .name = "math", .tex_dir = "latex", .format = .latex },
    .{ .name = "sections_and_refs", .tex_dir = "latex", .format = .latex },
    .{ .name = "toc_multipass", .tex_dir = "latex", .format = .latex },
    .{ .name = "unicode", .tex_dir = "latex", .format = .latex },

    // --- plain tex tests (tests/plain/*.tex) ---
    .{ .name = "a4paper", .tex_dir = "plain", .format = .plain },
    .{ .name = "file_encoding", .tex_dir = "plain", .format = .plain, .companions = &.{
        "file_encoding_utf8.txt",
        "file_encoding_utf16be.txt",
        "file_encoding_utf16le.txt",
    } },
    .{ .name = "graphite_basic", .tex_dir = "plain", .format = .plain },
    .{
        .name = "hall\xc3\xb6chen \xf0\x9f\x90\xa8 welt \xf0\x9f\x8c\x8d",
        .tex_dir = "plain",
        .format = .plain,
    },
    .{ .name = "issue393_ungetc", .tex_dir = "plain", .format = .plain, .assets = &.{"issue393_ungetc_trigger.pdf"} },
    .{ .name = "md5_of_hello", .tex_dir = "plain", .format = .plain },
    .{ .name = "negative_roman_numeral", .tex_dir = "plain", .format = .plain },
    .{ .name = "no_shell_escape", .tex_dir = "plain", .format = .plain },
    .{ .name = "otf_basic", .tex_dir = "plain", .format = .plain },
    .{ .name = "otf_ot_shaper", .tex_dir = "plain", .format = .plain },
    .{ .name = "pdf_fstream", .tex_dir = "plain", .format = .plain },
    .{ .name = "pdfoutput", .tex_dir = "plain", .format = .plain },
    .{ .name = "png_formats", .tex_dir = "plain", .format = .plain, .assets = &.{
        "png_rgba_16_bit.png",
        "png_graya.png",
        "png_rgba.png",
        "png_palette_alpha.png",
        "png_palette_4bit.png",
        "png_gray_4bit.png",
    } },
    .{ .name = "prim_creationdate", .tex_dir = "plain", .format = .plain },
    .{ .name = "prim_filedump", .tex_dir = "plain", .format = .plain },
    .{ .name = "prim_filemoddate", .tex_dir = "plain", .format = .plain },
    .{ .name = "prim_filesize", .tex_dir = "plain", .format = .plain },
    .{ .name = "redbox_png", .tex_dir = "plain", .format = .plain, .assets = &.{"redbox.png"} },
    .{ .name = "synctex", .tex_dir = "plain", .format = .plain, .extra_args = &.{"--synctex"}, .validate = .synctex_valid },
    .{ .name = "tectoniccodatokens_ok", .tex_dir = "plain", .format = .plain },
    .{ .name = "test space", .tex_dir = "plain", .format = .plain },
    .{ .name = "tex_logo", .tex_dir = "plain", .format = .plain },
    .{ .name = "the_letter_a", .tex_dir = "plain", .format = .plain },
    .{ .name = "utf8_chars", .tex_dir = "plain", .format = .plain },
    .{ .name = "xetex_g_builtins", .tex_dir = "plain", .format = .plain },
    .{ .name = "xetex_ot_builtins", .tex_dir = "plain", .format = .plain },

    // --- permanently skipped ---
    .{ .name = "bibtex_multiple_aux_files", .tex_dir = "plain", .format = .plain, .skip = true, .skip_reason = "needs catchkey.bst (not in bundle)" },
    .{ .name = "pipe_input", .tex_dir = "plain", .format = .plain, .skip = true, .skip_reason = "needs stdin piping" },
    .{ .name = "tectoniccodatokens_errinside", .tex_dir = "plain", .format = .plain, .expect_fail = true },
    .{ .name = "tectoniccodatokens_noend", .tex_dir = "plain", .format = .plain, .expect_fail = true },
};

// -- per-test result (written once per slot, no mutex needed) --

const Result = enum { pass, fail, skip };

const TestResult = struct {
    name: []const u8,
    result: Result,
    detail: [detail_max]u8,
    detail_len: usize,
    elapsed_ns: u64,

    const detail_max = 256;

    fn setDetail(self: *TestResult, msg: []const u8) void {
        const len = @min(msg.len, detail_max);
        @memcpy(self.detail[0..len], msg[0..len]);
        self.detail_len = len;
    }

    fn detailSlice(self: *const TestResult) []const u8 {
        return self.detail[0..self.detail_len];
    }
};

var results: [test_cases.len]TestResult = undefined;

// -- timeout detection --

const default_timeout_s: u64 = 120;
const first_run_timeout_s: u64 = 600;

fn detectTimeout() u64 {
    const home = posix.getenv("HOME") orelse return default_timeout_s;
    var buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&buf, "{s}/Library/Caches/eztex/v1/formats/xelatex.fmt", .{home}) catch return default_timeout_s;
    fs.accessAbsolute(path, .{}) catch return first_run_timeout_s;
    return default_timeout_s;
}

// -- single test execution --

fn runOneTest(
    allocator: std.mem.Allocator,
    eztex_path: []const u8,
    tests_root: []const u8,
    work_base: []const u8,
    timeout_s: u64,
    comptime index: usize,
) void {
    const tc = test_cases[index];
    results[index] = runOneTestInner(allocator, eztex_path, tests_root, work_base, timeout_s, tc) catch |err| blk: {
        var r: TestResult = .{
            .name = tc.name,
            .result = .fail,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = 0,
        };
        r.setDetail(@errorName(err));
        break :blk r;
    };
}

fn runOneTestInner(
    allocator: std.mem.Allocator,
    eztex_path: []const u8,
    tests_root: []const u8,
    work_base: []const u8,
    timeout_s: u64,
    tc: TestCase,
) !TestResult {
    if (tc.skip) {
        var r: TestResult = .{
            .name = tc.name,
            .result = .skip,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = 0,
        };
        if (tc.skip_reason.len > 0) {
            r.setDetail(tc.skip_reason);
        } else {
            r.setDetail("skipped");
        }
        return r;
    }

    var timer = std.time.Timer.start() catch {
        var r: TestResult = .{
            .name = tc.name,
            .result = .fail,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = 0,
        };
        r.setDetail("timer unavailable");
        return r;
    };

    // build work dir path: work_base/<name>
    // use a hash for names with unicode/special chars to avoid filesystem issues
    var name_buf: [256]u8 = undefined;
    const safe_name = safeDirName(tc.name, &name_buf);
    const work_dir = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ work_base, safe_name });
    defer allocator.free(work_dir);

    // rm -rf and recreate
    fs.deleteTreeAbsolute(work_dir) catch {};
    try fs.makeDirAbsolute(work_dir);

    // resolve tex source directory
    const tex_src_dir = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ tests_root, tc.tex_dir });
    defer allocator.free(tex_src_dir);

    // copy .tex file
    const tex_filename = try std.fmt.allocPrint(allocator, "{s}.tex", .{tc.name});
    defer allocator.free(tex_filename);
    {
        const src = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ tex_src_dir, tex_filename });
        defer allocator.free(src);
        const dst = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ work_dir, tex_filename });
        defer allocator.free(dst);
        try copyFile(src, dst);
    }

    // copy companion files (from same tex_dir)
    for (tc.companions) |comp| {
        const src = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ tex_src_dir, comp });
        defer allocator.free(src);
        const dst = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ work_dir, comp });
        defer allocator.free(dst);
        try copyFile(src, dst);
    }

    // copy asset files (from tests/assets/)
    for (tc.assets) |asset| {
        const src = try std.fmt.allocPrint(allocator, "{s}/assets/{s}", .{ tests_root, asset });
        defer allocator.free(src);
        const dst = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ work_dir, asset });
        defer allocator.free(dst);
        try copyFile(src, dst);
    }

    // build argv
    var argv: std.ArrayListUnmanaged([]const u8) = .empty;
    defer argv.deinit(allocator);
    try argv.append(allocator, eztex_path);
    try argv.append(allocator, "compile");
    try argv.append(allocator, tex_filename);
    if (tc.format == .plain) {
        try argv.append(allocator, "--format");
        try argv.append(allocator, "plain");
    }
    for (tc.extra_args) |arg| try argv.append(allocator, arg);
    try argv.append(allocator, "--keep-intermediates");

    // spawn child process
    var child = std.process.Child.init(argv.items, allocator);
    child.cwd = work_dir;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Pipe;
    try child.spawn();

    // spawn watchdog -- passes pid directly, never calls waitpid itself
    var wd_ctx = WatchdogCtx{
        .pid = child.id,
        .timeout_ns = timeout_s * std.time.ns_per_s,
    };
    const watchdog = std.Thread.spawn(.{}, watchdogFn, .{&wd_ctx}) catch null;

    // collect output
    var stdout_buf: std.ArrayListUnmanaged(u8) = .empty;
    defer stdout_buf.deinit(allocator);
    var stderr_buf: std.ArrayListUnmanaged(u8) = .empty;
    defer stderr_buf.deinit(allocator);
    child.collectOutput(allocator, &stdout_buf, &stderr_buf, 256 * 1024) catch {};

    const term = child.wait() catch |err| {
        // cancel and join watchdog -- wd_ctx is stack memory, must not outlive this frame
        wd_ctx.cancelled.store(true, .release);
        if (watchdog) |wd| wd.join();
        var r: TestResult = .{
            .name = tc.name,
            .result = .fail,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = timer.read(),
        };
        r.setDetail(@errorName(err));
        return r;
    };

    // cancel and join watchdog -- child reaped, prevent stale SIGKILL on recycled pid
    wd_ctx.cancelled.store(true, .release);
    if (watchdog) |wd| wd.join();

    const elapsed = timer.read();

    // write stdout/stderr logs for debugging
    writeLog(work_dir, "stdout.log", stdout_buf.items, allocator);
    writeLog(work_dir, "stderr.log", stderr_buf.items, allocator);

    // check exit code
    const exited_zero = switch (term) {
        .Exited => |code| code == 0,
        .Signal => |sig| blk: {
            // SIGKILL from watchdog = timeout (always a failure)
            if (sig == 9) {
                var r: TestResult = .{
                    .name = tc.name,
                    .result = .fail,
                    .detail = undefined,
                    .detail_len = 0,
                    .elapsed_ns = elapsed,
                };
                r.setDetail("timeout");
                return r;
            }
            break :blk false;
        },
        else => false,
    };

    // expect_fail: pass iff eztex exited non-zero (expected engine error)
    if (tc.expect_fail) {
        var r: TestResult = .{
            .name = tc.name,
            .result = undefined,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = elapsed,
        };
        if (exited_zero) {
            r.result = .fail;
            r.setDetail("expected failure but exited cleanly");
        } else {
            r.result = .pass;
            r.setDetail("failed as expected");
        }
        return r;
    }

    if (!exited_zero) {
        var r: TestResult = .{
            .name = tc.name,
            .result = .fail,
            .detail = undefined,
            .detail_len = 0,
            .elapsed_ns = elapsed,
        };
        // extract useful error from stderr
        const err_line = extractErrorLine(stderr_buf.items);
        if (err_line.len > 0) {
            r.setDetail(err_line);
        } else {
            var exit_buf: [64]u8 = undefined;
            const msg = std.fmt.bufPrint(&exit_buf, "exit code {d}", .{switch (term) {
                .Exited => |c| @as(u32, c),
                .Signal => |s| s,
                .Stopped => |s| s,
                .Unknown => |u| u,
            }}) catch "non-zero exit";
            r.setDetail(msg);
        }
        return r;
    }

    // validate output
    return validate(allocator, tc, work_dir, elapsed);
}

fn validate(allocator: std.mem.Allocator, tc: TestCase, work_dir: []const u8, elapsed: u64) !TestResult {
    const pdf_path = try std.fmt.allocPrint(allocator, "{s}/{s}.pdf", .{ work_dir, tc.name });
    defer allocator.free(pdf_path);

    // check pdf exists and is non-empty
    const pdf_stat = fs.cwd().statFile(pdf_path) catch {
        var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
        r.setDetail("no PDF produced");
        return r;
    };
    if (pdf_stat.size == 0) {
        var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
        r.setDetail("empty PDF");
        return r;
    }

    switch (tc.validate) {
        .pdf_exists => {
            var r: TestResult = .{ .name = tc.name, .result = .pass, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
            var size_buf: [32]u8 = undefined;
            const size_str = std.fmt.bufPrint(&size_buf, "{d} bytes", .{pdf_stat.size}) catch "ok";
            r.setDetail(size_str);
            return r;
        },
        .synctex_valid => {
            const gz_path = try std.fmt.allocPrint(allocator, "{s}/{s}.synctex.gz", .{ work_dir, tc.name });
            defer allocator.free(gz_path);

            const gz_file = fs.cwd().openFile(gz_path, .{}) catch {
                var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
                r.setDetail("missing .synctex.gz");
                return r;
            };
            defer gz_file.close();

            // read enough to validate
            var header_buf: [512]u8 = undefined;
            const n = gz_file.readAll(&header_buf) catch {
                var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
                r.setDetail("cannot read synctex.gz");
                return r;
            };

            // check gzip magic bytes
            if (n < 2 or header_buf[0] != 0x1f or header_buf[1] != 0x8b) {
                var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
                r.setDetail("invalid gzip synctex");
                return r;
            }

            // decompress and check for SyncTeX Version header
            // re-read full file for decompression
            gz_file.seekTo(0) catch {};
            const gz_content = gz_file.readToEndAlloc(allocator, 4 * 1024 * 1024) catch {
                var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
                r.setDetail("cannot read full synctex.gz");
                return r;
            };
            defer allocator.free(gz_content);

            // use std.compress.flate with gzip container
            var input_reader = std.Io.Reader.fixed(gz_content);
            var decomp_buf: [std.compress.flate.max_window_len]u8 = undefined;
            var decompressor = std.compress.flate.Decompress.init(&input_reader, .gzip, &decomp_buf);
            var decompressed: [1024]u8 = undefined;
            const dec_reader = &decompressor.reader;
            const dec_n = dec_reader.readSliceShort(&decompressed) catch 0;

            if (dec_n > 0 and std.mem.indexOf(u8, decompressed[0..dec_n], "SyncTeX Version") != null) {
                var r: TestResult = .{ .name = tc.name, .result = .pass, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
                r.setDetail("synctex valid");
                return r;
            }

            var r: TestResult = .{ .name = tc.name, .result = .fail, .detail = undefined, .detail_len = 0, .elapsed_ns = elapsed };
            r.setDetail("synctex header missing");
            return r;
        },
    }
}

// -- watchdog: kills child process after timeout --
// Uses posix.kill directly (NOT child.kill) to avoid the waitpid race:
// child.kill() calls waitpid internally, which collides with child.wait() on
// the main thread -> ECHILD -> unreachable panic.

const WatchdogCtx = struct {
    pid: posix.pid_t,
    timeout_ns: u64,
    cancelled: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
};

fn watchdogFn(ctx: *WatchdogCtx) void {
    const poll_interval_ns = 10 * std.time.ns_per_ms;
    var elapsed: u64 = 0;
    while (elapsed < ctx.timeout_ns) {
        std.Thread.sleep(poll_interval_ns);
        elapsed += poll_interval_ns;
        if (ctx.cancelled.load(.acquire)) return;
    }
    // Only send SIGKILL -- do NOT wait. Main thread owns waitpid.
    if (!ctx.cancelled.load(.acquire)) {
        posix.kill(ctx.pid, posix.SIG.KILL) catch {};
    }
}

// -- helpers --

fn copyFile(src: []const u8, dst: []const u8) !void {
    const src_file = try fs.cwd().openFile(src, .{});
    defer src_file.close();
    const dst_file = try fs.cwd().createFile(dst, .{});
    defer dst_file.close();
    // read/write in chunks
    var buf: [8192]u8 = undefined;
    while (true) {
        const n = try src_file.read(&buf);
        if (n == 0) break;
        try dst_file.writeAll(buf[0..n]);
    }
}

fn safeDirName(name: []const u8, buf: *[256]u8) []const u8 {
    // replace non-ascii and problematic chars with underscore for safe directory names
    var i: usize = 0;
    for (name) |c| {
        if (i >= 255) break;
        if (c > 127 or c == ' ' or c == '/' or c == '\\' or c == ':') {
            buf[i] = '_';
        } else {
            buf[i] = c;
        }
        i += 1;
    }
    return buf[0..i];
}

fn extractErrorLine(stderr: []const u8) []const u8 {
    // find last line containing "error" or "fatal" or "failed" (case insensitive)
    var last_match: ?[]const u8 = null;
    var iter = std.mem.splitScalar(u8, stderr, '\n');
    while (iter.next()) |line| {
        if (containsCI(line, "error") or containsCI(line, "fatal") or containsCI(line, "failed")) {
            last_match = line;
        }
    }
    return last_match orelse "";
}

fn containsCI(haystack: []const u8, needle: []const u8) bool {
    if (haystack.len < needle.len) return false;
    var i: usize = 0;
    while (i <= haystack.len - needle.len) : (i += 1) {
        var match = true;
        for (needle, 0..) |nc, j| {
            const hc = haystack[i + j];
            if (toLower(hc) != toLower(nc)) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

fn toLower(c: u8) u8 {
    return if (c >= 'A' and c <= 'Z') c + 32 else c;
}

fn writeLog(dir: []const u8, filename: []const u8, content: []const u8, allocator: std.mem.Allocator) void {
    const path = std.fmt.allocPrint(allocator, "{s}/{s}", .{ dir, filename }) catch return;
    defer allocator.free(path);
    const file = fs.cwd().createFile(path, .{}) catch return;
    defer file.close();
    file.writeAll(content) catch {};
}

// -- output formatting --

const esc_reset = "\x1b[0m";
const esc_green = "\x1b[32m";
const esc_red = "\x1b[31m";
const esc_yellow = "\x1b[33m";
const esc_bold = "\x1b[1m";

fn printResults() void {
    const stdout_file = std.fs.File.stdout();
    var buf: [8192]u8 = undefined;
    var file_writer = stdout_file.writer(&buf);
    const w = &file_writer.interface;

    var pass_count: usize = 0;
    var fail_count: usize = 0;
    var skip_count: usize = 0;

    // print individual results
    for (&results) |*r| {
        const status_str = switch (r.result) {
            .pass => esc_green ++ "[PASS]" ++ esc_reset,
            .fail => esc_red ++ "[FAIL]" ++ esc_reset,
            .skip => esc_yellow ++ "[SKIP]" ++ esc_reset,
        };

        w.print("  {s} {s:<35}", .{ status_str, r.name }) catch {};

        switch (r.result) {
            .pass => {
                pass_count += 1;
                const ms = r.elapsed_ns / std.time.ns_per_ms;
                w.print(" ({s}) {d}ms", .{ r.detailSlice(), ms }) catch {};
            },
            .fail => {
                fail_count += 1;
                const ms = r.elapsed_ns / std.time.ns_per_ms;
                if (ms > 0) {
                    w.print(" {s} {d}ms", .{ r.detailSlice(), ms }) catch {};
                } else {
                    w.print(" {s}", .{r.detailSlice()}) catch {};
                }
            },
            .skip => {
                skip_count += 1;
                if (r.detail_len > 0) {
                    w.print(" ({s})", .{r.detailSlice()}) catch {};
                }
            },
        }
        w.print("\n", .{}) catch {};
    }

    w.print("\n--- results ---\n", .{}) catch {};
    w.print("passed: {s}{d}{s}  failed: {s}{d}{s}  skipped: {s}{d}{s}\n", .{
        esc_green,                                  pass_count, esc_reset,
        if (fail_count > 0) esc_red else esc_reset, fail_count, esc_reset,
        esc_yellow,                                 skip_count, esc_reset,
    }) catch {};
    w.print("total:  {d}\n\n", .{pass_count + fail_count + skip_count}) catch {};

    if (fail_count > 0) {
        w.print("{s}{s}SOME TESTS FAILED{s}\n", .{ esc_bold, esc_red, esc_reset }) catch {};
    } else {
        w.print("{s}{s}ALL TESTS PASSED{s}\n", .{ esc_bold, esc_green, esc_reset }) catch {};
    }
    w.flush() catch {};
}

// -- main --

pub fn main() !u8 {
    var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa_state.deinit();
    const allocator = gpa_state.allocator();

    var args = std.process.args();
    _ = args.next(); // skip argv[0]
    const eztex_path_raw = args.next() orelse {
        std.debug.print("usage: test-runner <eztex-binary> <tests-dir>\n", .{});
        return 1;
    };
    const tests_root_raw = args.next() orelse {
        std.debug.print("usage: test-runner <eztex-binary> <tests-dir>\n", .{});
        return 1;
    };

    // resolve to absolute paths (eztex_path may be relative, breaks when cwd changes)
    const eztex_path = try fs.cwd().realpathAlloc(allocator, eztex_path_raw);
    defer allocator.free(eztex_path);
    const tests_root = try fs.cwd().realpathAlloc(allocator, tests_root_raw);
    defer allocator.free(tests_root);

    const stdout_file = std.fs.File.stdout();
    var out_buf: [4096]u8 = undefined;
    var file_writer = stdout_file.writer(&out_buf);
    const w = &file_writer.interface;

    try w.print("=== eztex integration tests ===\n", .{});
    try w.print("binary: {s}\n", .{eztex_path});

    const timeout = detectTimeout();
    try w.print("timeout: {d}s", .{timeout});
    if (timeout == first_run_timeout_s) {
        try w.print(" (first run -- format cache not found)", .{});
    }
    try w.print("\n", .{});

    // count active vs skipped
    var active: usize = 0;
    var skipped: usize = 0;
    for (&test_cases) |*tc| {
        if (tc.skip) {
            skipped += 1;
        } else {
            active += 1;
        }
    }
    try w.print("running {d} tests ({d} skipped)\n\n", .{ active, skipped });
    try w.flush();

    // create work directory (sibling to tests_root: <project>/tmp/test_runs)
    const project_root = std.fs.path.dirname(tests_root) orelse tests_root;
    const work_base = try std.fmt.allocPrint(allocator, "{s}/tmp/test_runs", .{project_root});
    defer allocator.free(work_base);
    const tmp_dir = try std.fmt.allocPrint(allocator, "{s}/tmp", .{project_root});
    defer allocator.free(tmp_dir);
    fs.makeDirAbsolute(tmp_dir) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    fs.makeDirAbsolute(work_base) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };

    // run all tests with thread pool
    var pool: std.Thread.Pool = undefined;
    try pool.init(.{ .allocator = allocator });
    defer pool.deinit();

    var wg: std.Thread.WaitGroup = .{};

    // spawn all tests -- use comptime unrolling for the index parameter
    inline for (0..test_cases.len) |i| {
        pool.spawnWg(&wg, runOneTest, .{ allocator, eztex_path, tests_root, work_base, timeout, i });
    }

    pool.waitAndWork(&wg);

    // print results
    printResults();

    // exit code
    for (&results) |*r| {
        if (r.result == .fail) return 1;
    }
    return 0;
}
