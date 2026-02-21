const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const upstream = b.dependency("graphite", .{});

    const lib = b.addLibrary(.{
        .name = "graphite2",
        .linkage = .static,
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .link_libcpp = true,
        }),
    });

    lib.root_module.addIncludePath(upstream.path("include"));
    lib.root_module.addIncludePath(upstream.path("src"));

    lib.root_module.addCMacro("GRAPHITE2_STATIC", "1");
    lib.root_module.addCMacro("GRAPHITE2_NFILEFACE", "1");
    lib.root_module.addCMacro("GRAPHITE2_NTRACING", "1");

    const cxx_flags: []const []const u8 = &.{
        "-fno-rtti",
        "-fno-exceptions",
        "-fno-sanitize=undefined",
        "-fvisibility=hidden",
        "-fvisibility-inlines-hidden",
        "-Wno-unknown-pragmas",
    };

    // core source files from files.mk / CMakeLists.txt
    // using call_machine for portability (direct_machine requires gcc computed gotos)
    lib.addCSourceFiles(.{
        .root = upstream.path("src"),
        .files = &.{
            "call_machine.cpp",
            "gr_char_info.cpp",
            "gr_face.cpp",
            "gr_features.cpp",
            "gr_font.cpp",
            "gr_logging.cpp",
            "gr_segment.cpp",
            "gr_slot.cpp",
            "CmapCache.cpp",
            "Code.cpp",
            "Collider.cpp",
            "Decompressor.cpp",
            "Face.cpp",
            "FeatureMap.cpp",
            "Font.cpp",
            "GlyphCache.cpp",
            "GlyphFace.cpp",
            "Intervals.cpp",
            "Justifier.cpp",
            "NameTable.cpp",
            "Pass.cpp",
            "Position.cpp",
            "Segment.cpp",
            "Silf.cpp",
            "Slot.cpp",
            "Sparse.cpp",
            "TtfUtil.cpp",
            "UtfCodec.cpp",
        },
        .flags = cxx_flags,
    });

    // install public headers under graphite2/ prefix so consumers get
    // #include <graphite2/Font.h> etc.
    lib.installHeadersDirectory(upstream.path("include/graphite2"), "graphite2", .{});

    b.installArtifact(lib);
}
