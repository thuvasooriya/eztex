# Bidirectional SyncTeX Integration Plan

## Bottom Line

Replace the native PDF iframe with PDF.js (`pdfjs-dist`) to enable full bidirectional SyncTeX -- forward sync (editor cursor to PDF highlight) and reverse sync (Ctrl+click on PDF to jump to source line). PDF.js is the only viable path for reverse sync because we need to intercept click coordinates on the rendered PDF and convert them to PDF-space coordinates. The SyncTeX parser is a ~270-line MIT-licensed JS port from LaTeX-Workshop that handles both directions. The synctex.gz file comes out of the existing WASM tectonic engine with a single arg change.

---

## Architecture Decision: PDF.js (pdfjs-dist)

### Why PDF.js is now required

The previous plan correctly identified that reverse sync is impossible with a native iframe. Since the goal is now full bidirectional sync, PDF.js is mandatory. The specific requirements that force this:

1. **Reverse sync**: Click on PDF canvas -> get pixel coordinates -> `viewport.convertToPdfPoint(dx, dy)` -> PDF user-space coordinates -> SyncTeX lookup -> source file + line. This is impossible without owning the canvas.

2. **Forward sync highlight**: With PDF.js we can render a highlight overlay at the exact SyncTeX bounding box, not just scroll to a page. The iframe `#page=N` approach gives no sub-page precision.

3. **Glitch-free PDF swap**: PDF.js `PDFViewer.setDocument()` replaces the document without destroying the viewer, preserving scroll position. The iframe approach flashes white on every blob URL change.

### Package choice: `pdfjs-dist`

Use `pdfjs-dist` (the official distribution package), not a wrapper library.

- **No SolidJS-specific wrapper exists** that is maintained or non-trivial. The React wrappers (react-pdf) are React-specific and would need porting. Direct integration is cleaner.
- **Bundle size**: `pdfjs-dist` core (`pdf.mjs`) is ~370KB minified, ~105KB gzipped. The worker (`pdf.worker.mjs`) is ~570KB minified but loads asynchronously in a Web Worker and does not block the main thread. Total gzipped impact: ~170KB. This is acceptable for a LaTeX editor where the PDF viewer is a core feature, not optional.
- **Worker loading in Vite**: Use `new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)` to let Vite handle the worker as a separate chunk. This is the standard pattern used by Overleaf and others.

### What we lose from the native iframe

- Zero-config rendering (native browser PDF renderer). PDF.js handles all rendering correctly for standard LaTeX output.
- Native browser scrollbar and zoom. We will implement our own minimal scroll container and scale controls (Ctrl+scroll to zoom).

### What we gain

- Pixel-precise bidirectional sync
- Highlight overlay for forward sync (animated flash)
- No white flash between compiles
- Future: text selection, search within PDF, annotation support

---

## SyncTeX Parser

### Choice: Port synctexjs.ts from LaTeX-Workshop

Source: `github.com/James-Yu/LaTeX-Workshop/blob/master/src/locate/synctex/synctexjs.ts`
License: MIT (Copyright 2018 Thomas Durieux, from github.com/tdurieux/synctex-js)

This is a ~270-line pure TypeScript parser that reads the text-format SyncTeX file and builds an indexed data structure (`blockNumberLine`) mapping `{file -> {line -> {page -> blocks[]}}}`. It also stores horizontal blocks (`hBlocks`) and per-page block trees.

**Why this over alternatives:**
- No WASM-compiled synctex parser exists for the browser.
- The JS parser is battle-tested (used by all LaTeX-Workshop users).
- ~270 lines, zero dependencies, trivially vendorable.
- Supports both forward sync (`file+line -> page+rect`) and reverse sync (`page+x+y -> file+line`).

