# eztex file roles analysis: why each file exists

## executive summary

eztex is a Zig reimplementation of the Tectonic typesetting system. The architecture has three layers:
1. **src/ (Zig)**: new application logic, I/O bridge, and the layout API implementation
2. **csrc/ (C)**: thin irreducible C shims that cannot yet be eliminated
3. **pkg/tectonic/src/ (C/C++)**: upstream engine code -- hundreds of thousands of lines of C that would take years to rewrite

the key insight: Zig C interop lets you *call* C and *be called by* C, but it cannot magically *rewrite* C. the ~230 C/C++ files in pkg/ exist because they ARE the engines -- they are not wrappers around some library you could link.

---

## 1. csrc/xetex/layout.c -- the "irreducible C" claim

### purpose
FreeType singleton management, XeTeXFont_rec struct definition (canonical C-side), 10 HarfBuzz font callbacks, and HB/FT initialization helpers.

### the claim is MOSTLY WRONG -- this file CAN be eliminated

evidence from the codebase itself:

**HarfBuzz callbacks as Zig functions**: Layout.zig already uses `callconv(.c)` for 15+ function pointer callbacks (Graphite2 get_table/release_table, all platform font functions). Zig functions with `callconv(.c)` are valid C function pointers. The 10 HB callbacks in layout.c (hb_nominal_glyph_func, hb_h_advance_func, etc.) could be written identically in Zig and registered via `hb_font_funcs_set_*_func()`.

**FT_Face struct access from Zig**: Layout.zig already defines `FT_FacePartial` (an extern struct matching FT_FaceRec_ up through the `glyph` field) and accesses `face.num_faces`, `face.face_flags`, `face.num_glyphs` from Zig. the HB callbacks in layout.c access `face->glyph->metrics.*` and `face->glyph->outline.points` -- these just need one more level of partial struct definition (`FT_GlyphSlotPartial` with metrics/outline fields). this is straightforward.

**FreeType singleton from Zig**: Layout.zig already uses `extern var ft_face_count: c_int` and `extern fn get_ft_library()`. These could be Zig globals with `export` instead.

**XeTeXFont_rec**: already mirrored in Layout.zig as `extern struct`. the C definition could be deleted and the Zig one made canonical.

### what made it seem irreducible (but isn't)

the original developer likely kept it because:
- FreeType's header maze (`FT_FREETYPE_H` macro indirection, `ft2build.h`) is annoying for @cImport. but Layout.zig already avoids @cImport entirely -- it uses manual `extern fn` declarations for every FT/HB function it needs. the same approach works for the callback functions.
- the `__builtin_wasm_throw` in sjlj_rt.c is genuinely C-only, but layout.c doesn't use it.
- inertia from porting incrementally -- the HB callbacks were the last piece and were left in C.

### could it be eliminated: YES

estimated effort: **short** (a few hours). the pattern is already proven throughout Layout.zig. port the 10 callbacks, move the singleton globals, delete layout.c entirely.

---

## 2. tectonic_xetex_layout.h -- the header in pkg/

### purpose
declares the 80+ C-ABI function signatures that engine_xetex C code calls. this is the contract between the C engine (consumer) and the Zig Layout.zig (implementor).

### why it exists
the engine_xetex C files (xetex-ext.c, xetex-xetex0.c, etc.) `#include "tectonic_xetex_layout.h"` to get declarations for functions like `createFont()`, `layoutChars()`, `getGlyphWidth()`. those C files compile against this header. the actual implementations are `export fn` in Layout.zig -- the linker resolves them.

this is a **C header consumed by C code**. @cImport goes the other direction (Zig consuming C headers). there is no Zig mechanism to replace a header that C files include.

### architectural boundary
```
engine_xetex/*.c  --[#include]--> tectonic_xetex_layout.h  --[link]--> Layout.zig (export fn)
```
the header is the ABI contract. Layout.zig implements it. engine_xetex consumes it.

