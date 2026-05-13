# WebP Native Engine Support Evaluation

## Date: 2025-01-15
## Status: Evaluated, Decision: NO-GO (for now)

## Problem Statement

XeTeX (the LaTeX engine used by eztex via Tectonic) does not natively support WebP images for `\includegraphics`. This requires either:
1. Converting WebP to PNG before compilation (current approach)
2. Adding native WebP support to xdvipdfmx (the DVI-to-PDF driver)

## Current Approach: Frontend WebP→PNG Conversion

**Architecture:**
- User's project stores images as WebP (small, efficient)
- Before compilation: Canvas API decodes WebP, re-encodes as PNG
- PNG bytes sent to XeTeX with `.webp` filename
- XeTeX reads PNG magic bytes, treats as PNG regardless of extension
- Cache in OPFS (`webp-png-cache/`) avoids repeated conversions

**Performance:**
- First compile: ~60-240s (depending on image count/size)
- Subsequent compiles: ~60s (cached)
- Caching works well after warm-up

**Pros:**
- Works now, no engine changes
- Persistent cache across sessions
- No WASM binary size increase

**Cons:**
- Extra conversion step
- First compile penalty
- Canvas strips some metadata
- Two-stage pipeline is conceptually inelegant

## Native WebP Support Options

### Option 1: Full xdvipdfmx WebP Backend (Complex)

**Implementation:**
- Create `dpx-webpimage.c` + `dpx-webpimage.h`
- Add WebP magic byte detection (`RIFF....WEBP`) to `dpx-pdfximage.c`
- Add WebP dimension reading to `xetex-pic.c`
- Implement `webp_get_bbox()` and `webp_include_image()`
- Integrate libwebp decoder into build

**What it must handle:**
- RGB/RGBA color space detection
- Alpha channel as PDF soft mask (SMask)
- Image dimensions and DPI extraction
- Memory management through `pdf_obj` stream APIs
- Error handling consistent with Tectonic abort behavior
- Security hardening for malformed/malicious WebP files
- ICC color profile extraction or graceful fallback

**Files to modify:**
```
pkg/tectonic/src/pdf_io/dpx-webpimage.c    (new)
pkg/tectonic/src/pdf_io/dpx-webpimage.h    (new)
pkg/tectonic/src/pdf_io/dpx-pdfximage.c    (add WebP detection)
pkg/tectonic/src/engine_xetex/xetex-pic.c  (add WebP sizing)
pkg/tectonic/build.zig                     (link libwebp)
build.zig                                  (add libwebp dependency)
build.zig.zon                              (add libwebp module)
```

**Complexity: HIGH**
- Real `dpx-webpimage.c` is not just magic-byte detection
- Must decode WebP to bitmap, then create correct PDF image objects
- Alpha handling, color spaces, ICC profiles, animated WebP policy
- Memory lifetime management through Tectonic's `pdf_obj` APIs

### Option 2: Hybrid I/O Conversion (Medium Complexity)

**Implementation:**
- Hook into `ttbc_input_open()` or file I/O layer
- When engine requests `.webp` file:
  1. Read WebP bytes from storage
  2. Decode using libwebp to RGB/RGBA bitmap
  3. Re-encode to PNG using existing libpng
  4. Return PNG bytes to engine as memory-backed input
- Engine sees PNG content, handles it normally

**Files to modify:**
```
src/World.zig          (add transparent WebP→PNG in file open)
src/Engine.zig         (WASM exports if needed)
pkg/libwebp/           (vendored decoder-only libwebp)
```

**Pros:**
- No xdvipdfmx changes needed
- Uses existing PNG pipeline
- Simpler than Option 1

**Cons:**
- Still does conversion (just in engine instead of frontend)
- Need engine-side caching to avoid repeated conversions
- Memory lifetime complexity

### Option 3: Native WebP via WASM libwebp (Not Evaluated)

Add libwebp decoder directly into `eztex.wasm` and use it from Zig/WASM side.

**Not evaluated** because the existing libwebp package has dependency hash issues.

## libwebp Package Analysis

**Source:** `/Users/tony/dev/builds/libwebp`

**Contents:**
- Zig package wrapping upstream libwebp C code
- Version 1.6.0
- Builds static libs: `webp`, `webpdemux`, `webpmux`, `sharpyuv`
- Upstream from GitHub, not vendored locally
- Has dependency hash mismatch - not currently build-verifiable

**WASM Build Attempt:**
```bash
zig build -Dtarget=wasm32-wasi -Doptimize=ReleaseFast \
  -Dbuild-tools=false -Dlibpng=none -Dlibjpeg=none \
  -Dlibgif=none -Dlibtiff=none -Dthreading=false \
  -Denable-simd=false
```
**Result:** Failed - `zig_build_helper` dependency hash mismatch