**Modifications needed for our use case:**
- Remove Node.js `path` dependency (not used in the parser itself, only in the worker.ts wrapper).
- Remove `iconv-lite` encoding fallback (our WASM engine uses UTF-8 paths).
- Remove `fs.existsSync` calls (we match by filename, not by filesystem existence).
- Adapt file path matching: SyncTeX records WASI paths like `./main.tex`. We normalize by stripping leading `./` to match our project store keys.

### Forward sync function (from LaTeX-Workshop worker.ts, simplified)

```typescript
function sync_to_pdf(data: PdfSyncObject, file: string, line: number):
  { page: number; x: number; y: number; width: number; height: number } | null
```

Algorithm:
1. Find `file` in `data.blockNumberLine` (with path normalization).
2. Get the sorted line numbers for that file.
3. Find the closest line >= `line`, or interpolate between bounding lines.
4. Compute the bounding rectangle of all blocks on that line.
5. Return `{ page, x: rect.left + offset.x, y: rect.bottom + offset.y, width, height }`.

The x/y/width/height are in **PDF user-space units** (1/72 inch, same as the PDF coordinate system). This is critical -- the synctexjs parser already converts from SyncTeX scaled points to PDF points using the constant `unit = 65781.76` (the number of scaled points per PDF point).

### Reverse sync function (from LaTeX-Workshop worker.ts, simplified)

```typescript
function sync_to_code(data: PdfSyncObject, page: number, x: number, y: number):
  { file: string; line: number } | null
```

Algorithm:
1. Subtract `data.offset.{x,y}` from the input coordinates.
2. Iterate all blocks on the given page across all files.
3. Skip blocks with type 'k' (kern) or 'r' (rule), or blocks with child elements.
4. For each block, compute a bounding Rectangle.
5. Find the block whose center is closest to (x, y), with a preference for blocks that are contained within others (more specific).
6. Return the file path and line number of the best match.

---

## Coordinate System Deep-Dive

### The three coordinate systems

1. **SyncTeX coordinates**: Scaled points (sp). 1 sp = 1/65536 pt = 1/(65536 x 72.27) inch. The synctexjs parser converts to PDF points by dividing by `unit = 65781.76` (approximately 65536 x 72.27/72).

2. **PDF user-space coordinates**: 1 unit = 1/72 inch. Origin at bottom-left of page. Y increases upward. This is what SyncTeX outputs after the unit conversion, and what PDF.js `viewport.convertToPdfPoint()` returns.

3. **Canvas pixel coordinates**: Origin at top-left. Scaled by `viewport.scale * devicePixelRatio`. Y increases downward.

### Forward sync: code -> PDF highlight

```
Editor cursor (file, line)
    |
    v
synctex.sync_to_pdf(data, file, line)
    -> { page, x, y, width, height }     // PDF user-space (1/72 inch, origin bottom-left)
    |
    v
viewport = pdfViewer.getPageView(page - 1).viewport
    |
    v
Convert to viewport coordinates:
    // SyncTeX y is from top (after offset), but PDF origin is bottom-left
    // viewport.viewBox[3] = page height in PDF units
    viewBoxHeight = viewport.viewBox[3]
    viewportRect = viewport.convertToViewportRectangle([
        x,                          // left in PDF space
        viewBoxHeight - (y),        // bottom -> flip to PDF bottom-left origin
        x + width,                  // right
        viewBoxHeight - (y - height) // top -> flip
    ])
    normalized = PDFJS.Util.normalizeRect(viewportRect)
    // normalized = [left, top, right, bottom] in CSS pixels relative to page div
    |
    v
Position a highlight div at those CSS coordinates within the page container.
Animate opacity: 0 -> 0.5 -> 0 over ~1.5s.
```

### Reverse sync: PDF click -> code

