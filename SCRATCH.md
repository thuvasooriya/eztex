# Mission: EZTeX Architecture Overhaul

## Status: Phase 4 COMPLETE (pdfTeX backend produces PDF!)

### Phase 0: Backend Boundary Cleanup -- DONE
- Compiler.engine_display_name(), format_dump_name(), format_filename() comptime helpers
- Format.dump_name() and fmt_filename() delegate to helpers
- FormatCache.FormatType expanded with pdflatex = 2

### Phase 1: Vendor pdfTeX Sources -- DONE
- pkg/pdftex/ created with build.zig + build.zig.zon
- ~30 C/H files from SwiftLaTeX GitHub
- libpdftex_engine.a (2.3MB) builds standalone
- Excluded: pdftoepdf.cc (needs xpdf), writejbig2.c (needs jbig2dec)

### Phase 2: kpseemu.c Rewrite (ttbc Bridge) -- DONE
- Replaced orphaned kpse_find_file_js/kpse_find_pk_js with ttbc_* bridge
- Spool-to-tempfile approach: kpse_find_file -> ttbc_input_open -> read -> mkstemp -> return path
- Format enums are numerically identical (kpse_file_format_type == ttbc_file_format)
- Temp file cleanup via atexit() with xstrdup copy to avoid double-free
- pkg/pdftex builds standalone after rewrite

### Phase 3: Multi-Engine Build Graph -- DONE
- -Dbackend=xetex|pdftex build option (default: xetex)
- build_options module injected into Compiler.zig for comptime backend selection
- Conditional engine library linking: tectonic libs (xetex) vs pdftex_engine (pdftex)
- pdfTeX entry points: tt_engine_pdftex_main, tt_pdftex_set_int_variable in main.c
- Compiler.zig dispatches engine calls based on comptime backend
- xdvipdfmx skipped for pdftex (outputs PDF directly)
- bibtex gated at compile time (skipped for pdftex)
- Bridge shim for ttstub_input_close + ttbc_set_checkpoint_callback (Layout.zig compat)
- Stub file for JBIG2/PNG/PDF-inclusion (fail-fast abort, not silent success)
- utils.c, writeimg.c, writejpg.c, writezip.c added with zlib+libpng deps
- Both backends build: eztex (25MB) and eztex-pdftex (21MB)

### Phase 4: pdfTeX Runtime Integration -- DONE
- pdfTeX backend successfully compiles .tex to .pdf end-to-end
- Format generation: plain.fmt generated via INITEX with ttbc bridge for TFM/hyphen lookup
- InputSlot.read() bug fixed: was reading from offset `data.len` (EOF) instead of 0
  - Root cause: `f.readPositionalAll(io, data, data.len)` should be `f.readPositionalAll(io, data, 0)`
  - Fix: lazy-load file into memory on first read, then use mem_data path
- pdfinitmapfile re-entrancy: freed old mitem between INITEX and compile runs
- PDF output mode: set pdfoutputoption=1, pdfoutputvalue=1 to force PDF (not DVI)
- output_directory management: caller-managed via pdftex_set_string_variable
  - Set to "tmp" for INITEX, cleared to NULL for compile runs
- JBIG2 flush stub: no-op instead of abort (called unconditionally during PDF finalization)
- Format paths backend-scoped: tmp/plain-xetex.fmt vs tmp/plain-pdftex.fmt
- Verified outputs: the_letter_a.tex -> 10KB PDF, tex_logo.tex -> 9KB PDF, negative_roman_numeral.tex -> 10KB PDF

### Phase 5: Backend-Scoped Format Cache, Seeds, Test Matrix -- NEXT
- Content-addressed format cache already backend-aware (FormatCache.Key includes format_type)
- Need: pdflatex.fmt generation for pdftex backend
- Need: test matrix covering both backends with shared test files
- Known issue: xetex format generation writes to CWD instead of tmp/ (pre-existing, not regression)

### Phase 6: Io.Group Watch Mode -- FUTURE

### Phase 7: WASM Unblock -- BLOCKED (Zig upstream bug)

---

## Key Architectural Decisions

1. Comptime engine selection via -Dbackend (not runtime)
2. Separate binaries per engine (eztex, eztex-pdftex)
3. Spool-to-tempfile bridge for kpseemu (approach B, not approach A)
4. Bridge_core NOT linked for pdftex (tiny shim instead, avoids xmalloc conflicts)
5. Fail-fast stubs for missing features (JBIG2, PNG, PDF inclusion)
6. Both backends share: Layout.zig, Config.zig, World.zig, Engine.zig, BundleStore.zig
7. pdfTeX output goes directly to PDF (no xdvipdfmx step)
8. bibtex not linked for pdftex (could be added later)
9. pdfTeX C globals not fully reset between runs -- managed case-by-case in pdftex_main + Compiler.zig
10. Format paths are backend-scoped (tmp/plain-xetex.fmt vs tmp/plain-pdftex.fmt)

---

## Bugs Fixed in Phase 4

1. **InputSlot.read() offset bug**: `readPositionalAll(io, data, data.len)` -> `readPositionalAll(io, data, 0)`
   - Was reading from end-of-file offset, always returning 0 bytes
   - Caused "Bad metric (TFM) file" errors for all file-backed inputs
2. **pdfinitmapfile re-entrancy**: assert(mitem == NULL) triggered on second call
   - Fixed: free old mitem + line before reallocating
3. **PDF output mode**: pdfTeX defaulted to DVI mode (\pdfoutput=0)
   - Fixed: set pdfoutputoption=1, pdfoutputvalue=1, reset fixedpdfoutputset/initpdfoutput
4. **output_directory leak**: set to "tmp" during INITEX, persisted to compile run
   - Fixed: clear via pdftex_set_string_variable("output_directory", "") before compile
5. **JBIG2 flush abort**: flushjbig2page0objects() called unconditionally during PDF finalization
   - Fixed: changed from STUB_ABORT to no-op
6. **Format path collision**: both backends shared tmp/plain.fmt
   - Fixed: backend-specific fmt_path (tmp/plain-xetex.fmt, tmp/plain-pdftex.fmt)

---

## Build Commands

- `zig build` -> eztex (xetex backend, default)
- `zig build -Dbackend=pdftex` -> eztex-pdftex
- `zig build test` -> unit tests (all pass)
- `zig build -Dbackend=pdftex -Dtarget=wasm32-wasi` -> eztex-pdftex.wasm (blocked)
- `zig build -Dbackend=xetex wasm` -> eztex.wasm (blocked)

## Test Commands

- `./zig-out/bin/eztex-pdftex compile test.tex --format plain`
- `./zig-out/bin/eztex-pdftex compile test.tex --format plain --verbose` (debug output)
