- Focus areas: Structure analysis, code quality issues, abstraction quality, design patterns, comparison to TigerBeetle style
- Specific concerns: Zig 0.16 patterns, C FFI bridge layer quality, WASM support, comptime usage, I/O patterns with std.Io, memory management, error handling consistency
- Find specifically: leaky abstractions, redundancy/code duplication, inconsistent patterns, design smells, areas where TigerBeetle style principles would help

next steps

- pdflatex format generation
- Test matrix covering both backends
- Pre-existing xetex format generation bug (writes to CWD instead of tmp/)

Discoveries
Architecture Overview

- Multi-engine: XeTeX (default) and pdfTeX, backend selected at compile time via -Dbackend=xetex|pdftex; produces separate binaries (eztex, eztex-pdftex)
- Platform targets: Native macOS/Linux and WASM32, with comptime dispatch through Host.zig → hosts/native.zig or hosts/wasm.zig
- C bridge (XeTeX): Heavy FFI via ttbc*\* and ttstub*\* extern declarations across ~6 static libraries (tectonic_bridge_core, tectonic_engine_xetex_c, tectonic_engine_xetex_cxx, tectonic_pdf_io, tectonic_engine_xdvipdfmx, tectonic_engine_bibtex) in pkg/tectonic/
- C bridge (pdfTeX): Single pdftex_engine library in pkg/pdftex/, bridged via csrc/pdftex_bridge_shim.c + kpseemu.c. kpseemu rewrites kpse file-find calls to ttbc_input_open + spool-to-tempfile approach.
- Zig implements ~40 XeTeX layout functions natively in Layout.zig, called back from C
- Bundle system: ITAR format TAR, content-addressed cache (Cache.zig), range HTTP fetch, case-insensitive index (BundleStore.zig)
- SwiftLaTeX origins: pkg/pdftex/src/main.c still has ptexbanner = " (SwiftLaTeX PDFTeX 0.3.0)" — the pdfTeX sources are ported from SwiftLaTeX, not vanilla pdfTeX
  Project Status (from .opencode/SCRATCH.md)
  The project just completed Phase 4 (pdfTeX backend produces PDF end-to-end). Phase 5 (backend-scoped format cache, seeds, test matrix) is the declared next phase of feature work. The audit is a separate initiative running in parallel.
  Critical Issues Found

1. Hardcoded std.heap.c_allocator throughout (pervasive)

- Engine.zig, World.zig, Compiler.zig, wasm_exports.zig, hosts/native.zig, hosts/wasm.zig, Flate.zig (~line 107), Layout.zig (lines 191, 221, 409), Project.zig (line 87), BundleStore.zig
- Makes testing harder, prevents allocator instrumentation, violates Zig idioms

2. Stubs masquerading as implementations in Compiler.zig — silently broken behavior

- read_file_contents() (~line 580): always returns null — aux change detection is broken
- current_build_date() (~line 320): always returns 1 — deterministic mode never uses real date
- cache_generated_format() (~line 450): is a no-op — format caching never persists to disk
- detect_use_color() (~line 290): always returns false — color output never works
- These produce silently incorrect behavior with no warnings to user

3. Global mutable state for C ABI callbacks (Engine.zig)

- global_world, global_bundle_store, global_io_instance at module scope
- Necessary for C callbacks but creates invisible coupling; not documented at call sites
- get_global_io() creates a fresh Io.Threaded on every call

4. load_cached_index in hosts/native.zig is broken (lines 299–318)

- Allocates buffer, @memset(content, 0), returns zeroed bytes — index cache never actually read from disk
- Comment says "TODO: Use proper file reading API"

5. remove_cache_symlinks in hosts/native.zig entirely commented out (lines 527–539)

- Cache symlink cleanup silently skipped

6. file_exists_check in Layout.zig (~line 2331) leaks Io.File handle

- Opens file, discards handle without closing

7. Mutex for batch_seed commented out in hosts/native.zig (lines 222–223, 264–267)

- Multiple threads write to cache simultaneously without synchronization — data race

8. AFM data intentional permanent leak in Layout.zig (~line 1500)

- Comment: "afm_data must remain valid while face is alive (intentional leak, same as C)"

9. ttstub_input_close in csrc/pdftex_bridge_shim.c is a no-op stub (line 46)

- Always returns 0; font file handles from pdftex backend are never actually closed

10. SwiftLaTeX banner still present in pkg/pdftex/src/main.c (lines 31–34)

- ptexbanner, DEFAULT_FMT_NAME, DEFAULT_DUMP_NAME, versionstring all say "SwiftLaTeX PDFTeX 0.3.0" — wrong identity for eztex
  Warnings Found