```
Mouse click event on page canvas
    |
    v
pageRect = canvas.getBoundingClientRect()
dx = event.clientX - pageRect.left      // CSS pixels from page left
dy = event.clientY - pageRect.top       // CSS pixels from page top
    |
    v
viewport = pdfViewer.getPageView(pageIndex).viewport
[pdfX, pdfY] = viewport.convertToPdfPoint(dx, dy)
    // Returns PDF user-space coords. pdfY is from BOTTOM of page.
    |
    v
// Convert to SyncTeX convention (Y from top):
syncY = viewport.viewBox[3] - pdfY
syncX = pdfX
    |
    v
synctex.sync_to_code(data, page, syncX, syncY)
    -> { file, line }
    |
    v
worker_client.request_goto(file, line)
    // Triggers existing goto mechanism (App.tsx effect + Editor.tsx jump)
```

### Key coordinate gotcha: the offset

SyncTeX files contain X Offset and Y Offset values (in scaled points, converted to PDF points by the parser). These represent the origin shift of the TeX output on the page. The `sync_to_pdf` function ADDS the offset to block coordinates. The `sync_to_code` function SUBTRACTS the offset from click coordinates. The synctexjs parser stores these in `data.offset.x` and `data.offset.y`.

### DPI and scale factors

- PDF.js viewport scale: configurable (we use `scale` to fit width). `viewport.convertToPdfPoint()` and `convertToViewportRectangle()` internally handle the scale transform, including rotation. We never need to manually multiply/divide by scale.
- `devicePixelRatio`: Handled by the canvas sizing (canvas.width = viewport.width * dpr, canvas.style.width = viewport.width + 'px'). The viewport transform matrix accounts for this when `transform` is passed to `page.render()`. The `convertToPdfPoint` works in CSS pixels (not canvas pixels), so DPI is transparent to the coordinate conversion.

---

## SyncTeX Data Extraction from WASM

### Feasibility: Confirmed

The existing `engine.ts` already:
1. Builds a WASI filesystem with `root_map` (Map<string, WasiFile | Directory>)
2. Runs tectonic via `wasi.start(instance)`
3. Extracts the PDF by looking up the output filename in `root_map`

Tectonic supports `--synctex` flag. The engine args change from:
```
["eztex", "compile", main_file]
```
to:
```
["eztex", "compile", "--synctex", main_file]
```

After compilation, the WASI filesystem will contain `{jobname}.synctex.gz` alongside `{jobname}.pdf` in the root directory. The extraction is identical to the PDF extraction:

```typescript
const synctex_name = main_file.replace(/\.tex$/, ".synctex.gz");
const synctex_inode = root_map.get(synctex_name) as WasiFile | undefined;
```

The `.synctex.gz` file is gzip-compressed. Decompression uses the browser `DecompressionStream` API (no dependencies). For a typical 20-page document, the synctex.gz is ~20-50KB compressed, ~100-300KB decompressed. Parsing takes <10ms.

### Transfer optimization

The synctex data is transferred from the Web Worker to the main thread via `postMessage`. Use `Transferable` for the `Uint8Array`:

```typescript
self.postMessage(
  { type: "complete", pdf: pdf_data, synctex: synctex_data, elapsed },
  { transfer: [pdf_data.buffer, synctex_data.buffer] }  // zero-copy transfer
);
```

---

## PDF.js Integration in SolidJS/Vite

### Initialization pattern

```typescript
// lib/pdf_viewer.ts -- imperative PDF.js wrapper (not reactive)
import * as PDFJS from "pdfjs-dist";
import { PDFViewer, EventBus, PDFLinkService, LinkTarget } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

// Worker: Vite handles this via import.meta.url
PDFJS.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;
```

Note: PDF.js uses a Web Worker internally for parsing/rendering. This is separate from our compilation Web Worker. The PDF.js worker handles decoding page content, font parsing, etc. This keeps the main thread responsive during rendering.

### SolidJS component pattern

The PDF.js viewer is imperative (DOM-based). In SolidJS, we use `onMount` to initialize and `createEffect` to react to signal changes:

