import { type Component, Show, For, createSignal, createEffect, untrack } from "solid-js";
import { worker_client } from "../lib/worker_client";
import type { ProjectStore } from "../lib/project_store";
import type { Diagnostic } from "../worker/protocol";

type Props = {
  store: ProjectStore;
};

const DiagnosticPill: Component<Props> = (props) => {
  const [expanded, set_expanded] = createSignal(false);
  const [pinned, set_pinned] = createSignal(false);
  const [auto_opened, set_auto_opened] = createSignal(false);
  let pill_ref: HTMLDivElement | undefined;

  function dismiss_diags() {
    if (pinned()) return;
    set_expanded(false);
    set_auto_opened(false);
  }

  function handle_diag_click(d: Diagnostic): void {
    if (!d.file || !d.line) return;
    props.store.set_current_file(d.file);
    worker_client.request_goto(d.file, d.line);
    set_expanded(false);
  }

  function handle_copy_diags() {
    const text = diags().map(d => {
      const loc = d.file ? ` (${d.file}${d.line ? `:${d.line}` : ""})` : "";
      return `[${d.severity}] ${d.message}${loc}`;
    }).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  const diags = () => worker_client.diagnostics();
  const error_count = () => diags().filter(d => d.severity === "error").length;
  const warn_count = () => diags().filter(d => d.severity === "warning").length;

  // auto-expand on error diagnostics, auto-collapse when errors resolve
  // edge-triggered: only opens when error_count transitions from 0 to >0
  let prev_error_count = 0;
  createEffect(() => {
    const errs = error_count();
    const was = prev_error_count;
    prev_error_count = errs;
    if (errs > 0 && was === 0) {
      if (!untrack(expanded) && !untrack(pinned)) {
        set_auto_opened(true);
        set_expanded(true);
      }
    } else if (errs === 0 && was > 0) {
      if (untrack(auto_opened) && !untrack(pinned)) {
        set_expanded(false);
        set_auto_opened(false);
      }
    }
  });

  return (
    <Show when={diags().length > 0}>
      <div class="diag-pill-container" ref={pill_ref}>
        <Show when={expanded()}>
          <div class="click-interceptor" onMouseDown={dismiss_diags} />
          <div class="diag-pill-popover">
            <div class="diag-pill-header">
              <span>Diagnostics</span>
              <div class="popover-action-bar inline">
                <button
                  class={`icon-btn popover-pin ${pinned() ? "active" : ""}`}
                  title={pinned() ? "Unpin" : "Pin open"}
                  onClick={() => set_pinned(v => !v)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill={pinned() ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>
                </button>
                <button class="icon-btn" title="Copy all" onClick={handle_copy_diags}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
            </div>
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
          onClick={() => { set_expanded(v => !v); set_auto_opened(false); }}
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
