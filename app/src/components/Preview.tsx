import { type Component, Show, onMount, onCleanup, createEffect } from "solid-js";
import { worker_client } from "../lib/worker_client";
import { PdfViewerWrapper } from "../lib/pdf_viewer";

const Preview: Component = () => {
  let container_ref: HTMLDivElement | undefined;
  let viewer: PdfViewerWrapper | undefined;

  onMount(() => {
    if (!container_ref) return;
    viewer = new PdfViewerWrapper(container_ref);
  });

  // load PDF when bytes change
  createEffect(() => {
    const bytes = worker_client.pdf_bytes();
    if (bytes && viewer) {
      viewer.load_document(bytes);
    }
  });

  // forward sync: highlight target in PDF
  createEffect(() => {
    const target = worker_client.sync_target();
    if (target && viewer) {
      viewer.scroll_to_and_highlight(target);
    }
  });

  // reverse sync: Ctrl+click on PDF -> jump to source
  function handle_click(e: MouseEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!viewer) return;
    const pos = viewer.click_to_synctex(e);
    if (!pos) return;
    e.preventDefault();
    e.stopPropagation();
    worker_client.sync_to_code(pos.page, pos.x, pos.y);
  }

  // fallback: also load from pdf_url for OPFS-restored PDFs (blob URL -> bytes)
  createEffect(() => {
    const url = worker_client.pdf_url();
    const bytes = worker_client.pdf_bytes();
    if (url && !bytes && viewer) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const arr = new Uint8Array(buf);
          worker_client.restore_pdf_bytes(arr);
        })
        .catch(() => {});
    }
  });

  onCleanup(() => {
    viewer?.destroy();
  });

  return (
    <div class="preview-pane">
      <div class="preview-content">
        <Show
          when={worker_client.pdf_bytes() || worker_client.pdf_url()}
          fallback={
            <div class="preview-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--fg-dark)" stroke-width="1">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>Compile to see PDF</span>
            </div>
          }
        >
          <div class="pdf-container" ref={container_ref} onClick={handle_click}>
            <div class="pdfViewer" />
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Preview;