```typescript
// components/Preview.tsx (sketch)
const Preview: Component = () => {
  let container_ref: HTMLDivElement | undefined;
  let viewer_wrapper: PdfViewerWrapper | undefined;

  onMount(() => {
    viewer_wrapper = new PdfViewerWrapper(container_ref!);
  });

  // React to new PDF data
  createEffect(() => {
    const pdf_bytes = worker_client.pdf_bytes();
    if (pdf_bytes && viewer_wrapper) {
      viewer_wrapper.load_document(pdf_bytes);
    }
  });

  // React to forward sync requests
  createEffect(() => {
    const sync = worker_client.sync_target();
    if (sync && viewer_wrapper) {
      viewer_wrapper.scroll_to_and_highlight(sync);
    }
  });

  onCleanup(() => {
    viewer_wrapper?.destroy();
  });

  return (
    <div class="preview-pane">
      <div class="preview-content">
        <div ref={container_ref} class="pdf-viewer-container">
          <div class="pdfViewer"></div>  {/* PDF.js mounts pages here */}
        </div>
      </div>
    </div>
  );
};
```

### Vite configuration

PDF.js 5.x works with Vite out of the box. The worker is loaded via `new URL(... import.meta.url)` which Vite recognizes. The CSS file needs to be imported. CMap and standard font data can be served from `node_modules/pdfjs-dist/cmaps/` via Vite's public directory or a copy plugin, but for LaTeX-generated PDFs these are rarely needed (fonts are embedded).

---

## Glitch-Free PDF Swap Strategy

### Problem

When the user compiles, a new PDF is generated. Naively destroying and recreating the viewer causes a white flash. The iframe approach had this same problem.

### Solution: PDFViewer.setDocument() with scroll preservation

PDF.js `PDFViewer` supports replacing the document without destroying the viewer:

```typescript
async load_document(data: Uint8Array): Promise<void> {
  // Save current scroll position
  const prev_page = this.viewer.currentPageNumber;
  const prev_scroll = this.container.scrollTop;

  // Load new document from ArrayBuffer
  const doc = await PDFJS.getDocument({ data }).promise;

  // Replace document (viewer handles cleanup of old document internally)
  this.viewer.setDocument(doc);
  this.link_service.setDocument(doc);

  // Restore scroll position after pages render
  this.event_bus.on("pagesloaded", () => {
    if (prev_page <= doc.numPages) {
      this.viewer.currentPageNumber = prev_page;
    }
    this.container.scrollTop = prev_scroll;
  }, { once: true });
}
```

### Additional smoothness measures

1. **Keep old pages visible until new ones render**: PDF.js does this by default when using `setDocument()` -- it doesn't clear the DOM until new pages are ready.
2. **Pass raw Uint8Array, not blob URL**: `PDFJS.getDocument({ data: uint8Array })` avoids the overhead of creating/revoking blob URLs.
3. **Debounce rapid recompiles**: The watch controller already handles this (400ms debounce).

### Signal architecture change

Currently `worker_client` creates a blob URL and exposes `pdf_url()`. With PDF.js, we instead expose the raw bytes:

```typescript
// worker_client.ts
const [pdf_bytes, set_pdf_bytes] = createSignal<Uint8Array | null>(null);
// ... in handle_message "complete" case:
if (pdf_data) {
  set_pdf_bytes(new Uint8Array(pdf_data));
}
```

We also keep `pdf_url` for the initial OPFS-restored PDF (which is already a blob URL from `load_pdf()`). On first load we convert to bytes via fetch, or store as bytes directly.

---

## Module Breakdown

### New files

| File | Purpose | Size estimate |
|------|---------|--------------|
| `app/src/lib/pdf_viewer.ts` | Imperative PDF.js wrapper class. Handles init, load, scroll, highlight, click->coordinate conversion. | ~200 lines |
| `app/src/lib/synctex.ts` | Vendored + adapted synctexjs parser + forward/reverse sync functions + gzip decompress helper. | ~350 lines |

### Modified files

