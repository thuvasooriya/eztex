# Engine Strategy Analysis: SwiftLaTeX, Tectonic, and eztex

## 1. SwiftLaTeX XeTeX Engine

### Does SwiftLaTeX have an XeTeX WASM engine?

Yes. SwiftLaTeX ships a fully working XeTeX-to-WASM build in `xetex.wasm/`. The output is `swiftlatexxetex.js` -- an Emscripten-compiled WASM module that runs in a Web Worker.

### C sources

The XeTeX build compiles from TeX Live's web2c-generated C sources. From the Makefile:

**C sources** (compiled with `emcc`):
- `tex/xetex0.c`, `tex/xetexini.c`, `tex/xetex-pool.c` -- the core XeTeX engine (Pascal-to-C translated)
- `md5.c` -- MD5 implementation
- `xmemory.c` -- malloc/realloc/calloc wrappers that abort on failure
- `texfile.c` -- `open_input`, `open_output`, `do_dump`, `do_undump` (file I/O layer)
- `kpseemu.c` -- kpathsea emulation (the critical shim)
- `texmfmp.c` -- `maketexstring` (UTF-16), `gettexstring`, `getmd5sum`, misc platform functions
- `main.c` -- entry points, `setjmp`/`longjmp` error recovery, format handling
- `bibtex.c` -- full BibTeX engine compiled into the same binary
- `xetexdir/XeTeX_ext.c`, `xetexdir/XeTeX_pic.c` -- XeTeX extensions and picture handling
- `xetexdir/image/bmpimage.c`, `xetexdir/image/jpegimage.c`, `xetexdir/image/pngimage.c` -- image format support
- `xetexdir/trans.c` -- coordinate transforms

**C++ sources** (compiled with `em++`):
- `xetexdir/XeTeXOTMath.cpp` -- OpenType math support
- `xetexdir/XeTeXLayoutInterface.cpp` -- layout engine interface
- `xetexdir/XeTeXFontMgr.cpp`, `xetexdir/XeTeXFontInst.cpp` -- font management
- `xetexdir/XeTeXFontMgr_FC.cpp` -- fontconfig-based font discovery
- `xetexdir/hz.cpp` -- microtypographic hz expansion
- `xetexdir/pdfimage.cpp` -- PDF image inclusion (uses xpdf)
- `teckit/teckit-Engine.cpp` -- TECkit encoding conversion

**Pre-compiled static libraries** (linked at final stage):
- `xpdf/xpdf.a` -- PDF parsing (for `\includegraphics` with PDF inputs)
- `graphite2/libgraphite2.a` -- Graphite smart font rendering
- `harfbuzz/libharfbuzz.a` -- HarfBuzz text shaping

### File resolution: kpseemu, not ttbc

SwiftLaTeX's XeTeX uses kpseemu.c -- the exact same approach as their pdfTeX engine. It does NOT use tectonic's `ttbc_*` bridge. The file resolution is two-phase:

1. **Local check**: `kpse_find_file()` first does `access(local_name, F_OK)` on the Emscripten virtual filesystem. If the file doesn't have an extension, it appends one via `fix_extension()` (a giant switch mapping kpse format types to file extensions) and tries again.

2. **Network fetch**: If local fails, calls `kpse_find_file_js()` -- an Emscripten JS library function (declared `extern` in C, implemented in `library.js`) that does a synchronous XHR to `texlive_endpoint + 'xetex/' + format + '/' + name`. The response is written to Emscripten MemFS at `/tex/<fileid>` and the path is returned to C.

XeTeX additionally has `fontconfig_search_font_js()` for font discovery. This is also a synchronous XHR to a `fontconfig/` endpoint on the CDN, with the font name and variant as path components.

Both functions use JS-side 200/404 caches (`texlive200_cache`, `texlive404_cache`, `font200_cache`, `font404_cache`) to avoid repeated XHR for the same file.

### Emscripten build flags

```
CFLAGS  = -O3 -Wno-parentheses-equality -Wno-pointer-sign -DWEBASSEMBLY_BUILD
          -s USE_FREETYPE=1 -s USE_ICU=1 -s USE_LIBPNG=1 -fno-rtti -fno-exceptions

LDFLAGS = -O3 --js-library library.js
          -s USE_FREETYPE=1 -s USE_ICU=1 -s USE_LIBPNG=1
          --pre-js pre.js
          -s ENVIRONMENT="web"
          -s EXPORTED_FUNCTIONS='["_compileBibtex","_compileLaTeX","_compileFormat","_main","_setMainEntry"]'
          -s NO_EXIT_RUNTIME=1 -s WASM=1
          -s EXPORTED_RUNTIME_METHODS=["cwrap"]
          -s ALLOW_MEMORY_GROWTH=1
```

