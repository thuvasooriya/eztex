const std = @import("std");

// local ICU wrapper package -- based on akunaakwei/zig-icu build.zig
// with WASM/WASI support: stub threading headers, no mmap, no libc++

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const is_wasm = target.result.cpu.arch == .wasm32;
    const linkage = b.option(std.builtin.LinkMode, "linkage", "Linkage type for the library") orelse .static;

    const icu_dep = b.dependency("icu", .{});
    const common_flags: []const []const u8 = &.{
        "-fno-exceptions",
        "-fno-sanitize=undefined",
        "-DWIN32_LEAN_AND_MEAN",
        "-DNOCRYPT",
    };
    // wasm: force-include a combined threading stubs header BEFORE any source code.
    // this pre-defines _LIBCPP_MUTEX and _LIBCPP_CONDITION_VARIABLE include guards
    // and provides no-op std::mutex/condition_variable, so when umutex.h does
    // #include <mutex>, the real libc++ header short-circuits (guard already defined).
    // -isystem approach FAILED because zig's implicit libc++ includes always have
    // higher priority than user -isystem flags in -cflags.
    const wasm_threading_stubs: []const []const u8 = if (is_wasm) &.{
        "-include",
        b.pathFromRoot("wasm_stubs/wasm_threading_stubs.h"),
    } else &.{};
    const wasm_flags: []const []const u8 = if (is_wasm) &.{
        "-DU_HAVE_MMAP=0",
        "-DU_HAVE_POPEN=0",
        "-DU_HAVE_PCLOSE=0",
        "-DU_TZSET=wasm_noop_tzset",
        "-DU_TIMEZONE=0",
    } else &.{};

    const uc_flags = concatFlags4(b, common_flags, wasm_threading_stubs, wasm_flags, &.{"-DU_COMMON_IMPLEMENTATION"});
    const stubdata_flags: []const []const u8 = &.{
        "-fno-exceptions",
        "-fno-sanitize=undefined",
        "-DWIN32_LEAN_AND_MEAN",
        "-DNOCRYPT",
    };

    // -- main icuuc library (target platform) --
    // uses stubdata (empty ICU data) for all targets. XeTeX doesn't need the 31MB
    // ICU data file -- BiDi, break iteration, and encoding conversion all work
    // with built-in library code. see docs/ICU_DATA_REFERENCE.md for details.
    const uc = b.addLibrary(.{
        .name = "icuuc",
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libcpp = true,
        }),
        .linkage = linkage,
    });

    uc.addIncludePath(icu_dep.path(b.pathJoin(&.{ "icu4c", "source", "common" })));

    uc.addCSourceFiles(.{
        .root = icu_dep.path(b.pathJoin(&.{ "icu4c", "source", "common" })),
        .files = icu_common_files,
        .flags = uc_flags,
    });

    uc.addCSourceFiles(.{
        .root = icu_dep.path(b.pathJoin(&.{ "icu4c", "source", "stubdata" })),
        .files = &.{"stubdata.cpp"},
        .flags = stubdata_flags,
    });

    uc.installHeadersDirectory(
        icu_dep.path(b.pathJoin(&.{ "icu4c", "source", "common", "unicode" })),
        "unicode",
        .{},
    );
    b.installArtifact(uc);
}