| File | Changes |
|------|---------|
| `app/src/worker/protocol.ts` | Add `synctex: Uint8Array | null` to `complete` message type. Update `send_complete` signature. |
| `app/src/worker/engine.ts` | Add `--synctex` to WASM args. Extract `.synctex.gz` from root_map. Pass to `send_complete`. Use Transferable for both pdf and synctex buffers. |
| `app/src/lib/worker_client.ts` | Add `pdf_bytes` signal (replace `pdf_url`). Add `synctex_data` signal (parsed PdfSyncObject). Add `sync_target` signal for forward sync. Add `sync_to_code` for reverse sync dispatch. Decompress + parse synctex in `handle_message`. |
| `app/src/components/Preview.tsx` | Replace iframe with PDF.js viewer. Add click handler for reverse sync. Add highlight overlay for forward sync. |
| `app/src/components/Editor.tsx` | Add debounced forward sync on cursor movement. |
| `app/src/App.tsx` | Minor: pass store to Preview if needed for current file context. Handle reverse sync goto (already exists via `goto_request`). |
| `app/src/index.css` | Add PDF.js viewer styles, highlight animation keyframes. Remove iframe-specific styles. |
| `app/package.json` | Add `pdfjs-dist` dependency. |

### Files NOT changed

| File | Why |
|------|-----|
| `worker/worker.ts` | No changes needed -- engine.ts handles everything. |
| `worker/wasm_api.ts` | No synctex-related API needed from Zig side. |
| `lib/project_store.ts` | No changes needed. |
| `lib/watch_controller.ts` | No changes needed. |

---

## Data Flow Diagrams

### Compile pipeline (with SyncTeX)

```
User edits -> watch_controller debounce -> worker_client.compile()
    |
    v
Worker thread: engine.compile(files, main)
    args: ["eztex", "compile", "--synctex", main_file]
    |
    v
WASM tectonic runs, produces:
    root_map: { "main.pdf" -> WasiFile, "main.synctex.gz" -> WasiFile }
    |
    v
engine.ts extracts both:
    pdf_data = new Uint8Array(pdf_inode.data)
    synctex_data = new Uint8Array(synctex_inode.data)  // may be null
    |
    v
postMessage({ type: "complete", pdf: pdf_data, synctex: synctex_data, elapsed },
            { transfer: [pdf_data.buffer, synctex_data?.buffer].filter(Boolean) })
    |
    v
Main thread: worker_client.handle_message()
    set_pdf_bytes(pdf_data)              // triggers Preview re-render
    decompress_gzip(synctex_data)
      .then(text => parseSyncTex(text))
      .then(obj => set_synctex_data(obj))  // enables sync features
```

### Forward sync (editor -> PDF)

```
Editor cursor moves (EditorView.updateListener)
    |
    v
Debounce 300ms -> sync_forward(current_file, line)
    |
    v
worker_client: synctex_data() available?
    No -> return (no-op)
    Yes -> sync_to_pdf(data, file, line) -> { page, x, y, width, height }
    |
    v
set_sync_target({ page, x, y, width, height })
    |
    v
Preview.tsx effect: viewer_wrapper.scroll_to_and_highlight(target)
    1. Scroll page into view
    2. Convert coordinates: viewport.convertToViewportRectangle(...)
    3. Create highlight div, animate opacity 0 -> 0.4 -> 0 over 1.5s
    4. Remove div after animation
```

### Reverse sync (PDF click -> editor)