### could it be eliminated: NO

not unless the 36 engine_xetex C files are also rewritten in Zig. the header exists because C code needs it. even if Layout.zig is the implementation, the consumer is C and needs a `.h` file.

it could be *generated* from the Zig exports (zig has no built-in facility for this, but a build script could), which would prevent drift. but it cannot be deleted while engine_xetex is C.

---

## 3. pkg/tectonic/src/ -- the upstream C/C++ engines

### 3a. engine_xetex/ (36 files)

**purpose**: the actual XeTeX typesetting engine. 30+ years of TeX/WEB/Pascal-to-C lineage. xetex-xetex0.c alone is the main TeX processing loop. xetex-math.c handles math typesetting. xetex-linebreak.c handles paragraph breaking. xetex-ini.c handles format initialization.

**why it exists**: this IS the engine. you cannot replace it with extern declarations because there is no library to link against -- these files ARE the implementation. rewriting ~50k lines of deeply interconnected TeX engine logic in Zig would be a multi-year project with no functional benefit. Zig's C interop means you can *compile* this C code with the Zig build system and *link* it with Zig implementations of the bridge layer, which is exactly what eztex does.

**could it be eliminated**: NO. not without rewriting the entire XeTeX engine from scratch.

### 3b. engine_xdvipdfmx/ + pdf_io/ (149+ files)

**purpose**: the xdvipdfmx PDF backend. converts XeTeX's DVI output to PDF. pdf_io/ contains the full xdvipdfmx implementation (dpx-* files: PDF object handling, font embedding, image handling, CMap processing, etc.).

**why it exists**: same reason as engine_xetex. this is 149 files of mature, complex PDF generation code. it handles font subsetting, CID fonts, image embedding, PDF encryption, etc. no library provides this -- it IS the library.

**could it be eliminated**: NO.

### 3c. engine_bibtex/

**purpose**: the BibTeX bibliography processor. called via `bibtex_main()`.

**why it exists**: complete BibTeX engine implementation. same reasoning.

**could it be eliminated**: NO.

### 3d. bridge_core/ (support.c + headers)

**purpose**: C-side bridge between engines and the Zig I/O layer. provides:
- `setjmp/longjmp` error handling (`_tt_abort` -> `longjmp(jump_buffer, 1)`)
- `printf`-style wrappers (`ttstub_fprintf`, `ttstub_issue_warning`) that format strings then call into Zig
- Memory allocation wrappers (`xmalloc`, `xcalloc`, `xstrdup`) used everywhere in engine code
- `ttbc_global_engine_enter()` returns `jmp_buf*` for the C setjmp pattern

