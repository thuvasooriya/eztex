# pdfTeX WASM Integration Research

## 1. pdfTeX Source Options

**TeX Live pdfTeX** is the canonical source. The relevant C files are:

- Core engine: `tex/pdftex0.c`, `tex/pdftexini.c`, `tex/pdftex-pool.c`
- PDF backend: `pdftexdir/*.c` (PDF writing, font embedding, image handling)
- PDF-to-ePDF: `pdftexdir/pdftoepdf.cc` (requires xpdf or poppler for PDF inclusion)
- xpdf library: `xpdf/*.c` (PDF parsing for `\includepdf` and similar)
- Support: `main.c`, `md5.c`, `xmemory.c`, `texfile.c`
- kpathsea emulation: `kpseemu.c` (SwiftLaTeX's shim layer)

**Tectonic has no pdfTeX engine.** Confirmed by inspecting `crates/` — only `engine_xetex`, `engine_xdvipdfmx`, `engine_bibtex`, `engine_spx2html` exist. Tectonic never ported pdfTeX because XeTeX was considered the successor. There is no ttbc-adapted pdfTeX source anywhere.

**SwiftLaTeX** has a working pdfTeX-to-WASM build using Emscripten. Their patched sources live in `pdftex.wasm/` and compile with `emcc`/`em++`. The patches are minimal — mostly `kpseemu.c` replacing kpathsea lookups with synchronous XHR, plus `main.c` exporting `_compileLaTeX`/`_compileFormat`/`_setMainEntry` entry points.

**What eztex already has vs what is needed:**

| Component | eztex has it | Notes |
|---|---|---|
| bridge_core (ttbc_*) | Yes | Engine-agnostic, reusable |
| XeTeX engine | Yes | C + C++ sources from tectonic |
| xdvipdfmx | Yes | XDV-to-PDF converter |
| pdfTeX engine | **No** | Must be sourced from TeX Live |
| kpathsea | **No** | pdfTeX depends on it; must emulate or replace |
| xpdf/poppler | **No** | Needed for PDF inclusion features in pdfTeX |
| pdflatex.fmt | **No** | Must be generated or bundled |

**Bottom line:** The only viable pdfTeX C source is TeX Live's, optionally using SwiftLaTeX's patches as a starting reference. No ttbc-adapted pdfTeX exists anywhere.

## 2. Bridge Compatibility

### The core problem

pdfTeX and XeTeX use **completely different I/O abstractions**:

- **XeTeX (in tectonic/eztex):** calls `ttbc_input_open`, `ttbc_input_read`, `ttbc_output_open`, `ttbc_output_write`, etc. These are defined in `tectonic_bridge_core_generated.h` and implemented by `Engine.zig`. The engine code was patched by tectonic to use these instead of kpathsea.

- **pdfTeX (TeX Live):** calls `kpse_find_file`, `kpse_find_pk`, `kpse_open_file`, plus standard `fopen`/`fread`/`fwrite` for actual I/O. kpathsea handles search paths, format detection, and filename resolution.

These APIs share zero surface area. They solve the same problem (find and read TeX files) but with incompatible calling conventions and semantics.

### Bridging strategies

**Option A: kpathsea shim that routes to ttbc_* (recommended)**

Write a `kpseemu.c` (similar to SwiftLaTeX's) that implements `kpse_find_file` and friends by calling into `ttbc_input_open`/`ttbc_output_open`. This is a translation layer:

```
pdfTeX C code -> kpse_find_file() -> kpseemu.c -> ttbc_input_open() -> Engine.zig -> WASM host
```

Estimated shim surface: ~10-15 kpathsea functions. SwiftLaTeX's `kpseemu.c` is a working reference, but it routes to Emscripten MemFS + XHR rather than ttbc. We would need to rewrite the backends to call ttbc functions instead.

Advantages: minimal patches to pdfTeX source, SwiftLaTeX proves the approach works.

Disadvantages: semantic mismatches (kpathsea has search paths and format types that ttbc doesn't model), potential edge cases in font/format finding.

**Option B: Patch pdfTeX to call ttbc_* directly**

This is what tectonic did for XeTeX — a deep fork replacing all kpathsea calls with ttbc equivalents throughout the engine source. For XeTeX, this was ~months of work by the tectonic team.

Advantages: cleanest integration, no translation layer overhead.

Disadvantages: massive effort, creates a fork that must be maintained against upstream pdfTeX changes, and tectonic explicitly chose not to do this.

**Option C: WASI filesystem passthrough**

Since eztex already uses `@bjorn3/browser_wasi_shim` for WASI, pdfTeX's `fopen`/`fread` calls would go through WASI. The problem is file *discovery* — pdfTeX still needs kpathsea to know *which* file to open. This doesn't eliminate the kpathsea dependency, just the I/O part.

**Recommendation: Option A.** Write a kpseemu shim routing to ttbc. It is the only approach with a proven reference implementation (SwiftLaTeX) and manageable scope.

### Can Engine.zig's bridge be shared?

**Yes, mostly.** The ttbc_* exports in Engine.zig are engine-agnostic by design. pdfTeX would call the same `ttbc_input_open`, `ttbc_input_read`, `ttbc_output_open`, `ttbc_output_write` through the kpseemu shim. The diagnostics functions (`ttbc_issue_warning`, `ttbc_issue_error`, `ttbc_diag_*`) and utility functions (`ttbc_get_file_md5`, `ttbc_get_data_md5`) are also reusable as-is.

What would NOT be shared:
- The entry point (`tt_engine_xetex_main` vs a new `tt_engine_pdftex_main`)
- xdvipdfmx is XeTeX-specific (pdfTeX produces PDF directly)
- Shell escape semantics may differ slightly

## 3. Dual-Engine Architecture

### Current flow (XeTeX only)

```
.tex -> tt_engine_xetex_main() -> .xdv -> tt_engine_xdvipdfmx_main() -> .pdf
```

### Proposed flow (XeTeX + pdfTeX)

```
XeTeX path: .tex -> tt_engine_xetex_main() -> .xdv -> tt_engine_xdvipdfmx_main() -> .pdf
pdfTeX path: .tex -> tt_engine_pdftex_main() -> .pdf (direct)
```

pdfTeX is simpler at the pipeline level — one engine call, no intermediate format.

### Shared vs engine-specific components

**Shared (no changes needed):**
- `Engine.zig` — all ttbc_* exports
- `hosts/wasm.zig` — WASM host I/O (js_request_range, js_request_index)
- `wasm_exports.zig` — eztex_* surface (may need minor additions)
- `app/src/worker/engine.ts` — JS orchestrator (needs engine selection logic)
- bridge_core C library
- pdf_io library (used by xdvipdfmx but pdfTeX has its own PDF writer)

**Engine-specific (new for pdfTeX):**
- `engine_pdftex` C library — the pdfTeX sources compiled with Zig's C compiler
- `kpseemu.c` — kpathsea-to-ttbc shim
- xpdf C library — for PDF inclusion support
- `pdflatex.fmt` — format file (must be generated and bundled in the tar)

**Modified:**
- `build.zig` — add `engine_pdftex` and `xpdf` library definitions
- `pkg/tectonic/build.zig` — add pdftex build steps
- `Compiler.zig` — add `Format.pdflatex`, engine selection, simplified pipeline (no xdvipdfmx step)
- `wasm_exports.zig` — expose engine choice to JS
- `engine.ts` — pass engine selection, handle direct PDF output

### Engine selection: compile-time vs runtime

**Runtime selection (recommended).** The WASM binary should contain both engines. Compiler.zig already has a `Format` enum — extend it:

```zig
pub const Format = enum {
    plain,
    xelatex,
    pdflatex, // new
};
```

The JS side picks the engine based on user choice or document preamble detection. This avoids shipping two separate WASM binaries (which would double download size and complicate caching).

**Compile-time selection** (via `build.zig` option) could be offered as an optimization for deployments that only need one engine, but should not be the primary path.

### Impact on WASM binary size

Current eztex WASM includes XeTeX + xdvipdfmx + HarfBuzz + ICU + FreeType + Graphite + libpng. Adding pdfTeX adds:
- pdfTeX engine C code: ~200-400KB compiled
- xpdf library: ~300-500KB compiled
- kpseemu shim: negligible

Rough estimate: +500KB-1MB to WASM binary. Acceptable given the current binary is likely several MB already.

## 4. WASM Instance Strategy Comparison

### SwiftLaTeX approach

| Aspect | Implementation |
|---|---|
| Build system | Emscripten (emcc/em++) |
| Filesystem | Emscripten MemFS (in-memory, JS-managed) |
| File resolution | kpseemu.c -> synchronous XHR to texlive CDN endpoint |
| Engine isolation | Separate WASM binaries (pdftex.wasm, xetex.wasm, dvipdfm.wasm) |
| State management | Heap snapshot: dump entire WASM linear memory after init, restore before each compile |
| Threading | Single-threaded, Web Worker per engine |
| Entry points | _compileLaTeX, _compileFormat, _compileBibtex, _setMainEntry |
| Format loading | MemFS pre-populated with .fmt file |

### eztex approach

| Aspect | Implementation |
|---|---|
| Build system | Zig (compiles C/C++ via zig cc, links natively) |
| Filesystem | WASI shim (@bjorn3/browser_wasi_shim) + ttbc callbacks for TeX I/O |
| File resolution | ttbc_input_open -> Engine.zig -> WASM export -> JS -> synchronous XHR Range on tar bundle |
| Engine isolation | Single WASM binary (all engines linked together) |
| State management | Fresh WASM instance per compile (no heap snapshot) |
| Threading | Single-threaded, one Web Worker |
| Entry points | eztex_* exports wrapping tt_engine_*_main |
| Format loading | .fmt fetched via tar bundle range requests |

### Key differences that matter for pdfTeX integration

**Filesystem abstraction:** SwiftLaTeX uses MemFS which gives pdfTeX a fake POSIX filesystem — `fopen`/`fread` "just work" because Emscripten intercepts them. eztex uses WASI for POSIX calls and ttbc for TeX-specific I/O. For pdfTeX in eztex, WASI would handle standard file I/O while kpseemu routes file discovery to ttbc. This is actually cleaner than SwiftLaTeX's approach because the layers are explicit.

**Heap snapshot vs fresh instances:** SwiftLaTeX's heap snapshot trick avoids re-running pdfTeX's initialization on every compile (~100ms+ saved). eztex creates a fresh WASM instance per compile. For pdfTeX, this means paying initialization cost each time. If this becomes a perf problem, we could implement a similar snapshot mechanism, but it should not block initial integration.

**Single vs multiple WASM binaries:** eztex's single-binary approach means both XeTeX and pdfTeX code is always loaded, even if only one is used. The size overhead is modest (~500KB-1MB). The advantage is simpler deployment and caching — one URL, one binary, one instantiation path.

**Build system:** This is eztex's biggest advantage. Zig compiles C/C++ natively — no Emscripten, no `emcc` toolchain, no MemFS runtime. pdfTeX's C sources can be added to `build.zig` the same way XeTeX's were added. SwiftLaTeX's Makefile shows exactly which source files and defines are needed; we translate that to Zig build steps.

## 5. Recommendations

### Prioritized action list

**Phase 1: Prove it compiles (effort: Medium)**

1. Copy TeX Live pdfTeX C sources into `pkg/tectonic/src/engine_pdftex/`
2. Write `kpseemu.c` that implements kpse_find_file/kpse_open_file by calling ttbc_input_open/ttbc_output_open. Use SwiftLaTeX's kpseemu.c as reference but rewrite the backends.
3. Write a `main.c` entry point exporting `tt_engine_pdftex_main(dump_name, input_file, build_date)` matching the ttbc calling convention pattern from XeTeX's `xetex-engine-interface.c`
4. Add `engine_pdftex` library to `pkg/tectonic/build.zig` and `build.zig`. Use SwiftLaTeX's Makefile for the file list and defines.
5. Get it to compile to WASM with Zig. Fix includes, missing symbols, platform ifdefs. This will be the bulk of the work.

**Phase 2: Make it run (effort: Medium)**

6. Extend `Compiler.zig` with `Format.pdflatex` and a pdfTeX compile path (no xdvipdfmx step).
7. Generate `pdflatex.fmt` — either cross-compile a format generation step or use a pre-built one from TeX Live / SwiftLaTeX.
8. Add pdflatex.fmt to the tar bundle.
9. Wire up JS side: engine selection in `engine.ts`, handle direct PDF output (no XDV intermediate).
10. Test with a minimal `\documentclass{article} \begin{document} Hello \end{document}`.

**Phase 3: Production quality (effort: Large)**

11. Test font support — pdfTeX uses Type1/TrueType via its own font subsetting, not HarfBuzz/ICU. Ensure fonts are findable via kpseemu -> ttbc.
12. Test PDF inclusion (`\includegraphics` with PDF files) — requires xpdf library to work.
13. Test common packages (geometry, graphicx, hyperref, amsmath, etc.)
14. Performance: measure compile time vs XeTeX path. Consider heap snapshot if init cost is high.
15. Size audit: measure WASM binary size increase, optimize if needed.

### What to defer or skip

- **xpdf/poppler PDF inclusion:** Complex C++ dependency. Start without it (`\includegraphics` for PNG/JPEG should work, PDF inclusion can come later).
- **Heap snapshot optimization:** Not needed for correctness. Add later if perf requires it.
- **Compile-time engine selection:** Runtime selection is simpler and sufficient. Compile-time toggle is a nice-to-have optimization.
- **bibtex with pdfTeX:** eztex already has engine_bibtex. It should work with pdfTeX since bibtex is engine-independent. Verify, don't rewrite.

### Honest assessment of effort

This is a **significant** undertaking. The closest comparison is tectonic's original XeTeX port, which was a multi-month effort by experienced developers. However, several factors make pdfTeX easier:

- SwiftLaTeX proves pdfTeX compiles to WASM (source compatibility is not a question)
- The kpseemu shim approach is simpler than tectonic's deep-fork approach for XeTeX
- eztex's build system and bridge layer already exist and are engine-agnostic
- pdfTeX's pipeline is simpler (one step vs two)

**Realistic estimate: 2-4 weeks** for a working prototype (phases 1-2), assuming familiarity with the codebase. Phase 3 is ongoing hardening work.

### Risk: the xpdf/C++ dependency

pdfTeX's `pdftoepdf.cc` links against xpdf (or poppler) for reading PDF files embedded via `\includegraphics`. This is a substantial C++ library. Options:
- Compile xpdf with Zig's C++ compiler (should work, xpdf is relatively portable)
- Stub it out initially (PDF inclusion returns an error, everything else works)
- Use poppler instead (larger, more dependencies, probably worse)

**Recommendation: stub it out for phase 1-2, compile xpdf for phase 3.**

### Risk: format file generation

pdfTeX needs `pdflatex.fmt` which is generated by running pdfTeX in INI mode over the LaTeX sources. This is a chicken-and-egg problem when cross-compiling. Options:
- Use a pre-built pdflatex.fmt from TeX Live or SwiftLaTeX (quickest)
- Build a native pdfTeX and generate the fmt file as a build step (cleanest but requires native pdfTeX)
- Generate it in-browser on first run (slow, bad UX)

**Recommendation: use a pre-built fmt file initially, add native generation as a build step later.**