```
Ctrl+Click on PDF canvas
    |
    v
Preview.tsx click handler:
    pageIndex = determine which page was clicked (from page element data attribute)
    canvas = page canvas element
    pageRect = canvas.getBoundingClientRect()
    dx = event.clientX - pageRect.left
    dy = event.clientY - pageRect.top
    viewport = viewer.getPageView(pageIndex).viewport
    [pdfX, pdfY] = viewport.convertToPdfPoint(dx, dy)
    syncY = viewport.viewBox[3] - pdfY    // flip Y to top-origin
    syncX = pdfX
    |
    v
worker_client.sync_to_code(page, syncX, syncY)
    synctex_data() available?
    No -> return
    Yes -> sync_to_code(data, page + 1, syncX, syncY) -> { file, line }
    |
    v
worker_client.request_goto(file, line)
    |
    v
App.tsx effect: switch to file if needed
Editor.tsx effect: scroll to line, set cursor
```

---

## Implementation Phases

### Phase 1: Enable SyncTeX output from WASM

**Effort: Quick (30 min)**

1. `engine.ts`: Add `"--synctex"` to WASM args in `compile()`.
2. `engine.ts`: Extract `synctex.gz` from `root_map` after compilation.
3. `protocol.ts`: Add `synctex` field to complete message, update `send_complete`.
4. `engine.ts`: Pass synctex data in `send_complete`, use `Transferable`.

### Phase 2: SyncTeX parser

**Effort: Short (1-2 hours)**

5. Create `lib/synctex.ts`:
   - Vendor the `parseSyncTex` function from synctexjs.ts (MIT).
   - Add `decompress_gzip()` using browser `DecompressionStream`.
   - Add `sync_to_pdf(data, file, line)` forward sync function.
   - Add `sync_to_code(data, page, x, y)` reverse sync function.
   - Add path normalization (strip `./` prefix, case-insensitive matching).

6. `worker_client.ts`: Add synctex_data signal, decompress + parse in `handle_message`.

### Phase 3: PDF.js integration (replace iframe)

**Effort: Medium (half day)**

7. `bun add pdfjs-dist` (add dependency).

8. Create `lib/pdf_viewer.ts`:
   - PDF.js initialization (worker, event bus, link service).
   - `PdfViewerWrapper` class with: `load_document(data)`, `scroll_to_page(n)`, `highlight_rect(page, rect)`, `click_position(event) -> {page, x, y}`, `destroy()`.
   - Scroll position preservation across document reloads.
   - Scale management (fit-width by default, Ctrl+scroll to zoom).

9. Rewrite `components/Preview.tsx`:
   - Replace iframe with PDF.js container div.
   - `onMount`: create PdfViewerWrapper.
   - `createEffect` on `pdf_bytes`: call `load_document`.
   - Ctrl+click handler for reverse sync.
   - Forward sync highlight effect.

10. `worker_client.ts`: Add `pdf_bytes` signal. Change `handle_message` to store raw bytes instead of (or alongside) blob URL. Handle OPFS-restored PDF as bytes.

11. `index.css`: Add PDF.js viewer CSS overrides, highlight animation.

### Phase 4: Forward sync wiring

**Effort: Short (1-2 hours)**

12. `components/Editor.tsx`: Add debounced cursor position tracking. On cursor move, call `worker_client.sync_forward(file, line)`.

13. `worker_client.ts`: Add `sync_forward(file, line)` that calls `sync_to_pdf` and sets `sync_target` signal.

14. `components/Preview.tsx`: Effect that watches `sync_target` and calls `viewer_wrapper.scroll_to_and_highlight()`.

### Phase 5: Reverse sync wiring

**Effort: Short (1 hour)**

15. `components/Preview.tsx`: Ctrl+click handler that calls `viewport.convertToPdfPoint()`, flips Y, and calls `worker_client.sync_to_code()`.

16. `worker_client.ts`: Add `sync_to_code(page, x, y)` that looks up in synctex_data and calls `request_goto()`.

17. Test: Ctrl+click a word in PDF -> editor jumps to corresponding source line.

### Phase 6: Polish

**Effort: Short (1-2 hours)**

18. Highlight animation: CSS keyframe `@keyframes sync-flash { 0% { opacity: 0 } 20% { opacity: 0.4 } 100% { opacity: 0 } }`. Duration 1.5s.