**why it cannot be pure Zig extern declarations**:
1. **setjmp/longjmp**: this is the critical reason. `setjmp()` stores stack context into a `jmp_buf`. the engines use `setjmp(*ttbc_global_engine_enter())` at their entry point and `_tt_abort()` calls `longjmp()` for fatal errors. Zig cannot implement `setjmp` -- it requires compiler support for saving/restoring the C stack frame. the `jmp_buf` must be a C-side global.
2. **variadic printf wrappers**: `_tt_abort(const char *format, ...)` uses C variadic functions + `vsnprintf`. Zig can call C variadics but cannot *define* them (Zig's `...` in extern fn is for calling, not implementing). these wrappers receive `...` args, format them, then call into Zig.
3. **ubiquitous consumption**: hundreds of call sites in engine_xetex, engine_xdvipdfmx, and engine_bibtex call `xmalloc`, `_tt_abort`, `ttstub_input_close`, etc. these are C functions called by C code, with C-specific patterns (printf format strings, setjmp contracts).

**could it be eliminated**: PARTIALLY. the xmalloc/xcalloc/xstrdup wrappers could be Zig `export fn`, but the setjmp/longjmp infrastructure and variadic printf wrappers must stay in C. practical benefit of partial elimination is near zero.

### 3e. bridge_flate/ (header only)

**purpose**: declares the `tectonic_flate_*` ABI (compress, decompress, streaming decompressor). the header is consumed by pdf_io/ and engine_xdvipdfmx/ C code.

**implementation**: in `src/Flate.zig`. compression delegates to zlib extern. decompression uses Zig `std.compress.flate`.

**why the header exists**: same as tectonic_xetex_layout.h -- C code needs to `#include` it.

**could it be eliminated**: NO (C consumers need it). the Zig implementation (Flate.zig) is already the sole implementation.

### 3f. wasm_stubs/ (fontconfig stub + wasm_compat.h)

**purpose**: on WASM, fontconfig is not available. provides a stub `fontconfig/fontconfig.h` with minimal type definitions so engine_xetex C code compiles. `wasm_compat.h` declares `mkstemp()` (missing from WASI libc headers).

**why Zig conditional compilation cannot replace it**: these are **C headers included by C source files**. the engine_xetex C code has `#include <fontconfig/fontconfig.h>`. on WASM, this header must resolve to something. Zig `comptime` branching only works within Zig code. the stub header approach is the standard C technique for this.

**could it be eliminated**: NO (while engine_xetex is C). if engine_xetex were rewritten in Zig, the fontconfig types would become Zig comptime conditionals.

---

## 4. csrc/wasm/ -- WASM runtime shims

### 4a. posix.c

**purpose**: provides `mkstemp()` and timezone stubs (`tzname`, `timezone`, `tzset`) for WASI targets. tectonic calls mkstemp for synctex temp files. ICU's putil.cpp requires timezone symbols.

**why Zig cannot replace it**:
- `mkstemp`: Zig's std has no mkstemp. the implementation uses POSIX `open(O_CREAT|O_EXCL)` which IS available in WASI. this COULD be rewritten in Zig as an `export fn mkstemp` using std.fs or direct WASI calls. however, the callers are C code expecting C linkage.
- `tzname`/`timezone`/`tzset`: these are C *global variables* and a C function expected by ICU C++ code at link time. Zig can `export` globals, so this is technically possible but the consumers are C/C++.

**could it be eliminated**: PARTIALLY. mkstemp could be Zig. the timezone globals could be Zig `export var`. but effort exceeds benefit for ~70 lines of C.

### 4b. sjlj_rt.c

**purpose**: implements `__wasm_setjmp`, `__wasm_longjmp`, `__wasm_setjmp_test` -- the runtime support for LLVM's wasm exception-handling-based setjmp/longjmp transform.

**why Zig CANNOT replace it**: uses `__builtin_wasm_throw(1, &jb->arg)`, which is a **clang compiler builtin** that emits a wasm `throw` instruction. Zig's LLVM backend does not expose this builtin. this is genuinely irreducible C -- the only way to emit a wasm throw instruction is through clang's builtin. the special compiler flags (`-mexception-handling`, `-mllvm -wasm-enable-sjlj`) enable LLVM's SjLj lowering pass.

additionally, `__wasm_setjmp` and `__wasm_longjmp` must match the exact ABI that LLVM's `WebAssemblyLowerEmscriptenEHSjLj` pass generates. the compiler transforms `setjmp()` calls in ALL C code to call `__wasm_setjmp()` -- this is a compiler runtime obligation, not application code.

**could it be eliminated**: NO. this is the one truly irreducible C file in csrc/.

---

## 5. src/ Zig files -- the application layer

all src/ files are Zig because they represent **new code written for eztex**, not ported C. they benefit from Zig's safety, comptime, and expressive type system.

| file | role | why zig |
|---|---|---|
| **main.zig** | CLI entry point, argument parsing, command dispatch | new code; no C predecessor |
| **Compiler.zig** | multi-pass TeX compilation orchestration (xetex -> xdvipdfmx -> bibtex), format generation | new high-level logic wrapping C engine entry points via `extern fn` |
| **Engine.zig** | C ABI export layer: implements all `ttbc_*` bridge functions (input_open, output_write, etc.) called by bridge_core/support.c. manages global World/BundleStore state | the "Zig replaces Rust" layer -- upstream Tectonic had this in Rust. exports ~40 C-ABI functions |
| **World.zig** | core I/O abstraction: handle table, file open/read/seek/close, memory-backed inputs, output management | platform-agnostic file handle management, clean Zig design |
| **BundleStore.zig** | unified file resolution: cache -> index lookup -> range fetch -> cache write | content-addressed bundle access, HashMap-based index |
| **Host.zig** | comptime platform dispatch: native vs WASM for transport, storage, concurrency | `const Impl = if (is_wasm) @import("hosts/wasm.zig") else @import("hosts/native.zig")` -- zero-cost comptime abstraction |
| **hosts/native.zig** | native platform: HTTP range fetch (std.http), filesystem cache, OS threads | real I/O implementation |
| **hosts/wasm.zig** | WASM platform: sync XHR extern calls to JS, WASI filesystem | browser-compatible I/O |
| **Layout.zig** | all 80 layout API functions (font creation, shaping, glyph queries, CoreText/fontconfig platform font discovery) | the crown jewel of the Zig port -- 2133 lines replacing what was C++ in upstream Tectonic |
| **Flate.zig** | zlib/deflate bridge: compress via zlib extern, decompress via Zig std.compress.flate | Zig std provides decompression; only compression still delegates to C zlib |
| **Cache.zig** | content-addressed file cache (SHA-256 hashing, manifest, disk layout) | native-only, pure Zig |
| **FormatCache.zig** | content-addressed TeX format file cache (key = SHA256 of bundle_digest + engine_version + format_type) | deterministic cache invalidation, pure Zig |
| **Config.zig** | eztex.zon project config parser, default bundle URLs/digests | ZON is a Zig format; pure Zig |
| **Log.zig** | structured logging with platform-correct stderr (WASI fd_write vs POSIX) | cross-platform Zig I/O |
| **seeds.zig** | comptime file lists for batch prefetch (cold-cache optimization) | static data, comptime arrays |
| **wasm_exports.zig** | WASM export surface for JS host (eztex_alloc, eztex_push_index, etc.) | WASM-specific API, `pub export fn` |
| **Watcher.zig** | filesystem watcher (kqueue on macOS, inotify on Linux, mtime poll fallback) | comptime backend selection, native-only |
| **Project.zig** | project input resolution (directory/zip/single file), main .tex file detection | user-facing logic, delegates to MainDetect |
| **MainDetect.zig** | heuristic main .tex file detection (\documentclass scanning, known-name matching) | shared by native and WASM paths |

---

## elimination priority matrix

| file | can eliminate? | effort | benefit | priority |
|---|---|---|---|---|
| csrc/xetex/layout.c | YES | short | removes last unnecessary C file, simplifies build | **HIGH** |
| csrc/wasm/sjlj_rt.c | NO | - | - | n/a |
| csrc/wasm/posix.c | partially | quick | marginal | LOW |
| pkg/ headers (.h files) | NO | - | C consumers need them | n/a |
| pkg/ engine code | NO | years | no functional benefit | n/a |
| bridge_core/support.c | partially | medium | marginal (setjmp blocks full removal) | LOW |

---

## the one actionable finding

**csrc/xetex/layout.c should be absorbed into Layout.zig.** the "irreducible" claim is wrong. every pattern used in layout.c (C function pointers, FT_Face struct access, FreeType globals, HarfBuzz callback registration) is already demonstrated working in Zig within the same Layout.zig file. this would:
- eliminate the last unnecessary csrc/ file for native builds
- remove the dual-definition of XeTeXFont_rec (C canonical + Zig mirror)
- simplify the build (no xetex_layout C library step)
- reduce a class of potential ABI-mismatch bugs

the only genuinely irreducible C in csrc/ is sjlj_rt.c (needs `__builtin_wasm_throw`).
