import { type Component, Show } from "solid-js";
import { worker_client } from "../lib/worker_client";

const Preview: Component = () => {
  function handle_download() {
    const url = worker_client.pdf_url();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.pdf";
    a.click();
  }

  return (
    <div class="preview-pane">
      <div class="preview-content">
        <Show
          when={worker_client.pdf_url()}
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
          <div class="pdf-container">
            <iframe
              src={worker_client.pdf_url()!}
              class="pdf-frame"
              title="PDF Preview"
            />
          </div>
          <button class="preview-download-btn" title="Download PDF" onClick={handle_download}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </Show>
      </div>
    </div>
  );
};

export default Preview;