19. Scroll behavior: Smooth scroll to page on forward sync rather than instant jump.

20. Zoom controls: Ctrl+scroll wheel on PDF container. Store scale in localStorage.

21. Error handling: Graceful fallback if synctex.gz not produced (e.g., compilation error). Graceful fallback if PDF.js fails to render a page.

22. Keyboard shortcut: Add Cmd+Shift+Click or Cmd+Enter as forward sync trigger (compile and sync to cursor position).

---

## Total Effort Estimate

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | SyncTeX output from WASM | Quick (30 min) |
| 2 | SyncTeX parser | Short (1-2 hours) |
| 3 | PDF.js integration | Medium (half day) |
| 4 | Forward sync | Short (1-2 hours) |
| 5 | Reverse sync | Short (1 hour) |
| 6 | Polish | Short (1-2 hours) |
| **Total** | | **Medium-Large (1.5-2 days)** |

Phase 3 is the bulk of the work and the highest risk. Phases 1-2 are independent of PDF.js and can be done first to validate the synctex pipeline.

---

## Performance Analysis

### PDF.js rendering performance

- **Cold load**: First `getDocument()` + render of all visible pages: ~200-400ms for a 20-page PDF. The PDF.js worker parses in parallel.
- **Page render**: Individual page render at 1.5x scale: ~20-50ms. PDF.js renders lazily (only visible pages + a small buffer).
- **Memory**: ~2-5MB for a 20-page PDF document + rendered canvases. Each rendered page canvas at 1.5x scale on a 2x DPI screen is ~4-8MB of pixel data, but PDF.js only keeps visible pages rendered.
- **Re-render on recompile**: `setDocument()` with a new ArrayBuffer: ~200-400ms to re-render visible pages. Scroll position preserved.

### Comparison to native iframe