**Native build output:**
- `libwebp.a`: ~7.58 MB (full build)
- `sharpyuv.a`: ~254 KB
- Decoder-only would be much smaller but requires package modifications

## Tectonic Image Pipeline

**Files involved:**
```
pkg/tectonic/src/pdf_io/dpx-pdfximage.c    - Image type detection
pkg/tectonic/src/pdf_io/dpx-pngimage.c     - PNG embedding
pkg/tectonic/src/pdf_io/dpx-jpegimage.c    - JPEG embedding
pkg/tectonic/src/pdf_io/dpx-bmpimage.c     - BMP embedding
pkg/tectonic/src/engine_xetex/xetex-pic.c  - Image dimension reading
```

**Current flow:**
1. XeTeX reads `\includegraphics{file.webp}`
2. `xetex-pic.c` `get_image_size_in_inches()` checks JPEG, BMP, PNG only
3. xdvipdfmx `source_image_type()` checks JPEG, PNG, BMP, PDF, EPS
4. `load_image()` dispatches to format-specific handler
5. No WebP detection anywhere

**Engine path resolution:**
`src/World.zig:try_open_path()` strips one path prefix as "jobname fallback".
If main file is `fyp-final-report.tex`, `fyp-final-report/figures/x.jpg` resolves to `figures/x.jpg`.

## Confidence Assessment

**@oaigpt55 confidence: 6/10**

Can implement a credible prototype, but "industry-standard" across all edge cases requires significant testing.

**What can be done:**
- WebP magic-byte detection
- `dpx-webpimage.c/.h` with basic RGB/RGBA decode
- PDF image stream creation through `pdf_obj` APIs
- Alpha channel as SMask
- Build integration with libwebp

**Where confidence drops:**
- Correct PDF color handling beyond basic DeviceRGB
- ICC profile extraction and PDF ICCBased color space
- Alpha semantics for all WebP variants (premultiplied/unpremultiplied)
- Animated WebP policy (reject? first frame?)
- Malformed/malicious WebP hardening
- WASM build stability (libwebp package hash mismatch)
- Binary size impact
- PDF output parity with browser Canvas conversion

**Time estimate:**
- Prototype (basic RGB/RGBA): 1-2 days
- Robust implementation (alpha, masks, tests, WASM): 3-5 days
- "Industry-standard" (malformed corpus, fuzz testing): 1-2 weeks

## WASM Binary Size Impact

Current `eztex.wasm`: ~4.27 MB

**Adding full libwebp:**
- Estimated increase: +1-3 MB
- Decoder-only build: +500KB to +1MB (requires package modifications)

**Impact:**
- Longer download on first visit
- Longer WASM compilation time in browser
- Larger memory footprint

## Recommendation: NO-GO For Now

**Rationale:**
1. **Current caching works** - After warm-up, compile time is ~60s (same as native)
2. **Complexity is high** - Multiple C files, build integration, color/alpha edge cases
3. **First-compile penalty is acceptable** - Only affects first compile after WebP import
4. **Binary size increase** - Significant WASM growth for marginal steady-state benefit
5. **Maintenance burden** - New C decoder in vendored fork increases long-term risk

**When to reconsider:**
- First-compile WebP performance becomes critical
- libwebp package hash issues are resolved externally
- Team has capacity for 3-5 days of C/WASM integration + testing
- PNG/JPG optimization is insufficient and WebP storage savings are critical

## Alternative Path: Hybrid I/O Conversion

If native support is needed later, prefer **Option 2 (Hybrid I/O)** over full xdvipdfmx backend:

1. Transparent WebP→PNG in `ttbc_input_open()`
2. Uses existing PNG pipeline
3. No xdvipdfmx C changes
4. Can add engine-side caching
5. Simpler and less risky

## Risks of Native Implementation

1. **WASM build breaks** - libwebp's libc/threading/SIMD assumptions
2. **PDF transparency bugs** - Subtle alpha mask issues
3. **Memory pressure** - Decoding large WebP files in WASM
4. **Color profile mismatches** - Different from Canvas conversion
5. **Tectonic fork maintenance** - New failure modes to maintain
6. **Security surface** - New complex decoder in engine

## Fallback Plan

If native implementation stalls:
1. Build flag to disable WebP backend
2. Revert to frontend Canvas conversion + caching
3. Keep `.tex` references stable
4. Consider server-side optimization (if backend is ever added)

## Related Documents

- `PROVENANCE.md` - Tectonic engine provenance and patch list
- `PLAN.md` - Architecture and optimization roadmap
- `research/image_optimization_strategy.md` - Alternative image optimization approaches
- `src/World.zig` - Engine file I/O layer
- `pkg/tectonic/src/pdf_io/dpx-pdfximage.c` - Image type detection