Key observations:
- Uses Emscripten-ported FreeType, ICU, and libpng (the `-s USE_*=1` flags pull them from Emscripten ports)
- Web-only target (`ENVIRONMENT="web"`)
- Memory can grow dynamically (`ALLOW_MEMORY_GROWTH=1`)
- No WASI -- pure Emscripten MemFS for all file I/O
- XeTeX produces `.xdv` output (`nopdfoutput = 1` is set in `compileLaTeX()`), needs `dvipdfm.wasm` separately

### How it differs from tectonic's XeTeX

The fundamental difference: **SwiftLaTeX kept kpathsea (emulated), tectonic ripped it out.**

SwiftLaTeX's XeTeX is minimally patched TeX Live source code. The engine C files (`xetex0.c`, `xetexini.c`, etc.) are essentially unmodified web2c output. The only patching is:
- `kpseemu.c` replaces kpathsea with local-check + network-fetch
- `main.c` replaces `main()` with WASM entry points + `setjmp`/`longjmp`
- `texmfmp.c` provides platform-specific utility functions
- `texfile.c` provides simplified `open_input`/`open_output`
- `xmemory.c` provides malloc wrappers

Tectonic, by contrast, performed a deep fork: every `kpse_find_file()` call was replaced with `ttbc_input_open()`, every `fopen`/`fread`/`fwrite` was replaced with `ttbc_output_write`/`ttbc_input_read`, and the layout engine was restructured to go through its own C++ bridge layer. Tectonic also removed direct fontconfig/ICU linkage in favor of its own abstractions.

---

## 2. SwiftLaTeX pdfTeX Patching Methodology

### kpseemu.c -- what it actually does

The pdfTeX kpseemu.c is nearly identical to the XeTeX one. It emulates the following kpathsea functions:

**Fully implemented (functional):**
- `kpse_find_file(name, format, must_exist)` -- the core function. Two-phase: local access check on MemFS, then JS network fetch
- `kpse_find_pk(fontname, dpi)` -- PK bitmap font lookup (pdfTeX-specific, not in XeTeX's kpseemu). Same pattern: local check then `kpse_find_pk_js()` network fetch
- `kpse_absolute_p(filename, relative_ok)` -- checks if path starts with `/`
- `kpse_in_name_ok(fname)` / `kpse_out_name_ok(fname)` -- always return true (no sandboxing)
- `xfopen`, `xfclose`, `xfseek`, `xftell`, `xftello`, `xfseeko` -- thin wrappers around POSIX I/O with error-abort
- `xbasename(name)` -- strip directory prefix
- `dir_p(fn)` -- check if path is a directory via `stat()`
- `setupboundvariable(var, name, dflt)` -- hardcoded engine parameters (main_memory=5000000, pool_size=6250000, etc.)
- `concat3(s1, s2, s3)` -- string concatenation utility
- `zround(r)` -- rounding with overflow clamping

**Stub-only (no-ops):**
- `kpse_init_prog()` -- empty
- `kpse_set_program_enabled()` -- empty
- `kpse_set_program_name()` -- empty
- `kpse_reset_program_name()` -- empty

### How synchronous XHR file fetching works

The JS side (in `pre.js`) implements `kpse_find_file_impl()`:

```
C: kpse_find_file(name, format, must_exist)
  -> local access() check on Emscripten MemFS
  -> if not found: kpse_find_file_js(name, format, must_exist)  [extern -> library.js]
    -> kpse_find_file_impl(nameptr, format, _mustexist)         [JS in pre.js]
      -> check texlive404_cache (skip known misses)
      -> check texlive200_cache (return cached path)
      -> synchronous XHR GET to texlive_endpoint + 'pdftex/' + format + '/' + name
      -> if 200: write response to MemFS at /tex/<fileid>, cache path, return path pointer
      -> if 301: cache as 404, return 0
```

The XHR is synchronous (`xhr.open("GET", url, false)`) with a 150-second timeout. The response is written into Emscripten's virtual filesystem at `/tex/<fileid>` where `fileid` comes from a response header. The path string is allocated into WASM memory via `_malloc` + `HEAPU8.set`.

For pdfTeX specifically, the URL path component is `pdftex/` (vs `xetex/` for XeTeX). This means the CDN server organizes files by engine type.

PK font lookup (`kpse_find_pk_impl`) follows the same pattern but uses `pdftex/pk/<dpi>/<fontname>` as the URL path.

### Format file handling

Format files (`.fmt`) are generated via `compileFormat()` in `main.c`:

```c
int compileFormat() {
    iniversion = 1;
    strncpy(bootstrapcmd, "*pdflatex.ini", MAXMAINFILENAME);
    return _compile();
}
```

This runs pdfTeX in INI mode, which processes `pdflatex.ini` and writes `pdflatex.fmt` to the MemFS working directory. The JS side reads it out via `FS.readFile()` and posts it back as a transferable ArrayBuffer.

For normal compilation, the format file must already be in MemFS (pre-loaded by the JS host via `FS.writeFile()`). The engine's `_compile()` function sets `TEXformatdefault` to the format name and `formatdefaultlength` to its string length. The C engine then loads it via normal TeX `do_undump` machinery.

### The heap snapshot/restore trick

This is the most significant optimization in SwiftLaTeX. The exact implementation:

**Capture (runs once, after engine initialization):**

```javascript
// Module['postRun'] fires after _main() completes (which loads format + runs init)
Module['postRun'] = function() {
    self.initmem = dumpHeapMemory();
};

function dumpHeapMemory() {
    var src = wasmMemory.buffer;           // the WASM linear memory ArrayBuffer
    var dst = new Uint8Array(src.byteLength);
    dst.set(new Uint8Array(src));           // copy entire WASM heap
    return dst;
}
```

`wasmMemory.buffer` is the raw WASM linear memory -- this is ALL engine state: the TeX memory arrays, string pools, font tables, hash tables, every global variable, the C stack, everything. After `_main()` returns (which loads the format file and initializes the engine), the entire memory is copied to a JS-side `Uint8Array`.

**Restore (runs before each compilation):**

```javascript
function prepareExecutionContext() {
    self.memlog = '';
    restoreHeapMemory();   // blast the snapshot back into WASM memory
    closeFSStreams();       // close all open file descriptors (except stdin/stdout/stderr)
    FS.chdir(WORKROOT);    // reset working directory
}

function restoreHeapMemory() {
    if (self.initmem) {
        var dst = new Uint8Array(wasmMemory.buffer);
        dst.set(self.initmem);  // overwrite entire WASM heap with snapshot
    }
}
```

The restore copies the entire saved `Uint8Array` back into WASM linear memory. This is a single `TypedArray.set()` call -- a memory copy of the entire WASM heap. After this, the engine state is exactly as it was after format loading: all TeX globals, memory pools, font data, and macro definitions are restored.

The `closeFSStreams()` step is necessary because the Emscripten MemFS file descriptor table is maintained in JS-side state (not in WASM linear memory). Restoring WASM memory would leave stale fd entries in the JS FS layer, so they must be explicitly closed.

**What this achieves:**
- Skips format file loading on every compilation after the first (~100-300ms saved)
- Skips all engine initialization code
- The WASM instance stays alive between compilations -- no instantiation overhead
- For pdfTeX: `_main()` returns after loading `pdflatex.fmt`, then `compileLaTeX()` runs from the post-format state
- For XeTeX: same, but with `xelatex.fmt`

**What it does NOT capture:**
- Emscripten MemFS state (files written to virtual FS are JS-side)
- JS-side caches (`texlive200_cache`, `texlive404_cache`)
- Web Worker state outside the WASM instance

**Size implication:** The snapshot is the full WASM linear memory. With `ALLOW_MEMORY_GROWTH=1` and `main_memory=5000000`, this is likely 30-80MB after format loading. This is held in JS heap permanently. Not cheap, but acceptable for a single Web Worker.

### Other non-obvious patches

1. **`uexit()` uses `longjmp` instead of `exit()`**: The C engine's `uexit()` function calls `longjmp(jmpenv, 1)` to unwind back to the `setjmp` in `_compile()`. This prevents the WASM instance from terminating on TeX errors.

2. **`nopdfoutput = 1` for XeTeX**: SwiftLaTeX's XeTeX is forced to produce XDV (not PDF), requiring a separate `dvipdfm.wasm` for final PDF conversion.

3. **No shell escape**: There is no shell escape implementation. `kpse_in_name_ok` and `kpse_out_name_ok` always return true, but there's no actual shell-out capability.

4. **BibTeX compiled in**: `bibtex.c` is linked into the same WASM binary. `compileBibtex()` derives the `.aux` filename from the main entry file and calls `bibtex_main()`.

5. **`_allocate()` helper**: JS-side helper that does `_malloc` + `HEAPU8.set` to pass string data from JS into WASM memory. Used by the kpse/fontconfig JS implementations to return file paths to C code.

---

## 3. Mapping kpseemu to ttbc_*

### The conceptual mapping

Both systems solve the same problem: "the engine asks for a file by name and format, the host finds and provides it." The mechanism differs entirely.

| kpseemu (SwiftLaTeX) | ttbc_* (tectonic/eztex) |
|---|---|
| `kpse_find_file(name, format, must_exist)` returns a filesystem path string | `ttbc_input_open(name, format, is_gz)` returns an opaque handle |
| Engine then calls `fopen(path)` to get a `FILE*` | Handle is used directly with `ttbc_input_read(handle, buf, len)` |
| `fread(buf, 1, n, fp)` reads from file | `ttbc_input_read(handle, buf, len)` reads from file |
| `fwrite(buf, 1, n, fp)` writes to file | `ttbc_output_write(handle, buf, len)` writes to file |
| `fseek(fp, offset, whence)` seeks | `ttbc_input_seek(handle, offset, whence, err)` seeks |
| `fclose(fp)` closes | `ttbc_input_close(handle)` / `ttbc_output_close(handle)` closes |
| `kpse_find_pk(fontname, dpi)` finds PK fonts | No direct equivalent -- PK fonts go through `ttbc_input_open` with `TTBC_FILE_FORMAT_PK` |
| Emscripten MemFS as virtual filesystem | WASI preopened directories + World.zig handle table |

### What a kpseemu-to-ttbc shim would need to do

If we wanted to compile unmodified TeX Live pdfTeX sources (which call `kpse_find_file`, `fopen`, `fread`, etc.) against eztex's ttbc bridge, we would need:

**Straightforward mappings:**

1. `kpse_find_file(name, format, must_exist)` -> call `ttbc_input_open(name, format, 0)`. But there's a semantic mismatch: kpse returns a *path string*, ttbc returns a *handle*. The shim would need to either:
   - (a) Open the file via ttbc, write its contents to a temp file in WASI filesystem, return the temp path. This is ugly but preserves the `kpse_find_file` -> `fopen` two-step that pdfTeX expects.
   - (b) Track the handle internally and intercept the subsequent `fopen()` call to return a fake `FILE*` backed by ttbc reads. This is cleaner but requires hooking libc.

2. `kpse_find_pk(fontname, dpi)` -> `ttbc_input_open(fontname_with_dpi_suffix, TTBC_FILE_FORMAT_PK, 0)`. Same path-vs-handle mismatch.

3. `kpse_in_name_ok` / `kpse_out_name_ok` -> always true (same as SwiftLaTeX)

4. `kpse_init_prog`, `kpse_set_program_enabled`, `kpse_set_program_name`, `kpse_reset_program_name` -> no-ops (same as SwiftLaTeX)

5. `kpse_absolute_p` -> trivial path check (same as SwiftLaTeX)

6. `setupboundvariable` -> hardcoded parameter table (same as SwiftLaTeX)

7. `xfopen`, `xfclose`, `xfseek`, `xftell` -> can remain as POSIX wrappers if we use approach (a) above, or need reimplementation if using approach (b)

**Hard parts:**

1. **The path-vs-handle semantic gap**: This is the central difficulty. pdfTeX's code does `path = kpse_find_file(name, fmt, 1); fp = fopen(path, "r"); fread(buf, 1, n, fp);`. The ttbc model does `handle = ttbc_input_open(name, fmt, 0); ttbc_input_read(handle, buf, n);`. Bridging these requires either temp files or libc interposition.

2. **pdfTeX's PDF backend uses `fopen`/`fwrite` directly**: The PDF writing code (`pdftexdir/`) writes to output files via standard C I/O, not through kpathsea. These calls need to route through `ttbc_output_open` / `ttbc_output_write`. This means the shim isn't just kpathsea -- it's also parts of stdio.

3. **xpdf library**: pdfTeX's `pdftoepdf.cc` uses xpdf to read PDF files for `\includegraphics` with PDF input. xpdf uses its own file I/O. Getting this to work through ttbc requires either (a) making xpdf read from ttbc handles, or (b) ensuring the PDF files exist on a real filesystem path (WASI or temp files).

4. **Format file format type numbers**: kpseemu uses TeX Live's `kpse_file_format_type` enum (defined in `kpseemu.h` with ~60 format types). ttbc uses `ttbc_file_format` enum (defined in `tectonic_bridge_core_generated.h` with ~20 format types). These do NOT have the same numeric values. The shim must translate between them. For example: `kpse_tfm_format` (TeX Live) maps to `TTBC_FILE_FORMAT_TFM = 3`, `kpse_tex_format` maps to `TTBC_FILE_FORMAT_TEX = 26`, etc.

5. **`open_input` / `open_output` in texfile.c**: SwiftLaTeX's `texfile.c` implements these as thin wrappers around `kpse_find_file` + `fopen`. In tectonic, these are replaced entirely by `ttbc_input_open` calls in the engine C code. For the shim approach, we'd keep SwiftLaTeX's `texfile.c` and have it call our kpseemu which routes to ttbc.

### pdfTeX-specific kpathsea calls with no direct ttbc equivalent

- `kpse_find_pk(fontname, dpi)`: ttbc has no dpi-parameterized lookup. You'd need to construct the filename yourself (e.g., `cmr10.600pk`) and pass it to `ttbc_input_open` with `TTBC_FILE_FORMAT_PK`.
- `kpse_set_program_enabled(fmt, value, level)`: ttbc has no concept of enabling/disabling format search. No-op is fine.
- `setupboundvariable()`: ttbc has no engine parameter configuration. Hardcoded values (same as SwiftLaTeX) work.

### Recommended shim approach

**Option (a): temp-file bridge.** Have `kpse_find_file()` call `ttbc_input_open()`, read the entire file into memory via `ttbc_input_read()`, write it to a WASI temp file, close the ttbc handle, return the temp path. pdfTeX's existing `fopen`/`fread` code works unchanged against the temp file.

Pros: zero changes to pdfTeX engine source, maximally preserves SwiftLaTeX compatibility
Cons: double I/O (ttbc read + temp file write + fopen + fread), temp file cleanup, memory copies

For a first proof-of-concept, this is the right approach. Optimize later if needed.

---

## 4. Tectonic's XeTeX vs SwiftLaTeX's XeTeX

### What tectonic did to XeTeX

Tectonic performed a deep surgical modification of XeTeX's C sources:

1. **Replaced kpathsea entirely**: Every `kpse_find_file` call was removed. File opens go through `ttbc_input_open(name, format, is_gz)` which returns an opaque handle. All subsequent I/O uses `ttbc_input_read`, `ttbc_input_seek`, `ttbc_input_getc`, `ttbc_output_write`, etc.

2. **Removed direct stdio for TeX I/O**: No `fopen`/`fread`/`fwrite` for TeX files. Everything goes through the handle-based ttbc bridge. Output files use `ttbc_output_open` / `ttbc_output_write`.

3. **Bridge core layer**: Added `tectonic_bridge_core.h` providing `xmalloc`/`xcalloc`/`xrealloc`/`xstrdup`, `setjmp`/`longjmp` engine enter/exit pattern (`ttbc_global_engine_enter()`), variadic printf wrappers (`ttstub_issue_warning`, `_tt_abort`), and diagnostic formatting (`ttbc_diag_*`).

4. **Layout engine restructured**: The XeTeX layout interface was restructured -- in eztex this became Layout.zig implementing 80+ functions that the C engine calls. Font management, shaping, glyph queries all go through this Zig layer.

5. **Format dump/restore via ttbc**: Format files (`.fmt`) are loaded through `ttbc_input_open` with `TTBC_FILE_FORMAT_FORMAT`, not via filesystem paths. The `do_dump`/`do_undump` code writes/reads through ttbc handles.

6. **Removed fontconfig hard dependency**: Tectonic's XeTeX does not directly link fontconfig for font discovery at the engine level. Font discovery is handled by the host (in eztex: Layout.zig on native, stubs on WASM).

7. **Removed system ICU assumption**: ICU data is compiled in or loaded via the bridge, not assumed to be installed system-wide.

### What SwiftLaTeX did differently

SwiftLaTeX took the minimal-patch approach:

1. **Kept kpathsea (emulated)**: The engine C sources are essentially unmodified web2c output. `kpseemu.c` provides just enough kpathsea API to satisfy the linker, with file resolution delegated to JS.

2. **Kept stdio for I/O**: The engine still uses `fopen`/`fread`/`fwrite` for file I/O. Emscripten MemFS intercepts these transparently.

3. **Kept fontconfig (stub + network)**: The `fontconfig/` directory contains stub headers so the C++ code compiles, but actual font discovery is delegated to `fontconfig_search_font_js()` which does synchronous XHR to a font server.

4. **Kept ICU via Emscripten ports**: `-s USE_ICU=1` pulls Emscripten's pre-compiled ICU with bundled data.

5. **Minimal main.c changes**: Just the `setjmp`/`longjmp` pattern and WASM-specific entry points.

### Are they based on the same TeX Live version?

Both derive from TeX Live's XeTeX, but from different snapshots:

- **Tectonic**: Based on TeX Live 2021 (approximately), heavily modified. The C files have been through tectonic's patching pipeline, renamed (`xetex-xetex0.c` instead of `xetex0.c`), and restructured.
- **SwiftLaTeX**: Based on a TeX Live snapshot (exact version unclear, likely 2019-2020 era). The files retain their original names (`tex/xetex0.c`).

The actual TeX engine behavior should be nearly identical for both -- XeTeX's core typesetting algorithms haven't changed significantly between these versions. The differences are entirely in the I/O and platform abstraction layers.

### Which approach is cleaner?

**Tectonic's is architecturally cleaner but comes with higher maintenance cost.**

Tectonic's approach gives complete control over I/O -- no filesystem assumptions, no network assumptions, everything goes through explicit callbacks. This makes it trivially portable to any host (native, WASM, embedded). The cost is that every engine must be deeply patched, creating a fork that diverges from upstream TeX Live.

SwiftLaTeX's approach is pragmatically cleaner for the limited goal of "run TeX in a browser." Minimal patches mean it's easy to update to new TeX Live releases. The cost is that it's tightly coupled to Emscripten's MemFS and synchronous XHR, making it essentially browser-only.

**For eztex specifically**, tectonic's approach was the right choice for XeTeX because eztex needs to run on both native and WASM, and the deep integration with Zig's type system and error handling is a significant advantage. The question is whether it's worth repeating that investment for pdfTeX.

---

## 5. Four Strategic Options

### Option A: Stay tectonic XeTeX only

**What it means:** No pdfTeX. eztex compiles documents with XeTeX only. Users who need pdfTeX-specific features are out of luck.

**Pros:**
- Zero work
- Already working and well-tested
- Single engine simplifies everything: one binary, one compilation pipeline, one set of bugs to track
- XeTeX handles 95%+ of LaTeX documents correctly

**Cons:**
- No pdfTeX -- some packages/documents explicitly require it (certain beamer themes, microtype with pdfTeX-specific features, documents with `\pdfcompresslevel` and similar pdfTeX primitives)
- Locked to tectonic's XeTeX version and their patching decisions
- Some users will perceive this as a limitation vs Overleaf (which offers pdflatex, xelatex, and lualatex)

**Honest assessment:** This is a perfectly defensible choice. The set of documents that require pdfTeX and cannot be compiled with XeTeX is small and shrinking. Most "pdflatex-only" documents can be converted to xelatex with trivial changes (remove `\usepackage[utf8]{inputenc}`, change font packages). The question is whether the competitive/perception cost of "no pdfTeX" is worth the engineering cost of adding it.

**Effort: None. Risk: None. Payoff: Status quo.**

### Option B: Vendor TeX Live pdfTeX, shim kpseemu to ttbc, build with Zig

**What it means:** Take TeX Live's pdfTeX C sources (using SwiftLaTeX as a reference for which files and defines are needed), write a `kpseemu.c` that translates kpathsea calls into `ttbc_*` calls, compile everything with Zig's C compiler, link into the same WASM binary as XeTeX.

**Specific steps:**
1. Copy TeX Live pdfTeX web2c sources (`pdftex0.c`, `pdftexini.c`, `pdftex-pool.c`) into `pkg/tectonic/src/engine_pdftex/`
2. Copy pdfTeX-specific sources (`pdftexdir/*.c` for PDF backend, `pdftexdir/pdftoepdf.cc` for PDF inclusion)
3. Write `kpseemu.c` that implements `kpse_find_file()` by calling `ttbc_input_open()`, reading the file content, writing to a temp path, and returning the path
4. Map `kpse_file_format_type` enum values to `ttbc_file_format` enum values
5. Write `main.c` entry point following the pattern from SwiftLaTeX but exporting `tt_engine_pdftex_main()` for the tectonic calling convention
6. Add build rules to `pkg/tectonic/build.zig`
7. Extend `Compiler.zig` with `Format.pdflatex` and a direct `.tex -> .pdf` pipeline (no xdvipdfmx step)
8. Generate or vendor a `pdflatex.fmt`

**Pros:**
- Both engines in a single Zig-built binary
- Shares Engine.zig, World.zig, BundleStore.zig, all ttbc_* infrastructure
- pdfTeX pipeline is simpler than XeTeX (one step, not two -- produces PDF directly)
- SwiftLaTeX proves the C sources compile to WASM
- No Emscripten dependency

**Cons:**
- The kpseemu-to-ttbc shim is non-trivial (path-vs-handle gap, format type mapping)
- xpdf/C++ dependency is a build system challenge (Zig building C++ with xpdf headers)
- pdfTeX's PDF backend uses direct stdio -- needs careful routing through ttbc or WASI
- Must generate/vendor `pdflatex.fmt` (chicken-and-egg: need a working pdfTeX to make the format)
- Creates a maintenance burden: now tracking two engine source trees

**Hard parts, honestly:**
1. **The format type enum mapping**: ~60 kpse format types vs ~20 ttbc format types. Many kpse types have no ttbc equivalent (e.g., `kpse_mf_format`, `kpse_mp_format`, `kpse_ocp_format`). These would need to map to a generic type or be handled specially.
2. **xpdf compilation**: `pdftoepdf.cc` is C++ that includes xpdf headers. Zig can compile C++ but xpdf's build system is non-trivial. Could stub it out initially (PDF inclusion returns error).
3. **pdflatex.fmt generation**: Either pre-build it with a native TeX Live installation, or vendor a pre-built one from SwiftLaTeX/TeX Live. In-browser generation (running pdfTeX in INI mode) requires the engine to already work.
4. **Testing surface**: pdfTeX has different font handling (Type1, PK fonts via Metafont), different PDF backend, different primitive set. Testing requires exercising all of these code paths.

**Effort: Medium-Large (3-6 weeks for proof of concept, 2-3 months for production quality)**
**Risk: Medium (build complexity, format compatibility, untested code paths)**
**Payoff: Full pdfTeX support, single binary, clean architecture**

### Option C: Plug SwiftLaTeX's prebuilt WASM into eztex's JS layer

**What it means:** Ship SwiftLaTeX's pre-compiled `pdftex.wasm`/`swiftlatexpdftex.js` alongside eztex's Zig-built XeTeX WASM. On the JS side, have an adapter that wraps SwiftLaTeX's Emscripten MemFS interface to work with eztex's bundle store and cache. Use tectonic XeTeX for xelatex, SwiftLaTeX pdfTeX for pdflatex.

**How it would work:**
1. Bundle SwiftLaTeX's pre-compiled `.wasm` and `.js` files as a separate download
2. When user selects pdflatex, load the SwiftLaTeX Worker instead of the eztex Worker
3. Adapter layer translates eztex's file delivery (BundleStore range fetches) into SwiftLaTeX's expected interface (MemFS writes + texlive endpoint)
4. Could either: (a) proxy SwiftLaTeX's XHR requests through eztex's bundle logic, or (b) pre-populate MemFS with files from eztex's cache

**Pros:**
- Fastest path to "pdfTeX works" -- SwiftLaTeX's pdfTeX is already battle-tested
- No C compilation work
- No kpseemu-to-ttbc shim
- No format file generation issue (SwiftLaTeX's format generation flow works)

**Cons:**
- **Two completely different WASM binaries**: Different build systems (Emscripten vs Zig), different architectures (MemFS vs WASI+ttbc), different file resolution (CDN XHR vs BundleStore range)
- **Double download size**: Users need both binaries. Caching is separate. Bundle format incompatibility means files can't be shared.
- **Emscripten dependency**: SwiftLaTeX's WASM requires Emscripten's JS runtime (Module, FS, cwrap, HEAPU8, etc.). This is a large JS payload and fundamentally different from eztex's lean WASI shim.
- **CDN dependency**: SwiftLaTeX's kpseemu routes to `texlive2.swiftlatex.com`. eztex would need to either keep using that CDN (reliability risk) or rewrite the JS layer to intercept XHR and serve from eztex's tar bundles.
- **No native target**: SwiftLaTeX's pdfTeX is Emscripten-only. eztex's native target (CLI, watch mode) would have no pdfTeX.
- **Maintenance nightmare**: Two separate codebases, two separate sets of bugs, two separate update cycles. When SwiftLaTeX updates, you need to re-validate the integration.
- **Format file incompatibility**: SwiftLaTeX's `pdflatex.fmt` was generated against their specific TeX Live snapshot. It may not be compatible with a different set of packages/bundles than what eztex ships.

**What breaks:**
- Any feature that depends on eztex's unified Engine.zig/World.zig layer (diagnostics, SyncTeX, file tracking, format caching)
- Watch mode (SwiftLaTeX's model is "post files to Worker, call compileLaTeX")
- Native CLI target (no pdfTeX at all)
- Consistent UX between engines (different error formats, different log output, different compilation behavior)

**Honest assessment:** This is a trap. It looks easy because "just ship the prebuilt WASM" but the integration cost is high and the result is a frankenstein architecture. Every feature added to eztex needs to work with two completely different engine interfaces. The technical debt accumulates fast.

**Effort: Short for a demo (1-2 weeks), Large for production (ongoing maintenance)**
**Risk: High (architectural split, CDN dependency, format incompatibility)**
**Payoff: Quick pdfTeX demo, but permanent technical debt**

### Option D: Vendor both pdfTeX and XeTeX from TeX Live, replace kpathsea with Zig-native I/O, single build

**What it means:** Take both XeTeX and pdfTeX from TeX Live sources (not tectonic's patched versions), replace kpathsea in BOTH engines with a unified Zig-native I/O layer, compile everything with Zig, produce a single WASM binary. Essentially, build a "tectonic but in Zig" from scratch.

**What this involves:**
1. Vendor TeX Live XeTeX and pdfTeX web2c C sources
2. Write a unified I/O bridge in Zig that replaces kpathsea for both engines
3. Port or rewrite the layout engine interface (currently Layout.zig implements tectonic's C++ bridge -- would need to interface with TeX Live's C++ directly)
4. Build HarfBuzz, ICU, FreeType, graphite2, libpng, zlib with Zig
5. Build xpdf with Zig for pdfTeX's PDF inclusion
6. Implement format generation for both engines
7. Implement heap snapshot/restore at the Zig/WASM level (not JS level like SwiftLaTeX)
8. Build xdvipdfmx for XeTeX's DVI-to-PDF conversion

**Pros:**
- Complete control over everything
- No dependency on tectonic's patching decisions
- Both engines with identical I/O abstraction
- Can implement optimizations like heap snapshot in Zig (not JS)
- Can update to new TeX Live releases without waiting for tectonic
- Clean, unified architecture

**Cons:**
- **Massive effort**: This is a ground-up reimplementation of what tectonic spent years building. The XeTeX patching alone (replacing kpathsea, restructuring the layout bridge) would be months of work.
- **Throws away working code**: eztex's current XeTeX integration via tectonic is working, debugged, and battle-tested. Replacing it means re-discovering every edge case and bug.
- **Layout.zig rewrite**: The current Layout.zig implements tectonic's specific C++ bridge API (80+ functions). TeX Live's XeTeX has a different C++ layout interface. This would need to be reimplemented.
- **Risk of subtle incompatibilities**: TeX engines are notoriously sensitive to exact behavior of their I/O and memory management. Any difference from the expected behavior can cause format loading failures, incorrect output, or crashes.
- **No incremental path**: You can't ship this gradually. It's all-or-nothing.

**Honest assessment:** This is the "rewrite from scratch" option. It's technically superior but practically dangerous. The engineering time is measured in months (6+), and the risk of getting stuck on subtle engine compatibility issues is high. The only justification would be if tectonic's patched sources become unmaintainable or if you need capabilities that tectonic's architecture fundamentally cannot support.

**Effort: Large (6-12 months)**
**Risk: Very high (engine compatibility, scope creep, opportunity cost)**
**Payoff: Maximum architectural control, but at enormous cost**

---

## 6. Recommendation

### Bottom line

**Option A (stay XeTeX only) now. Option B (vendor pdfTeX, shim to ttbc) when there's real demand.**

### Reasoning

1. **eztex's current XeTeX integration is good.** It works on native and WASM, has SyncTeX, diagnostics, format caching, bundle store, watch mode. This is 6+ months of engineering that's already paid for. Nothing about adding pdfTeX makes this better.

2. **The demand for pdfTeX is speculative.** Most LaTeX documents work with XeTeX. The ones that don't are usually fixable with trivial changes. Until users are actually bouncing off eztex because "my document requires pdflatex and I can't switch," the engineering cost isn't justified.

3. **Option B is the right eventual path.** When demand materializes, taking TeX Live pdfTeX sources and shimming kpseemu to ttbc is the architecturally sound approach. It reuses all of eztex's infrastructure, produces a single binary, and works on both native and WASM. The kpseemu-to-ttbc shim is non-trivial but bounded -- SwiftLaTeX's kpseemu.c is ~300 lines, the ttbc translation layer would be ~400-500 lines.

4. **Option C (plug SwiftLaTeX WASM) is a trap.** It creates permanent architectural debt for a quick demo. Every eztex feature needs two code paths. Format incompatibility lurks. CDN dependency is a reliability risk. The native CLI target gets nothing.

5. **Option D (rewrite everything) is over-engineering.** eztex's tectonic-based XeTeX works. Throwing it away to vendor raw TeX Live sources would be justified only if tectonic's code became unmaintainable, which it hasn't.

### If/when you do Option B

The order of operations:

1. Stub out xpdf (`pdftoepdf.cc` returns error). This eliminates the hardest C++ dependency.
2. Write the kpseemu-to-ttbc shim using the temp-file approach (ttbc read -> temp file -> return path).
3. Write the format type mapping (kpse enum -> ttbc enum lookup table).
4. Get pdfTeX compiling with `zig cc` using SwiftLaTeX's Makefile as the file list reference.
5. Vendor a pre-built `pdflatex.fmt` from TeX Live.
6. Wire up `Compiler.zig` with the direct `.tex -> .pdf` pipeline.
7. Test with trivial documents first, then progressively complex ones.
8. Add xpdf compilation last, after basic compilation works.

### Escalation triggers for revisiting this decision

- Multiple users reporting "my document requires pdflatex" with non-trivial conversion barriers
- A project or institution requiring pdfTeX support as a hard requirement
- tectonic upstream making breaking changes that invalidate eztex's XeTeX integration
- Performance requirements that the heap snapshot trick would solve (at that point, also consider implementing it for XeTeX)
