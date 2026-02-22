import { type Component, Show } from "solid-js";
import { worker_client } from "../lib/worker_client";

const Preview: Component = () => {
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
        </Show>
      </div>
    </div>
  );
};

export default Preview;