11. Compiler.zig is 1126 lines and mixes concerns

- Format generation, engine invocation, diagnostic formatting/parsing, path utilities, aux tracking, multi-pass logic all in one file
- Should be split: FormatGenerator.zig, DiagnosticParser.zig, CompileOrchestrator.zig

12. Redundant Io.Threaded creation scattered everywhere

- var threaded: std.Io.Threaded = .init_single_threaded; const io = threaded.io(); appears verbatim in Cache.zig (×2), Layout.zig (×3), hosts/wasm.zig (×2), hosts/native.zig (module-level). Canonical io should be passed in, not re-created.

13. BundleStore.has() calls ensure_index() without io parameter (~line 89)

- ensure_index(self, io) requires io, but has() calls try self.ensure_index() — signature inconsistency (likely compile error or already-fixed discrepancy)

14. Duplicate index parsing logic

- Cache.zig load_manifest() and BundleStore.zig parse_index_into() both manually parse whitespace-delimited text files with similar field-extraction logic

15. Three separate SHA-256 hex encoding implementations

- Cache.hash_content(), Config.compute_digest(), Config.digest_from_url(): three separate implementations of SHA-256 → hex-string

16. Config.digest_from_url() uses a global static buffer (Config.zig ~line 77)

- var runtime_digest_buf: [64]u8 = undefined; — second call with different URL overwrites first call's result

17. Dead code in Project.zig resolve_directory_project() (~lines 80–90)

- Defines Ctx struct then \_ = Ctx; read_fn passed as null — \documentclass detection never works for directory projects

18. Magic number 10 for newline in seeds.zig (lines 426, 438)

- out[pos] = 10; instead of '\n'

19. Fixed-size arrays with silent truncation in Cache.zig

- base_dir: [512]u8, manifest_path: [1024]u8 — silently truncate long paths; set_cache_dir truncates without error return

20. Thread count hardcoded to max 16 in batch_seed (hosts/native.zig ~line 279)

- var threads: [16]?std.Thread = .{null} \*\* 16; — ignores user-supplied concurrency beyond 16

21. Watcher.zig watch_file for inotify calls self.watch_dir(dir) without io parameter (~line 165)

- Missing argument — likely compile error or already-patched

22. Layout.zig register_bundle_fonts hardcodes "Tectonic" cache path (~line 2108)

- "{s}/Library/Caches/Tectonic/files" — should say "eztex", leftover from upstream

23. Shared mutable global buffers in Layout.zig (~lines 2307, 2324)

- mac_name_buf and mac_desc_buf — second call clobbers first call's result

24. BundleStore.open_file() pollutes cwd (~line 71)

- Io.Dir.cwd().createFile(io, name, .{}) — writes e.g. article.cls directly into current working directory

25. sleepMs in hosts/native.zig is a no-op (~lines 23–25)

- Retry logic calls sleepMs(500) but it does nothing — retries happen with no delay

26. Duplicate buildFlags / buildFlags3 helpers in build.zig AND pkg/tectonic/build.zig

- concatFlags/concatFlags3 (tectonic) and buildFlags/buildFlags3 (root) are identical logic; should live in a shared helper

27. kpseemu.c spool-to-tempfile approach has unbounded temp file growth

- Every kpse_find_file call creates a tempfile in /tmp; cleanup is registered via atexit() but only for one file at a time (the last xstrdup overwrites the pointer); prior tempfiles leak
  Design Smells

28. Engine.zig forces emission of unrelated modules via comptime side-effects

- comptime { _ = @import("Flate.zig"); _ = @import("Layout.zig"); \_ = @import("wasm_exports.zig"); } — module existence in binary depends on being imported from Engine.zig

29. FormatCache.zig is well-designed but cache_generated_format in Compiler.zig is a no-op stub — the cache is never used
30. Layout.zig is 2436 lines — mixes BBox cache, character protrusion, Graphite2 features, HarfBuzz font funcs, FreeType lifecycle, CoreText font discovery. Should be split.
31. pkg/pdftex/src/main.c pdftex_set_int_variable string-matches variable names at runtime (~line 644)

- A Zig-to-C control interface that uses strcmp on string keys instead of an enum/integer — fragile and untyped

32. tests/runner.zig detectTimeout() hardcodes ~/Library/Caches/eztex/v1/formats/xelatex.fmt path (~line 132)

- macOS-specific path; fails silently on Linux (defaults to 120s timeout, which is fine, but the detection is wrong)