const icu_common_files: []const []const u8 = &.{
    "appendable.cpp",
    "bmpset.cpp",
    "brkeng.cpp",
    "brkiter.cpp",
    "bytesinkutil.cpp",
    "bytestream.cpp",
    "bytestrie.cpp",
    "bytestriebuilder.cpp",
    "bytestrieiterator.cpp",
    "caniter.cpp",
    "characterproperties.cpp",
    "chariter.cpp",
    "charstr.cpp",
    "cmemory.cpp",
    "cstr.cpp",
    "cstring.cpp",
    "cwchar.cpp",
    "dictbe.cpp",
    "dictionarydata.cpp",
    "dtintrv.cpp",
    "edits.cpp",
    "emojiprops.cpp",
    "errorcode.cpp",
    "filteredbrk.cpp",
    "filterednormalizer2.cpp",
    "icudataver.cpp",
    "icuplug.cpp",
    "loadednormalizer2impl.cpp",
    "localebuilder.cpp",
    "localematcher.cpp",
    "localeprioritylist.cpp",
    "locavailable.cpp",
    "locbased.cpp",
    "locdispnames.cpp",
    "locdistance.cpp",
    "locdspnm.cpp",
    "locid.cpp",
    "loclikely.cpp",
    "loclikelysubtags.cpp",
    "locmap.cpp",
    "locresdata.cpp",
    "locutil.cpp",
    "lsr.cpp",
    "lstmbe.cpp",
    "messagepattern.cpp",
    "mlbe.cpp",
    "normalizer2.cpp",
    "normalizer2impl.cpp",
    "normlzr.cpp",
    "parsepos.cpp",
    "patternprops.cpp",
    "pluralmap.cpp",
    "propname.cpp",
    "propsvec.cpp",
    "punycode.cpp",
    "putil.cpp",
    "rbbi.cpp",
    "rbbi_cache.cpp",
    "rbbidata.cpp",
    "rbbinode.cpp",
    "rbbirb.cpp",
    "rbbiscan.cpp",
    "rbbisetb.cpp",
    "rbbistbl.cpp",
    "rbbitblb.cpp",
    "resbund.cpp",
    "resbund_cnv.cpp",
    "resource.cpp",
    "restrace.cpp",
    "ruleiter.cpp",
    "schriter.cpp",
    "serv.cpp",
    "servlk.cpp",
    "servlkf.cpp",
    "servls.cpp",
    "servnotf.cpp",
    "servrbf.cpp",
    "servslkf.cpp",
    "sharedobject.cpp",
    "simpleformatter.cpp",
    "static_unicode_sets.cpp",
    "stringpiece.cpp",
    "stringtriebuilder.cpp",
    "uarrsort.cpp",
    "ubidi.cpp",
    "ubidi_props.cpp",
    "ubidiln.cpp",
    "ubiditransform.cpp",
    "ubidiwrt.cpp",
    "ubrk.cpp",
    "ucase.cpp",
    "ucasemap.cpp",
    "ucasemap_titlecase_brkiter.cpp",
    "ucat.cpp",
    "uchar.cpp",
    "ucharstrie.cpp",
    "ucharstriebuilder.cpp",
    "ucharstrieiterator.cpp",
    "uchriter.cpp",
    "ucln_cmn.cpp",
    "ucmndata.cpp",
    "ucnv.cpp",
    "ucnv2022.cpp",
    "ucnv_bld.cpp",
    "ucnv_cb.cpp",
    "ucnv_cnv.cpp",
    "ucnv_ct.cpp",
    "ucnv_err.cpp",
    "ucnv_ext.cpp",
    "ucnv_io.cpp",
    "ucnv_lmb.cpp",
    "ucnv_set.cpp",
    "ucnv_u16.cpp",
    "ucnv_u32.cpp",
    "ucnv_u7.cpp",
    "ucnv_u8.cpp",
    "ucnvbocu.cpp",
    "ucnvdisp.cpp",
    "ucnvhz.cpp",
    "ucnvisci.cpp",
    "ucnvlat1.cpp",
    "ucnvmbcs.cpp",
    "ucnvscsu.cpp",
    "ucnvsel.cpp",
    "ucol_swp.cpp",
    "ucptrie.cpp",
    "ucurr.cpp",
    "udata.cpp",
    "udatamem.cpp",
    "udataswp.cpp",
    "uenum.cpp",
    "uhash.cpp",
    "uhash_us.cpp",
    "uidna.cpp",
    "uinit.cpp",
    "uinvchar.cpp",
    "uiter.cpp",
    "ulist.cpp",
    "uloc.cpp",
    "uloc_keytype.cpp",
    "uloc_tag.cpp",
    "ulocale.cpp",
    "ulocbuilder.cpp",
    "umapfile.cpp",
    "umath.cpp",
    "umutablecptrie.cpp",
    "umutex.cpp",
    "unames.cpp",
    "unifiedcache.cpp",
    "unifilt.cpp",
    "unifunct.cpp",
    "uniset.cpp",
    "uniset_closure.cpp",
    "uniset_props.cpp",
    "unisetspan.cpp",
    "unistr.cpp",
    "unistr_case.cpp",
    "unistr_case_locale.cpp",
    "unistr_cnv.cpp",
    "unistr_props.cpp",
    "unistr_titlecase_brkiter.cpp",
    "unorm.cpp",
    "unormcmp.cpp",
    "uobject.cpp",
    "uprops.cpp",
    "ures_cnv.cpp",
    "uresbund.cpp",
    "uresdata.cpp",
    "usc_impl.cpp",
    "uscript.cpp",
    "uscript_props.cpp",
    "uset.cpp",
    "uset_props.cpp",
    "usetiter.cpp",
    "ushape.cpp",
    "usprep.cpp",
    "ustack.cpp",
    "ustr_cnv.cpp",
    "ustr_titlecase_brkiter.cpp",
    "ustr_wcs.cpp",
    "ustrcase.cpp",
    "ustrcase_locale.cpp",
    "ustrenum.cpp",
    "ustrfmt.cpp",
    "ustring.cpp",
    "ustrtrns.cpp",
    "utext.cpp",
    "utf_impl.cpp",
    "util.cpp",
    "util_props.cpp",
    "utrace.cpp",
    "utrie.cpp",
    "utrie2.cpp",
    "utrie2_builder.cpp",
    "utrie_swap.cpp",
    "uts46.cpp",
    "utypes.cpp",
    "uvector.cpp",
    "uvectr32.cpp",
    "uvectr64.cpp",
    "wintz.cpp",
};

fn concatFlags4(b: *std.Build, a: []const []const u8, b2: []const []const u8, c: []const []const u8, d: []const []const u8) []const []const u8 {
    if (b2.len == 0 and c.len == 0 and d.len == 0) return a;
    return std.mem.concat(b.allocator, []const u8, &.{ a, b2, c, d }) catch @panic("OOM");
}
