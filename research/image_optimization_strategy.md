# Image Optimization Strategy for eztex

## Date: 2025-01-15
## Status: Research Complete, Decision Pending

## Problem Statement

The eztex browser-based LaTeX editor needs efficient image optimization to:
1. Reduce storage/sync bandwidth for collaborative projects
2. Speed up project loading and compilation
3. Handle oversized images from camera imports gracefully
4. Maintain color accuracy for technical documents

## Current Implementation (Canvas-Based)

**Status:** Active, naive approach
- JPG: Canvas re-encode at configurable quality (70/80/90%)
- PNG: Canvas re-encode (minimal savings)
- In-place: Overwrites original files
- No metadata preservation
- No advanced algorithms

**Limitations:**
- Canvas strips ICC profiles
- Inconsistent encoder behavior across browsers
- Poor PNG optimization (no palette quantization)
- No lossless optimization path
- No automatic downscaling for oversized images

## Recommended Industry-Standard Stack

### Architecture: Separate `image-optimizer.wasm` Module

Load a dedicated WASM image optimizer on-demand via Web Worker. Keep `eztex.wasm` focused on LaTeX compilation only.

### Tool Stack

| Task | Recommended Tool | Rationale |
|------|------------------|-----------|
| JPEG lossless optimize | MozJPEG `jpegtran` | Progressive scan/Huffman optimization without pixel degradation |
| JPEG lossy re-encode | MozJPEG encoder | Better quality/size than Canvas or libjpeg |
| JPEG decode | libjpeg-turbo/MozJPEG | Fast, standard, memory-source friendly |
| PNG lossless optimize | Oxipng (preferred) or libpng+zopfli | Oxipng: best modern results; fallback: simpler C build |
| PNG lossy palette | libimagequant | Excellent results but GPL license blocker |
| Resize/downscale | stb_image_resize2 | Small C, WASM SIMD, proper sRGB/alpha handling |

### Quality Preservation Strategy

**Default mode: Visually safe**
- JPEG: lossless optimize first; lossy only if user chooses
- PNG: lossless optimize first; lossy palette only if explicitly enabled
- Metadata: preserve ICC/color-rendering by default
- Strip only safe/non-rendering metadata by default

**Color Accuracy:**
- Preserve JPEG ICC profiles and EXIF orientation
- Preserve PNG iCCP, sRGB, gAMA, cHRM chunks
- Apply EXIF orientation before processing if resizing
- Use sRGB-aware resizing (stb_image_resize2)
- Never use Canvas for final optimization

### Oversized Image Handling

**Document-aware defaults:**
- Keep images under ~12-16 MP unless user opts in
- For print: target 300 DPI based on LaTeX `\includegraphics` width
- For unknown display size: cap long edge at ~4096px
- Never upscale
- Show warnings: `6000x4000 at 3.2in wide → downscale to 960px for 300 DPI`

## Implementation Plan

### Phase 1: MozJPEG for JPEG (Highest Impact, Simplest)
1. Vendor MozJPEG C library into `pkg/mozjpeg/`
2. Create separate `image-optimizer.wasm` build target
3. Web Worker wrapper: `app/src/lib/image_optimizer_worker.ts`
4. Implement: lossless optimize, lossy re-encode, optional resize
5. Replace Canvas optimizer in `app/src/lib/image_tools.ts`

### Phase 2: PNG Lossless Optimization
1. Evaluate Oxipng Rust→WASM feasibility
2. If too complex: use libpng + zopfli as fallback
3. Add to `image-optimizer.wasm`

### Phase 3: Optional Advanced Features
1. Evaluate libimagequant license (GPL/commercial blocker)
2. Add if license is acceptable
3. Add batch optimization progress reporting
4. Add per-file error handling with user-visible messages

### Web Worker Protocol
```typescript
interface OptimizeRequest {
  bytes: Uint8Array;
  format: "jpeg" | "png";
  mode: "lossless" | "lossy" | "resize";
  quality?: number;        // 0-100 for lossy
  max_dimension?: number;  // for resize
  preserve_metadata: boolean;
}

interface OptimizeResult {
  bytes: Uint8Array;
  original_size: number;
  optimized_size: number;
  compression_ratio: number;
  format: string;
  warnings: string[];
  errors: string[];
  metadata_preserved: boolean;
}
```

## Open Decisions

1. **PNG optimizer choice:**
   - Oxipng (best results, Rust→WASM complexity)
   - libpng+zopfli (simpler build, slower)

2. **libimagequant license:**
   - GPL v3 - requires decision on commercial use implications
   - Can be optional/behind build flag

3. **Binary size impact:**
   - Estimated: +500KB to +2MB for `image-optimizer.wasm`
   - Load on-demand, not bundled with main app

## WASM Build Feasibility

**MozJPEG:**
- C codebase, compiles with Zig CC
- Supports wasm32-wasi with `-Dthreading=false`
- No SIMD required (slower but functional)
- Decoder + encoder: ~1-2MB compiled

**stb_image_resize2:**
- Single C header, trivial to vendor
- WASM SIMD support available
- ~50KB compiled

**Oxipng:**
- Rust-based, would need Rust→WASM toolchain
- More complex build integration
- Best results but highest implementation cost

## Recommendation

**Implement Phase 1 (MozJPEG) immediately** - this gives the biggest quality improvement with manageable complexity. Defer PNG optimization and advanced features based on user feedback.

## Risks

1. WASM build complexity for C libraries
2. Color profile handling differences between tools
3. Memory pressure from decoding large images in WASM
4. Web Worker communication overhead
5. Maintenance burden of vendored C libraries

## Fallback

If WASM approach stalls:
1. Revert to Canvas-based optimization
2. Add better quality settings and downscaling
3. Consider server-side optimization (if eztex ever adds backend)

## Related Documents

- `PROVENANCE.md` - Tectonic engine provenance
- `PLAN.md` - Architecture and optimization roadmap
- `research/webp_native_engine.md` - WebP engine support evaluation
