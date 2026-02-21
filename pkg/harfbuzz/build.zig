const std = @import("std");

// local harfbuzz wrapper -- based on allyourcodebase/harfbuzz build.zig
// fixes: unconditional -DHAVE_SYS_MMAN_H and -DHAVE_PTHREAD=1 for non-Windows
// which breaks WASM (WASI has no mman.h or pthreads)

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const is_wasm = target.result.cpu.arch == .wasm32;

    const coretext_enabled = b.option(bool, "enable-coretext", "Build coretext") orelse false;
    const freetype_enabled = b.option(bool, "enable-freetype", "Build freetype") orelse true;
    const graphite2_enabled = b.option(bool, "enable-graphite2", "Build with graphite2 shaper") orelse true;

    const upstream = b.dependency("harfbuzz", .{});
    const freetype_dep = b.dependency("freetype", .{
        .target = target,
        .optimize = optimize,
        .@"enable-libpng" = true,
    });

    const lib = b.addLibrary(.{
        .name = "harfbuzz",
        .linkage = .static,
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .link_libcpp = true,
        }),
    });
    lib.root_module.addIncludePath(upstream.path("src"));
    lib.root_module.linkLibrary(freetype_dep.artifact("freetype"));

    if (graphite2_enabled) {
        const graphite2_dep = b.dependency("graphite2", .{
            .target = target,
            .optimize = optimize,
        });
        lib.root_module.linkLibrary(graphite2_dep.artifact("graphite2"));
    }

    var flags: std.ArrayList([]const u8) = .empty;
    defer flags.deinit(b.allocator);

    try flags.appendSlice(b.allocator, &.{
        "-DHAVE_STDBOOL_H",
        "-fno-sanitize=undefined",
    });

    // WASM fix: only set mman.h and pthread flags for targets that actually support them
    // WASM also needs HB_NO_MT since libc++ <mutex> has no std::mutex for non-threaded targets
    if (target.result.os.tag != .windows and !is_wasm) {
        try flags.appendSlice(b.allocator, &.{
            "-DHAVE_UNISTD_H",
            "-DHAVE_SYS_MMAN_H",
            "-DHAVE_PTHREAD=1",
        });
    } else if (is_wasm) {
        try flags.appendSlice(b.allocator, &.{
            "-DHAVE_UNISTD_H",
            "-DHB_NO_MT",
        });
    }

    if (freetype_enabled) try flags.appendSlice(b.allocator, &.{
        "-DHAVE_FREETYPE=1",
        "-DHAVE_FT_GET_VAR_BLEND_COORDINATES=1",
        "-DHAVE_FT_SET_VAR_BLEND_COORDINATES=1",
        "-DHAVE_FT_DONE_MM_VAR=1",
        "-DHAVE_FT_GET_TRANSFORM=1",
    });
    if (graphite2_enabled) try flags.appendSlice(b.allocator, &.{
        "-DHAVE_GRAPHITE2=1",
    });
    if (coretext_enabled) {
        try flags.appendSlice(b.allocator, &.{"-DHAVE_CORETEXT=1"});
        lib.root_module.linkFramework("CoreText", .{});
    }

    lib.root_module.addCSourceFile(.{
        .file = upstream.path("src/harfbuzz.cc"),
        .flags = flags.items,
    });
    lib.installHeadersDirectory(
        upstream.path("src"),
        "",
        .{ .include_extensions = &.{".h"} },
    );

    b.installArtifact(lib);
}
