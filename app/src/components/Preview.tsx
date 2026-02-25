import { type Component, Show, createMemo } from "solid-js";
import { worker_client } from "../lib/worker_client";

function pdf_viewer_url(url: string): string {
  if (url.startsWith("blob:") || url.startsWith("data:")) {
    return url + "#toolbar=0&navpanes=0&scrollbar=1&view=FitH";
  }
  return url;
}

const Preview: Component = () => {
  const iframe_src = createMemo(() => {
    const url = worker_client.pdf_url();
    return url ? pdf_viewer_url(url) : null;
  });

  return (
    <div class="preview-pane">
      <div class="preview-content">
        <Show
          when={iframe_src()}
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
              src={iframe_src()!}
              class="pdf-frame"
              title="PDF Preview"
            />
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Preview;
