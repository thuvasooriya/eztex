const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const is_wasm = target.result.cpu.arch == .wasm32;

    // -- external dependencies (declared in build.zig.zon) --
    const harfbuzz_dep = b.dependency("harfbuzz", .{
        .target = target,
        .optimize = optimize,
        .@"enable-freetype" = true,
        .@"enable-coretext" = false,
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
    const zlib_dep = b.dependency("zlib", .{
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
    const zlib_lib = zlib_dep.artifact("z");
    const icuuc_lib = icu_dep.artifact("icuuc");
    const graphite2_lib = graphite2_dep.artifact("graphite2");

    // -- harfbuzz header prefix remapping --
    // tectonic expects #include <harfbuzz/hb.h> but the harfbuzz package
    // installs headers flat. create a virtual directory with the correct prefix.
    const hb_upstream = harfbuzz_dep.builder.dependency("harfbuzz", .{});
    const hb_headers = b.addWriteFiles();
    _ = hb_headers.addCopyDirectory(hb_upstream.path("src"), "harfbuzz", .{
        .include_extensions = &.{".h"},
    });

    // -- compiler flags --
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

    const c_flags = concatFlags3(b, &.{
        "-Wno-unused-parameter",
        "-Wno-implicit-fallthrough",
        "-Wno-sign-compare",
        "-fno-sanitize=undefined",
        "-std=gnu11",
    }, wasm_sjlj_flags, wasm_c_compat_flags);

    const cxx_flags = concatFlags(b, &.{
        "-Wno-unused-parameter",
        "-Wno-implicit-fallthrough",
        "-Wno-sign-compare",
        "-fno-sanitize=undefined",
        "-std=c++17",
        "-fno-exceptions",
        "-fno-rtti",
    }, wasm_sjlj_flags);

    // -- source directory paths (relative within package) --
    const src_prefix = "src";
    const xetex_dir = src_prefix ++ "/engine_xetex";
    const bridge_core_dir = src_prefix ++ "/bridge_core";
    const bridge_flate_dir = src_prefix ++ "/bridge_flate";
    const xetex_layout_dir = src_prefix ++ "/xetex_layout";
    const pdf_io_dir = src_prefix ++ "/pdf_io";
    const xdvipdfmx_dir = src_prefix ++ "/engine_xdvipdfmx";

    // wasm-specific: force-include wasm_compat.h for pdf_io (declares mkstemp)
    const pdf_io_c_flags = if (is_wasm) blk: {
        const wasm_compat_path = b.pathFromRoot(src_prefix ++ "/wasm_stubs/wasm_compat.h");
        break :blk concatFlags(b, c_flags, &.{ "-include", wasm_compat_path });
    } else c_flags;

    // internal include paths shared across engine modules
    const internal_include_paths: []const []const u8 = &.{
        xetex_dir,
        bridge_core_dir,
        bridge_flate_dir,
        xetex_layout_dir,
        pdf_io_dir,
    };

    // ========================================
    // static library: bridge_core
    // ========================================
    const bridge_core_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    for (internal_include_paths) |p| bridge_core_mod.addIncludePath(b.path(p));
    addPlatformMacro(bridge_core_mod, is_wasm);

    const bridge_core = b.addLibrary(.{
        .name = "tectonic_bridge_core",
        .root_module = bridge_core_mod,
    });
    bridge_core.addCSourceFile(.{
        .file = b.path(bridge_core_dir ++ "/support.c"),
        .flags = c_flags,
    });
    // install headers so consumers can #include "tectonic_bridge_core.h"
    bridge_core.installHeadersDirectory(b.path(bridge_core_dir), "", .{
        .include_extensions = &.{".h"},
    });
    b.installArtifact(bridge_core);

    // ========================================
    // static library: engine_xetex (C files)
    // ========================================
    const engine_c_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    addEngineIncludes(engine_c_mod, b, internal_include_paths, harfbuzz_lib, freetype_lib, icuuc_lib, graphite2_lib, hb_headers, is_wasm);
    addPlatformMacro(engine_c_mod, is_wasm);
    engine_c_mod.addCMacro("GRAPHITE2_STATIC", "1");

    const engine_xetex_c = b.addLibrary(.{
        .name = "tectonic_engine_xetex_c",
        .root_module = engine_c_mod,
    });

    const engine_c_files_common: []const []const u8 = &.{
        "xetex-engine-interface.c",
        "xetex-errors.c",
        "xetex-ext.c",
        "xetex-ini.c",
        "xetex-io.c",
        "xetex-linebreak.c",
        "xetex-math.c",
        "xetex-output.c",
        "xetex-pagebuilder.c",
        "xetex-pic.c",
        "xetex-scaledmath.c",
        "xetex-shipout.c",
        "xetex-stringpool.c",
        "xetex-synctex.c",
        "xetex-texmfmp.c",
        "xetex-xetex0.c",
    };

    engine_xetex_c.addCSourceFiles(.{
        .root = b.path(xetex_dir),
        .files = engine_c_files_common,
        .flags = c_flags,
    });
    if (!is_wasm) {
        engine_xetex_c.addCSourceFiles(.{
            .root = b.path(xetex_dir),
            .files = &.{"xetex-macos.c"},
            .flags = c_flags,
        });
    }
    // install headers for xetex
    engine_xetex_c.installHeadersDirectory(b.path(xetex_dir), "", .{
        .include_extensions = &.{".h"},
    });
    b.installArtifact(engine_xetex_c);

    // ========================================
    // static library: engine_xetex (C++ files)
    // ========================================
    const engine_cxx_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .link_libcpp = !is_wasm,
    });
    addEngineIncludes(engine_cxx_mod, b, internal_include_paths, harfbuzz_lib, freetype_lib, icuuc_lib, graphite2_lib, hb_headers, is_wasm);
    addPlatformMacro(engine_cxx_mod, is_wasm);
    engine_cxx_mod.addCMacro("GRAPHITE2_STATIC", "1");

    const engine_xetex_cxx = b.addLibrary(.{
        .name = "tectonic_engine_xetex_cxx",
        .root_module = engine_cxx_mod,
    });
    engine_xetex_cxx.addCSourceFiles(.{
        .root = b.path(xetex_dir),
        .files = &.{
            "teckit-Engine.cpp",
            "xetex-XeTeXOTMath.cpp",
        },
        .flags = cxx_flags,
    });
    b.installArtifact(engine_xetex_cxx);

    // ========================================
    // static library: pdf_io
    // ========================================
    const pdf_io_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    pdf_io_mod.addIncludePath(b.path(pdf_io_dir));
    pdf_io_mod.addIncludePath(b.path(bridge_flate_dir));
    pdf_io_mod.addIncludePath(b.path(bridge_core_dir));
    addPlatformMacro(pdf_io_mod, is_wasm);
    pdf_io_mod.linkLibrary(libpng_lib);
    pdf_io_mod.linkLibrary(zlib_lib);

    const pdf_io = b.addLibrary(.{
        .name = "tectonic_pdf_io",
        .root_module = pdf_io_mod,
    });
    pdf_io.addCSourceFiles(.{
        .root = b.path(pdf_io_dir),
        .files = &.{
            "dpx-agl.c",
            "dpx-bmpimage.c",
            "dpx-cff.c",
            "dpx-cff_dict.c",
            "dpx-cid.c",
            "dpx-cidtype0.c",
            "dpx-cidtype2.c",
            "dpx-cmap.c",
            "dpx-cmap_read.c",
            "dpx-cmap_write.c",
            "dpx-cs_type2.c",
            "dpx-dpxconf.c",
            "dpx-dpxcrypt.c",
            "dpx-dpxfile.c",
            "dpx-dpxutil.c",
            "dpx-dvi.c",
            "dpx-dvipdfmx.c",
            "dpx-epdf.c",
            "dpx-error.c",
            "dpx-fontmap.c",
            "dpx-jp2image.c",
            "dpx-jpegimage.c",
            "dpx-mem.c",
            "dpx-mfileio.c",
            "dpx-mpost.c",
            "dpx-mt19937ar.c",
            "dpx-numbers.c",
            "dpx-otl_opt.c",
            "dpx-pdfcolor.c",
            "dpx-pdfdev.c",
            "dpx-pdfdoc.c",
            "dpx-pdfdraw.c",
            "dpx-pdfencoding.c",
            "dpx-pdfencrypt.c",
            "dpx-pdffont.c",
            "dpx-pdfnames.c",
            "dpx-pdfobj.c",
            "dpx-pdfparse.c",
            "dpx-pdfresource.c",
            "dpx-pdfximage.c",
            "dpx-pkfont.c",
            "dpx-pngimage.c",
            "dpx-pst.c",
            "dpx-pst_obj.c",
            "dpx-sfnt.c",
            "dpx-spc_color.c",
            "dpx-spc_dvipdfmx.c",
            "dpx-spc_dvips.c",
            "dpx-spc_html.c",
            "dpx-spc_misc.c",
            "dpx-spc_pdfm.c",
            "dpx-spc_tpic.c",
            "dpx-spc_util.c",
            "dpx-spc_xtx.c",
            "dpx-specials.c",
            "dpx-subfont.c",
            "dpx-t1_char.c",
            "dpx-t1_load.c",
            "dpx-tfm.c",
            "dpx-truetype.c",
            "dpx-tt_aux.c",
            "dpx-tt_cmap.c",
            "dpx-tt_glyf.c",
            "dpx-tt_gsub.c",
            "dpx-tt_post.c",
            "dpx-tt_table.c",
            "dpx-type0.c",
            "dpx-type1.c",
            "dpx-type1c.c",
            "dpx-unicode.c",
            "dpx-vf.c",
        },
        .flags = pdf_io_c_flags,
    });
    // install headers for pdf_io
    pdf_io.installHeadersDirectory(b.path(pdf_io_dir), "", .{
        .include_extensions = &.{".h"},
    });
    b.installArtifact(pdf_io);

    // ========================================
    // static library: engine_xdvipdfmx
    // ========================================
    const xdvipdfmx_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    for (internal_include_paths) |p| xdvipdfmx_mod.addIncludePath(b.path(p));
    xdvipdfmx_mod.addIncludePath(b.path(xdvipdfmx_dir));

    const engine_xdvipdfmx = b.addLibrary(.{
        .name = "tectonic_engine_xdvipdfmx",
        .root_module = xdvipdfmx_mod,
    });
    engine_xdvipdfmx.addCSourceFile(.{
        .file = b.path(xdvipdfmx_dir ++ "/dvipdfmx.c"),
        .flags = c_flags,
    });
    // install headers for xdvipdfmx
    engine_xdvipdfmx.installHeadersDirectory(b.path(xdvipdfmx_dir), "", .{
        .include_extensions = &.{".h"},
    });
    b.installArtifact(engine_xdvipdfmx);

    // install bridge_flate and xetex_layout headers too (for stub consumers)
    bridge_core.installHeadersDirectory(b.path(bridge_flate_dir), "", .{
        .include_extensions = &.{".h"},
    });
    bridge_core.installHeadersDirectory(b.path(xetex_layout_dir), "", .{
        .include_extensions = &.{".h"},
    });

    // ========================================
    // static library: engine_bibtex
    // ========================================
    const bibtex_dir = src_prefix ++ "/engine_bibtex";

    const bibtex_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    bibtex_mod.addIncludePath(b.path(bibtex_dir));
    bibtex_mod.addIncludePath(b.path(bridge_core_dir));
    addPlatformMacro(bibtex_mod, is_wasm);

    const engine_bibtex = b.addLibrary(.{
        .name = "tectonic_engine_bibtex",
        .root_module = bibtex_mod,
    });
    engine_bibtex.addCSourceFile(.{
        .file = b.path(bibtex_dir ++ "/bibtex.c"),
        .flags = c_flags,
    });
    engine_bibtex.installHeadersDirectory(b.path(bibtex_dir), "", .{
        .include_extensions = &.{".h"},
    });
    b.installArtifact(engine_bibtex);
}

// -- helper functions --

fn addPlatformMacro(mod: *std.Build.Module, is_wasm: bool) void {
    if (is_wasm) {
        mod.addCMacro("XETEX_WASM", "1");
    } else {
        mod.addCMacro("XETEX_MAC", "1");
    }
}

fn concatFlags(b: *std.Build, base: []const []const u8, extra: []const []const u8) []const []const u8 {
    if (extra.len == 0) return base;
    return std.mem.concat(b.allocator, []const u8, &.{ base, extra }) catch @panic("OOM");
}

fn concatFlags3(b: *std.Build, base: []const []const u8, a: []const []const u8, c: []const []const u8) []const []const u8 {
    if (a.len == 0 and c.len == 0) return base;
    return std.mem.concat(b.allocator, []const u8, &.{ base, a, c }) catch @panic("OOM");
}

fn addEngineIncludes(
    mod: *std.Build.Module,
    b: *std.Build,
    internal_paths: []const []const u8,
    harfbuzz_lib: *std.Build.Step.Compile,
    freetype_lib: *std.Build.Step.Compile,
    icuuc_lib: *std.Build.Step.Compile,
    graphite2_lib: *std.Build.Step.Compile,
    hb_headers: *std.Build.Step.WriteFile,
    is_wasm: bool,
) void {
    for (internal_paths) |p| mod.addIncludePath(b.path(p));
    mod.addIncludePath(hb_headers.getDirectory());
    mod.linkLibrary(harfbuzz_lib);
    mod.linkLibrary(freetype_lib);
    mod.linkLibrary(icuuc_lib);
    mod.linkLibrary(graphite2_lib);
    // wasm: add fontconfig stub headers
    if (is_wasm) mod.addIncludePath(b.path("src/wasm_stubs"));
}
