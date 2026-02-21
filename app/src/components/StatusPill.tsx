import {
  type Component,
  Show,
  For,
  createSignal,
  createEffect,
  onCleanup,
} from "solid-js";
import { worker_client, type LogEntry } from "../lib/worker_client";

const StatusPill: Component = () => {
  const [expanded, set_expanded] = createSignal(false);
  let log_ref: HTMLDivElement | undefined;
  let pill_ref: HTMLDivElement | undefined;

  // auto-scroll when new logs arrive and popover is open
  createEffect(() => {
    void worker_client.logs();
    if (expanded() && log_ref) {
      requestAnimationFrame(() => {
        log_ref!.scrollTop = log_ref!.scrollHeight;
      });
    }
  });

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

  // auto-open popover when an error occurs
  createEffect(() => {
    if (worker_client.status() === "error") {
      set_expanded(true);
    }
  });

  function status_color(): string {
    const s = worker_client.status();
    if (s === "loading" || s === "compiling") return "var(--yellow)";
    if (s === "success") return "var(--green)";
    if (s === "error") return "var(--red)";
    return "var(--fg-muted)";
  }

  function log_class(entry: LogEntry): string {
    if (entry.cls.includes("error")) return "log-line log-error";
    if (entry.cls.includes("warn")) return "log-line log-warn";
    if (entry.cls.includes("info")) return "log-line log-info";
    return "log-line";
  }

  return (
    <div class="status-pill-container" ref={pill_ref}>
      <Show when={expanded()}>
        <div class="status-popover">
          <div class="status-popover-logs" ref={log_ref}>
            <For each={worker_client.logs()}>
              {(entry) => <div class={log_class(entry)}>{entry.msg}</div>}
            </For>
            <Show when={worker_client.logs().length === 0}>
              <div class="log-empty">No logs yet.</div>
            </Show>
          </div>
        </div>
      </Show>
      <button
        class={`status-pill ${expanded() ? "expanded" : ""}`}
        onClick={() => set_expanded(!expanded())}
      >
        <span class="status-dot" style={{ background: status_color() }} />
        <span class="status-pill-text">{worker_client.status_text()}</span>
        <Show when={worker_client.last_elapsed()}>
          <span class="status-pill-elapsed">{worker_client.last_elapsed()}</span>
        </Show>
      </button>
    </div>
  );
};

export default StatusPill;
