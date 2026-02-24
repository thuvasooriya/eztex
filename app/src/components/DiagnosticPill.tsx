import { type Component, Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { worker_client } from "../lib/worker_client";
import type { ProjectStore } from "../lib/project_store";
import type { Diagnostic } from "../worker/protocol";

type Props = {
  store: ProjectStore;
};

const DiagnosticPill: Component<Props> = (props) => {
  const [expanded, set_expanded] = createSignal(false);
  let pill_ref: HTMLDivElement | undefined;

  // close on outside click
  function handle_outside(e: MouseEvent) {
    if (pill_ref && !pill_ref.contains(e.target as Node)) {
      set_expanded(false);
    }
  }

  createEffect(() => {
    if (expanded()) {
      document.addEventListener("mousedown", handle_outside);
    } else {
      document.removeEventListener("mousedown", handle_outside);
    }
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handle_outside);
  });

  function handle_diag_click(d: Diagnostic): void {
    if (!d.file || !d.line) return;
    props.store.set_current_file(d.file);
    worker_client.request_goto(d.file, d.line);
    set_expanded(false);
  }

  const diags = () => worker_client.diagnostics();
  const error_count = () => diags().filter(d => d.severity === "error").length;
  const warn_count = () => diags().filter(d => d.severity === "warning").length;

  return (
    <Show when={diags().length > 0}>
      <div class="diag-pill-container" ref={pill_ref}>
        <Show when={expanded()}>
          <div class="diag-pill-popover">
            <div class="diag-pill-header">Diagnostics</div>
            <div class="diag-pill-list">
              <For each={diags()}>
                {(d) => (
                  <button
                    class={`diag-entry ${d.severity === "error" ? "diag-error" : "diag-warning"}`}
                    onClick={() => handle_diag_click(d)}
                    disabled={!d.file || !d.line}
                  >
                    <span class="diag-severity">{d.severity === "error" ? "x" : "!"}</span>
                    <span class="diag-message">{d.message}</span>
                    <Show when={d.file}>
                      <span class="diag-location">{d.file}{d.line ? `:${d.line}` : ""}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <button
          class={`diag-pill ${expanded() ? "expanded" : ""}`}
          onClick={() => set_expanded(v => !v)}
        >
          <Show when={error_count() > 0}>
            <span class="diag-pill-badge diag-pill-errors">{error_count()}</span>
          </Show>
          <Show when={warn_count() > 0}>
            <span class="diag-pill-badge diag-pill-warnings">{warn_count()}</span>
          </Show>
          <span class="diag-pill-label">
            {error_count() > 0 ? (error_count() === 1 ? "error" : "errors") : (warn_count() === 1 ? "warning" : "warnings")}
          </span>
        </button>
      </div>
    </Show>
  );
};

export default DiagnosticPill;