- Native iframe cold load: ~100-200ms (browser's built-in renderer is faster).
- Native iframe re-render: Blob URL change forces full reload with white flash.
- PDF.js is ~2x slower on initial render but provides smoother recompile transitions.

### SyncTeX parsing performance

- Decompress 50KB gzip: ~5ms (browser DecompressionStream is native code).
- Parse 300KB synctex text: ~5-15ms (regex-based line-by-line parser).
- Forward/reverse lookup: <1ms (direct object property access).
- Total synctex overhead per compile: ~10-20ms. Negligible.

### Web Worker usage

PDF.js uses its own Web Worker internally (for PDF parsing). Our compilation worker is separate. No contention -- they serve different purposes. The PDF.js worker loads asynchronously and is cached by the browser after first load.

---

## Risks and Mitigations

### Risk 1: PDF.js rendering fidelity

**Issue**: Some LaTeX-generated PDFs use obscure font encodings or special features that PDF.js might render differently than the native browser renderer.

**Mitigation**: PDF.js handles >99% of LaTeX output correctly. It has explicit CMap support for CJK fonts. If a rendering issue is found, it is likely a PDF.js bug that can be reported upstream. For MVP, this is acceptable.

### Risk 2: Bundle size increase

**Issue**: Adding ~170KB gzipped is significant for a web app.

**Mitigation**: The PDF.js worker loads asynchronously and does not block initial page load. The core library is needed before any PDF can be displayed, which is not the first thing the user sees (they see the editor first). Lazy-load the PDF.js imports in Preview.tsx using dynamic `import()` so it is code-split into a separate chunk.

### Risk 3: SyncTeX coordinate accuracy

**Issue**: The coordinate conversion chain has multiple steps. Off-by-one or rounding errors could cause highlights to appear in the wrong position or reverse sync to pick the wrong line.

**Mitigation**: The conversion functions used (viewport.convertToPdfPoint, convertToViewportRectangle) are the same ones used by Overleaf, LaTeX-Workshop, and every other PDF.js-based LaTeX editor. The synctexjs parser has been in production use for years. Test with a known document and verify pixel positions.

### Risk 4: PDF.js version stability

**Issue**: PDF.js has frequent major releases that can break APIs.

**Mitigation**: Pin to a specific `pdfjs-dist` version (currently 5.x). The core API (getDocument, getPage, getViewport, render) has been stable across major versions. The PDFViewer class from `pdfjs-dist/web/pdf_viewer.mjs` is the higher-level component that handles pagination, scrolling, and page management.

### Risk 5: OPFS PDF restore compatibility

**Issue**: Currently the app restores PDFs from OPFS as blob URLs. PDF.js needs ArrayBuffer data.

**Mitigation**: Either store the raw PDF bytes in the OPFS (not blob URLs), or fetch the blob URL back to get ArrayBuffer. The simpler approach: change `project_persist.ts` to store/restore raw bytes, pass them directly to PDF.js.

### Risk 6: synctex.gz not produced

**Issue**: If the Zig/tectonic WASM binary does not support `--synctex` or the flag is ignored, no synctex file will be produced.

**Mitigation**: The plan includes checking for the synctex file's existence. If null, sync features are simply disabled (signals stay null, no errors). This is the graceful degradation path. Test the `--synctex` flag early in Phase 1 to validate.

---

## Appendix: Key API Reference

### PDF.js viewport coordinate transforms

```typescript
// Get viewport for a page at given scale
const viewport = page.getViewport({ scale: 1.5 });

// Canvas pixel coords (CSS) -> PDF user-space coords
const [pdfX, pdfY] = viewport.convertToPdfPoint(canvasX, canvasY);
// pdfY is from BOTTOM of page (PDF convention)

// PDF user-space rect -> canvas pixel rect
const viewportRect = viewport.convertToViewportRectangle([left, bottom, right, top]);
// Returns [x1, y1, x2, y2] in CSS pixels -- may need normalizing

// Normalize (ensure x1<x2, y1<y2)
const [left, top, right, bottom] = PDFJS.Util.normalizeRect(viewportRect);

// Page dimensions in PDF units
const pageWidth = viewport.viewBox[2];   // typically 612 (8.5in * 72)
const pageHeight = viewport.viewBox[3];  // typically 792 (11in * 72)
```

### SyncTeX unit constant

```
65781.76 sp per PDF point

Where:
  1 sp (scaled point) = 1/65536 TeX points
  1 TeX point = 1/72.27 inch
  1 PDF point = 1/72 inch

  So: 65536 * 72.27/72 = 65781.76
```

### Overleaf's highlight positioning (reference implementation)

From `overleaf/overleaf/services/web/frontend/js/features/pdf-preview/util/highlights.ts`:

```typescript
// page coordinates from synctex
const rectangle = {
  left: highlight.h,
  right: highlight.h + highlight.width,
  top: highlight.v,
  bottom: highlight.v + highlight.height,
};

// needed because PDF page origin is at the bottom left
const viewBoxHeight = viewport.viewBox[3] + 10;

// account for scaling
const viewportRectangle = viewport.convertToViewportRectangle([
  rectangle.left,
  viewBoxHeight - rectangle.bottom,
  rectangle.right,
  viewBoxHeight - rectangle.top,
]);

const normalizedRectangle = PDFJS.Util.normalizeRect(viewportRectangle);
```

### Overleaf's reverse sync click handler (reference implementation)

From `overleaf/overleaf/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts`:

```typescript
clickPosition(event: MouseEvent, canvas: HTMLCanvasElement, page: number) {
  const { viewport } = this.viewer.getPageView(page);
  const pageRect = canvas.getBoundingClientRect();
  const dx = event.clientX - pageRect.left;
  const dy = event.clientY - pageRect.top;
  const [left, top] = viewport.convertToPdfPoint(dx, dy);
  return {
    page,
    offset: {
      left,
      top: viewport.viewBox[3] - top,  // flip Y
    },
  };
}
```
