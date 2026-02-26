const std = @import("std");

const EngineSet = enum { all, tectonic };

pub fn build(b: *std.Build) void {
    const raw_target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const is_wasm = raw_target.result.cpu.arch == .wasm32;

    const engines: EngineSet = b.option(EngineSet, "engines", "Engine set to link (all or tectonic)") orelse .all;

    // build_options module so Zig source can query backend at comptime
    const options = b.addOptions();
    options.addOption([]const u8, "engines", @tagName(engines));
    const options_mod = options.createModule();

    // for WASM targets, ensure exception_handling CPU features is enabled
    // (required for setjmp/longjmp via wasm exception handling proposal).
    // this avoids requiring -Dcpu=baseline+exception_handling on the CLI.
    // fixed in Zig 0.17.0-dev.269+ (PR #31438) -- wasi libc SJLJ compilation
    const target = if (is_wasm) blk: {
        var query = raw_target.query;
        query.cpu_features_add.addFeature(@intFromEnum(std.Target.wasm.Feature.exception_handling));
        break :blk b.resolveTargetQuery(query);
    } else raw_target;

    const exe = buildEztex(b, target, optimize, engines, options_mod);
    b.installArtifact(exe);

    // run step (native only)
    if (!is_wasm) {
        const run_cmd = b.addRunArtifact(exe);
        run_cmd.step.dependOn(b.getInstallStep());
        if (b.args) |args| run_cmd.addArgs(args);
        const run_step = b.step("run", "Run eztex");
        run_step.dependOn(&run_cmd.step);
    }

    // -- wasm step: build full engine for wasm32-wasi and copy to app/public/ --
    // This builds the complete eztex engine (tectonic + all deps) for the browser
    // JS worker. The web app fetches /eztex.wasm and creates both api_instance
    // (index queries) and compile_instance (wasi.start() to run TeX) from it.
    {
        const wasm_query: std.Target.Query = .{
            .os_tag = .wasi,
            .cpu_arch = .wasm32,
        };
        const wasm_target = b.resolveTargetQuery(wasm_query);
        // enable exception_handling for setjmp/longjmp
        var query = wasm_target.query;
        query.cpu_features_add.addFeature(@intFromEnum(std.Target.wasm.Feature.exception_handling));
        const wasm_target_eh = b.resolveTargetQuery(query);

        const wasm_exe = buildEztex(b, wasm_target_eh, .ReleaseSmall, engines, options_mod);

        const copy = b.addInstallFileWithDir(
            wasm_exe.getEmittedBin(),
            .{ .custom = "../app/public" },
            "eztex.wasm",
        );
        const wasm_step = b.step("wasm", "Build full WASM engine and copy to app/public/");
        wasm_step.dependOn(&copy.step);
    }

    // -- unit tests (native only) --
    if (!is_wasm) {
        const test_step = b.step("test", "Run all unit tests");

        // pure zig modules (no C deps)
        const pure_test_srcs: []const []const u8 = &.{
            "src/Config.zig",
            "src/FormatCache.zig",
            "src/MainDetect.zig",
            "src/Watcher.zig",
            "src/World.zig",
            "src/compile/aux.zig",
        };
        for (pure_test_srcs) |src| {
            const mod = b.createModule(.{
                .root_source_file = b.path(src),
                .target = target,
                .optimize = optimize,
            });
            const t = b.addTest(.{ .root_module = mod });
            const run_t = b.addRunArtifact(t);
            test_step.dependOn(&run_t.step);
        }

        // flate tests (needs zlib)
        const zlib_dep = b.dependency("zlib", .{
            .target = target,
            .optimize = optimize,
        });
        const zlib_lib = zlib_dep.artifact("z");

        const flate_test_mod = b.createModule(.{
            .root_source_file = b.path("src/Flate.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        flate_test_mod.linkLibrary(zlib_lib);

        const flate_tests = b.addTest(.{
            .root_module = flate_test_mod,
        });
        const run_flate_tests = b.addRunArtifact(flate_tests);
        test_step.dependOn(&run_flate_tests.step);

        // keep test-flate as standalone alias
        const flate_step = b.step("test-flate", "Run Flate bridge tests");
        flate_step.dependOn(&run_flate_tests.step);
    }

    // -- integration test runner (native only) --
    if (!is_wasm) {
        const runner_exe = b.addExecutable(.{
            .name = "test-runner",
            .root_module = b.createModule(.{
                .root_source_file = b.path("tests/runner.zig"),
                .target = target,
                .optimize = optimize,
            }),
        });

        const run_runner = b.addRunArtifact(runner_exe);
        run_runner.addArtifactArg(exe); // argv[1]: path to built eztex binary
        run_runner.addArg(b.pathFromRoot("tests")); // argv[2]: tests directory
        if (b.args) |args| run_runner.addArgs(args);

        const integration_step = b.step("test-integration", "Run integration tests");
        integration_step.dependOn(&run_runner.step);
    }
}

// builds the eztex executable for the given target and optimization level.
// factored out so both native (default install) and wasm step can reuse.
fn buildEztex(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    engines: EngineSet,
    options_mod: *std.Build.Module,
) *std.Build.Step.Compile {
    const is_wasm = target.result.cpu.arch == .wasm32;

    // -- external dependencies (shared across backends) --
    const zlib_dep = b.dependency("zlib", .{
        .target = target,
        .optimize = optimize,
    });
    const zlib_lib = zlib_dep.artifact("z");

    const harfbuzz_dep = b.dependency("harfbuzz", .{
        .target = target,
        .optimize = optimize,
        .@"enable-freetype" = true,
        .@"enable-coretext" = false,
        .@"enable-graphite2" = false,
    });
    const freetype_dep = b.dependency("freetype", .{
        .target = target,
        .optimize = optimize,
        .@"enable-libpng" = true,
    });
    const libpng_dep = b.dependency("libpng", .{
        .target = target,
        .optimize = optimize,
    });
    const icu_dep = b.dependency("icu", .{
        .target = target,
        .optimize = optimize,
    });
    const graphite2_dep = b.dependency("graphite2", .{
        .target = target,
        .optimize = optimize,
    });

    const harfbuzz_lib = harfbuzz_dep.artifact("harfbuzz");
    const freetype_lib = freetype_dep.artifact("freetype");
    const libpng_lib = libpng_dep.artifact("png");
    const icuuc_lib = icu_dep.artifact("icuuc");
    const graphite2_lib = graphite2_dep.artifact("graphite2");

    // -- compiler flags for local stubs --
    const wasm_sjlj_flags: []const []const u8 = if (is_wasm) &.{
        "-mexception-handling",
        "-mllvm",
        "-wasm-enable-sjlj",
        "-mllvm",
        "--wasm-use-legacy-eh=false",
    } else &.{};

    const wasm_c_compat_flags: []const []const u8 = if (is_wasm) &.{
        "-D_WASI_EMULATED_SIGNAL",
        "-Wno-incompatible-pointer-types-discards-qualifiers",
    } else &.{};

    const c_flags = buildFlags3(b, &.{
        "-Wno-unused-parameter",
        "-Wno-implicit-fallthrough",
        "-Wno-sign-compare",
        "-fno-sanitize=undefined",
        "-std=gnu11",
    }, wasm_sjlj_flags, wasm_c_compat_flags);

    // -- static library: wasm_posix_stubs (WASM only) --
    const wasm_posix_stubs = if (is_wasm) blk: {
        const stubs_mod = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        const lib = b.addLibrary(.{
            .name = "wasm_posix_stubs",
            .root_module = stubs_mod,
        });
        lib.root_module.addCSourceFile(.{
            .file = b.path("csrc/wasm/posix.c"),
            .flags = c_flags,
        });
        break :blk lib;
    } else null;

    // -- static library: wasm_sjlj_rt (WASM only) --
    const wasm_sjlj_rt = if (is_wasm) blk: {
        const sjlj_mod = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        const lib = b.addLibrary(.{
            .name = "wasm_sjlj_rt",
            .root_module = sjlj_mod,
        });
        lib.root_module.addCSourceFile(.{
            .file = b.path("csrc/wasm/sjlj_rt.c"),
            .flags = c_flags,
        });
        lib.root_module.addAssemblyFile(b.path("csrc/wasm/eh_tags.s"));
        break :blk lib;
    } else null;

    // -- executable: eztex --
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .link_libcpp = !is_wasm,
    });

    // inject build_options so Compiler.zig can read backend at comptime
    exe_mod.addImport("build_options", options_mod);

    // -- shared deps (needed by Layout.zig, Flate.zig, etc.) --
    exe_mod.linkLibrary(zlib_lib);
    exe_mod.linkLibrary(freetype_lib);
    exe_mod.linkLibrary(harfbuzz_lib);
    exe_mod.linkLibrary(libpng_lib);
    exe_mod.linkLibrary(icuuc_lib);
    exe_mod.linkLibrary(graphite2_lib);

    // ensure static linking for vendored libraries (avoids dllimport on Windows)
    exe_mod.addCMacro("GRAPHITE2_STATIC", "1");

    // -- engine libraries --
    if (engines == .all or engines == .tectonic) {
        const tectonic_dep = b.dependency("tectonic", .{
            .target = target,
            .optimize = optimize,
        });
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_bridge_core"));
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_engine_xetex_c"));
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_engine_xetex_cxx"));
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_pdf_io"));
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_engine_xdvipdfmx"));
        exe_mod.linkLibrary(tectonic_dep.artifact("tectonic_engine_bibtex"));
    }

    // wasm: link sjlj runtime, posix stubs, and wasi emulation libraries
    if (wasm_sjlj_rt) |rt| exe_mod.linkLibrary(rt);
    if (wasm_posix_stubs) |stubs| exe_mod.linkLibrary(stubs);
    if (is_wasm) {
        exe_mod.linkSystemLibrary("wasi-emulated-signal", .{});
    }

    // macOS frameworks (macOS native only)
    if (!is_wasm and target.result.os.tag == .macos) {
        exe_mod.linkFramework("CoreFoundation", .{});
        exe_mod.linkFramework("CoreText", .{});
        exe_mod.linkFramework("CoreGraphics", .{});
        exe_mod.linkFramework("ApplicationServices", .{});
    }

    const exe = b.addExecutable(.{
        .name = "eztex",
        .root_module = exe_mod,
    });

    // WASM: export dynamic symbols (eztex_alloc, eztex_free for JS host)
    // and strip debug info to reduce binary size
    if (is_wasm) {
        exe.rdynamic = true;
        exe.root_module.strip = true;
    }

    return exe;
}

fn buildFlags3(b: *std.Build, base: []const []const u8, a: []const []const u8, c: []const []const u8) []const []const u8 {
    if (a.len == 0 and c.len == 0) return base;
    return std.mem.concat(b.allocator, []const u8, &.{ base, a, c }) catch @panic("OOM");
}
