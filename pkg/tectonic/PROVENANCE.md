# Tectonic Provenance

This directory contains C source code derived from the Tectonic project, a modernized TeX/XeTeX engine. The code has been extracted from Tectonic's Rust-crate layout and adapted for direct compilation as part of the eztex project.

## Origin

The source files in `pkg/tectonic/` originate from the Tectonic Project (https://tectonic-typesetting.github.io/), originally authored by Peter Williams and contributors. Based on copyright headers, the core code dates from 2016-2022, placing it in the Tectonic 0.12.x to 0.13.x era (2021-2023).

The upstream Tectonic project is a Rust-based TeX engine that embeds the XeTeX C sources. Our fork strips away the Rust crate wrapper and build system, exposing the C ABI directly to Zig via `Engine.zig`.

## File Inventory

```
pkg/tectonic/
├── build.zig                  # Zig build integration
├── build.zig.zon              # Zig package manifest
├── PROVENANCE.md              # This file
└── src/
    ├── bridge_core/           # C ABI bridge (3 files)
    │   ├── support.c
    │   ├── tectonic_bridge_core.h
    │   └── tectonic_bridge_core_generated.h
    ├── bridge_flate/          # Flate compression bridge (1 file)
    │   └── tectonic_bridge_flate.h
    ├── engine_bibtex/         # BibTeX engine (2 files)
    │   ├── bibtex.c
    │   └── bibtex.h
    ├── engine_xdvipdfmx/      # xdvipdfmx PDF output engine (2 files)
    │   ├── dvipdfmx.c
    │   └── xdvipdfmx_bindings.h
    ├── engine_xetex/          # XeTeX engine C sources (36 files)
    │   ├── teckit-c-Engine.h
    │   ├── teckit-Common.h
    │   ├── teckit-Compiler.h
    │   ├── teckit-cxx-Engine.h
    │   ├── teckit-Engine.cpp
    │   ├── teckit-Format.h
    │   ├── teckit-NormalizationData.c
    │   ├── xetex_bindings.h
    │   ├── xetex_format.h
    │   ├── xetex-constants.h
    │   ├── xetex-core.h
    │   ├── xetex-engine-interface.c
    │   ├── xetex-errors.c
    │   ├── xetex-ext.c
    │   ├── xetex-ext.h
    │   ├── xetex-ini.c
    │   ├── xetex-io.c
    │   ├── xetex-io.h
    │   ├── xetex-linebreak.c
    │   ├── xetex-macos.c
    │   ├── xetex-math.c
    │   ├── xetex-output.c
    │   ├── xetex-pagebuilder.c
    │   ├── xetex-pic.c
    │   ├── xetex-scaledmath.c
    │   ├── xetex-shipout.c
    │   ├── xetex-stringpool.c
    │   ├── xetex-stringpool.h
    │   ├── xetex-swap.h
    │   ├── xetex-synctex.c
    │   ├── xetex-synctex.h
    │   ├── xetex-texmfmp.c
    │   ├── xetex-xetex0.c
    │   ├── xetex-xetexd.h
    │   ├── xetex-XeTeXOTMath.cpp
    │   └── xetex-XeTeXOTMath.h
    ├── pdf_io/                # PDF I/O library (149 files)
    │   ├── dpx-agl.c / dpx-agl.h
    │   ├── dpx-bmpimage.c / dpx-bmpimage.h
    │   ├── dpx-cff.c / dpx-cff.h / dpx-cff_dict.c / dpx-cff_dict.h
    │   ├── dpx-cff_limits.h / dpx-cff_stdstr.h / dpx-cff_types.h
    │   ├── dpx-cid.c / dpx-cid.h / dpx-cid_basefont.h
    │   ├── dpx-cidtype0.c / dpx-cidtype0.h
    │   ├── dpx-cidtype2.c / dpx-cidtype2.h
    │   ├── dpx-cmap.c / dpx-cmap.h / dpx-cmap_p.h
    │   ├── dpx-cmap_read.c / dpx-cmap_read.h
    │   ├── dpx-cmap_write.c / dpx-cmap_write.h
    │   ├── dpx-cs_type2.c / dpx-cs_type2.h
    │   ├── dpx-dpxconf.c / dpx-dpxconf.h
    │   ├── dpx-dpxcrypt.c / dpx-dpxcrypt.h
    │   ├── dpx-dpxfile.c / dpx-dpxfile.h
    │   ├── dpx-dpxutil.c / dpx-dpxutil.h
    │   ├── dpx-dvi.c / dpx-dvi.h / dpx-dvicodes.h
    │   ├── dpx-dvipdfmx.c / dpx-dvipdfmx.h
    │   ├── dpx-epdf.c / dpx-epdf.h
    │   ├── dpx-error.c / dpx-error.h
    │   ├── dpx-fontmap.c / dpx-fontmap.h
    │   ├── dpx-jp2image.c / dpx-jp2image.h
    │   ├── dpx-jpegimage.c / dpx-jpegimage.h
    │   ├── dpx-mem.c / dpx-mem.h
    │   ├── dpx-mfileio.c / dpx-mfileio.h
    │   ├── dpx-mpost.c / dpx-mpost.h
    │   ├── dpx-mt19937ar.c
    │   ├── dpx-numbers.c / dpx-numbers.h
    │   ├── dpx-otl_opt.c / dpx-otl_opt.h
    │   ├── dpx-pdfcolor.c / dpx-pdfcolor.h
    │   ├── dpx-pdfdev.c / dpx-pdfdev.h
    │   ├── dpx-pdfdoc.c / dpx-pdfdoc.h
    │   ├── dpx-pdfdraw.c / dpx-pdfdraw.h
    │   ├── dpx-pdfencoding.c / dpx-pdfencoding.h
    │   ├── dpx-pdfencrypt.c / dpx-pdfencrypt.h
    │   ├── dpx-pdffont.c / dpx-pdffont.h
    │   ├── dpx-pdflimits.h
    │   ├── dpx-pdfnames.c / dpx-pdfnames.h
    │   ├── dpx-pdfobj.c / dpx-pdfobj.h
    │   ├── dpx-pdfparse.c / dpx-pdfparse.h
    │   ├── dpx-pdfresource.c / dpx-pdfresource.h
    │   ├── dpx-pdfximage.c / dpx-pdfximage.h
    │   ├── dpx-pkfont.c / dpx-pkfont.h
    │   ├── dpx-pngimage.c / dpx-pngimage.h
    │   ├── dpx-pst.c / dpx-pst.h / dpx-pst_obj.c / dpx-pst_obj.h
    │   ├── dpx-sfnt.c / dpx-sfnt.h
    │   ├── dpx-spc_color.c / dpx-spc_color.h
    │   ├── dpx-spc_dvipdfmx.c / dpx-spc_dvipdfmx.h
    │   ├── dpx-spc_dvips.c / dpx-spc_dvips.h
    │   ├── dpx-spc_html.c / dpx-spc_html.h
    │   ├── dpx-spc_misc.c / dpx-spc_misc.h
    │   ├── dpx-spc_pdfm.c / dpx-spc_pdfm.h
    │   ├── dpx-spc_tpic.c / dpx-spc_tpic.h
    │   ├── dpx-spc_util.c / dpx-spc_util.h
    │   ├── dpx-spc_xtx.c / dpx-spc_xtx.h
    │   ├── dpx-specials.c / dpx-specials.h
    │   ├── dpx-subfont.c / dpx-subfont.h
    │   ├── dpx-system.h
    │   ├── dpx-t1_char.c / dpx-t1_char.h
    │   ├── dpx-t1_load.c / dpx-t1_load.h
    │   ├── dpx-tfm.c / dpx-tfm.h
    │   ├── dpx-truetype.c / dpx-truetype.h
    │   ├── dpx-tt_aux.c / dpx-tt_aux.h
    │   ├── dpx-tt_cmap.c / dpx-tt_cmap.h
    │   ├── dpx-tt_glyf.c / dpx-tt_glyf.h
    │   ├── dpx-tt_gsub.c / dpx-tt_gsub.h
    │   ├── dpx-tt_post.c / dpx-tt_post.h
    │   ├── dpx-tt_table.c / dpx-tt_table.h
    │   ├── dpx-type0.c / dpx-type0.h
    │   ├── dpx-type1.c / dpx-type1.h
    │   ├── dpx-type1c.c / dpx-type1c.h
    │   ├── dpx-unicode.c / dpx-unicode.h
    │   └── dpx-vf.c / dpx-vf.h
    ├── wasm_stubs/             # WASM compatibility stubs (2 files)
    │   ├── fontconfig/
    │   └── wasm_compat.h
    └── xetex_layout/          # XeTeX layout bridge header (1 file)
        └── tectonic_xetex_layout.h
```

## Patch-Carrying Zone

The following 43 files differ from upstream Tectonic. These are our "patch-carrying zone" -- any upstream sync must reconcile changes in these files.

| Module | File | Notes |
|--------|------|-------|
| bridge_core | `support.c` | Bridge layer replaced for Zig ABI |
| bridge_core | `tectonic_bridge_core.h` | Bridge API declarations adapted |
| bridge_core | `tectonic_bridge_core_generated.h` | Generated bridge constants |
| engine_xetex | `xetex-engine-interface.c` | Engine interface modifications |
| engine_xetex | `xetex-errors.c` | Error handling adaptations |
| engine_xetex | `xetex-ext.c` | Glyph name fix + layout integration |
| engine_xetex | `xetex-ini.c` | Initialization modifications |
| engine_xetex | `xetex-io.c` | I/O layer modifications |
| engine_xetex | `xetex-output.c` | Output handling modifications |
| engine_xetex | `xetex-pic.c` | Picture handling modifications |
| engine_xetex | `xetex-shipout.c` | Ship-out modifications |
| engine_xetex | `xetex-synctex.c` | SyncTeX modifications |
| engine_xetex | `xetex-texmfmp.c` | texmf modifications |
| engine_xetex | `xetex-xetex0.c` | Core engine modifications |
| engine_xetex | `xetex_bindings.h` | Binding declarations adapted |
| engine_xdvipdfmx | `dvipdfmx.c` | Driver modifications |
| engine_xdvipdfmx | `xdvipdfmx_bindings.h` | Binding declarations adapted |
| pdf_io | `dpx-bmpimage.c` | |
| pdf_io | `dpx-cff.h` | |
| pdf_io | `dpx-cmap.c` | |
| pdf_io | `dpx-cmap_read.c` | |
| pdf_io | `dpx-dpxfile.c` | |
| pdf_io | `dpx-dvi.c` | |
| pdf_io | `dpx-error.c` | stdout handle caching fix |
| pdf_io | `dpx-error.h` | |
| pdf_io | `dpx-jpegimage.c` | |
| pdf_io | `dpx-mfileio.c` | |
| pdf_io | `dpx-numbers.c` | |
| pdf_io | `dpx-pdfdoc.c` | |
| pdf_io | `dpx-pdfencoding.c` | |
| pdf_io | `dpx-pdfobj.c` | |
| pdf_io | `dpx-pdfximage.c` | |
| pdf_io | `dpx-pkfont.c` | |
| pdf_io | `dpx-pngimage.c` | |
| pdf_io | `dpx-sfnt.h` | |
| pdf_io | `dpx-spc_dvips.c` | |
| pdf_io | `dpx-spc_misc.c` | |
| pdf_io | `dpx-spc_pdfm.c` | |
| pdf_io | `dpx-subfont.c` | |
| pdf_io | `dpx-t1_load.c` | |
| pdf_io | `dpx-tfm.c` | |
| pdf_io | `dpx-type1.c` | |
| pdf_io | `dpx-vf.c` | |

## Fork-Only Patches

Changes that exist in eztex but have **no upstream equivalent**. These must be preserved during any upstream sync.

### 1. XeTeXglyphname static buffer fix

- **File**: `src/engine_xetex/xetex-ext.c` (`print_glyph_name`)
- **Problem**: `GetGlyphNameFromCTFont` (AAT/macOS path) returns a pointer to `static char buffer[256]`, not a malloc'd string. Unconditionally calling `free()` on it caused crashes/memory corruption.
- **Fix**: Only call `freeGlyphName(s)` for the OTGR_FONT_FLAG path where `getGlyphName` allocates via malloc.

### 2. stdout handle caching in dpx-error.c

- **File**: `src/pdf_io/dpx-error.c`
- **Problem**: Upstream reopens stdout handle on every message call, causing handle exhaustion during xdvipdfmx post-processing.
- **Fix**: Cache the stdout handle after first open; reuse on subsequent calls.

### 3. Jobname prefix path fallback

- **File**: `src/World.zig` (`try_open_path`)
- **Behavior**: Strips jobname prefix when exact path fails. Handles projects where LaTeX references files with the project folder name as prefix.

### 4. Deterministic mtime override

- **File**: `src/World.zig` (`world.deterministic_mtime`)
- **Behavior**: Overrides file mtime for full reproducibility in deterministic mode. Complements the fixed build date (`current_build_date()` returns `1` in deterministic mode).

## Modifications from Upstream

### 1. Bridge Layer Replacement

Upstream Tectonic provides the bridge API via Rust functions. We replaced the Rust bridge with a pure Zig implementation in `src/Engine.zig` and `src/World.zig`. The C ABI exports (`ttbc_*`) are implemented in Zig and called by `support.c`.

### 2. Build System

Removed Cargo/Rust build. Added `build.zig` integration with:
- Direct C compilation via Zig's C compiler
- WASI target support with WebAssembly exception handling
- Custom `wasm_stubs/` runtime stubs

### 3. Dead Code Removal

Removed permanently unused backends:
- `csrc/pdftex_*.c` stubs (pdftex backend was never functional; `backend` enum hardcoded to `.xetex` in `src/Compiler.zig`)
- `pkg/texlive-pdftex/`, `pkg/pdftex-gen/`, `pkg/web2c/` directories
- `src/dpx/` directory (consolidated into `src/pdf_io/`)
- `src/font_libs/` directory (font handling via system libraries)
- `src/include/` directory (headers moved into respective modules)

### 4. Format Data Handling

Upstream loads `.fmt` files from disk via Rust I/O. We serve format files from memory via `World.set_format_data()` and `alloc_memory_input()`, allowing bundled format delivery in WASM builds.

## Known Gaps vs. Upstream

### High Priority

1. **Bridge hardening** (upstream ~2023)
   - Upstream replaced global `jmp_buf` in `bridge_core/support.c` with explicit `CoreBridgeLauncher` + state API plus mutex
   - Our `support.c` still uses the old single global `jmp_buf` pattern (lines 90-140)
   - Risk: not thread-safe; any concurrent bridge access is undefined behavior

2. **xetex_layout rewrite** (upstream 0.16.0)
   - Upstream rewrote `xetex_layout` entirely in Rust (replacing the C bridge header approach)
   - Our implementation is in Zig (`src/Layout.zig`) with `tectonic_xetex_layout.h` as the C bridge
   - Any upstream font layout fixes since 0.16.0 are in Rust and must be manually ported to Zig

### Medium Priority

3. **BibTeX Rust migration** (upstream 0.15.0)
   - Upstream removed C bibtex sources entirely, replacing with Rust implementation
   - We still carry `src/engine_bibtex/bibtex.c` and `bibtex.h`
   - Low risk if C bibtex remains functional, but will diverge from upstream over time

4. **xetex-ext.c layout function port** (eztex roadmap)
   - `find_native_font()`, `loadOTfont()`, `measure_native_node()` are prime candidates for Zig porting
   - Currently these still do bidi run splitting with per-run heap allocation around our Zig-owned `LayoutEngine`

5. **Deterministic mode completeness**
   - Upstream sets deterministic PDF unique tags via `pdf_font_set_deterministic_unique_tags()`
   - We now also override mtime via `world.deterministic_mtime` for full reproducibility
   - Build date is already fixed to `1` in deterministic mode (`Compiler.zig:current_build_date()`)

## Version Estimation

We do not have a clean upstream commit hash due to the extraction process. Based on copyright headers and code comparison:

| File | Copyright Range | Estimated Era |
|------|----------------|---------------|
| `xetex-ini.c` | 2016-2022 | Tectonic 0.12.x-0.13.x |
| `tectonic_bridge_core.h` | 2016-2020 | Tectonic 0.10.x-0.12.x |
| `dvipdfmx.c` | 2002-2020 | xdvipdfmx upstream 2020 |
| `xetex-ext.c` | 1994-2015 | XeTeX upstream 2015 |

Our best estimate: **Tectonic 0.12.x/0.13.x era, circa 2022-2023**, with XeTeX sources from 2015 and xdvipdfmx from 2020. The codebase predates the Rust xetex_layout rewrite (0.16.0) and the BibTeX Rust migration (0.15.0).

## Upstream Sync Strategy

To sync a bugfix from upstream Tectonic:

1. Locate the upstream commit at https://github.com/tectonic-typesetting/tectonic
2. Check if the fix touches C files in `crates/*/c/` (our `pkg/tectonic/src/`)
3. Cross-reference against the **patch-carrying zone** (43 files above) -- if the file is in the zone, manual merge is required
4. Apply the patch manually -- our directory layout differs from upstream's crate structure
5. Run `zig build test` to verify integration tests still pass
6. For changes to `bridge_core/support.c`, also update `src/Engine.zig` ABI exports if needed
7. For changes to `pdf_io/` or `engine_xetex/`, check if the upstream fix overlaps with our fork-only patches

## License

Tectonic sources are licensed under the MIT License (see individual file headers).
XeTeX sources (`xetex-*.c`, `xetex-ext.c`) are under the MIT License (SIL International).
xdvipdfmx sources are under GPL v2 or later.
