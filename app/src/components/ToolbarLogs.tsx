import { type Component, For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import { worker_client, type LogEntry } from "../lib/worker_client";

type Props = {
  logs: LogEntry[];
  show: boolean;
  on_toggle: () => void;
};

function log_class(entry: LogEntry): string {
  if (entry.cls.includes("error")) return "log-line log-error";
  if (entry.cls.includes("warn")) return "log-line log-warn";
  if (entry.cls.includes("info")) return "log-line log-info";
  return "log-line";
}

function status_color(): string {
  const s = worker_client.status();
  if (s === "loading" || s === "compiling") return "var(--yellow)";
  if (s === "success") return "var(--green)";
  if (s === "error") return "var(--red)";
  return "var(--fg-dim)";
}

const ToolbarLogs: Component<Props> = (props) => {
  const [logs_pinned, set_logs_pinned] = createSignal(false);
  const [logs_auto_opened, set_logs_auto_opened] = createSignal(false);
  let log_ref: HTMLDivElement | undefined;
  let status_btn_ref: HTMLButtonElement | undefined;
  let prev_log_status: string | undefined;

  function set_show(next: boolean) {
    if (props.show !== next) props.on_toggle();
  }

  function dismiss_logs() {
    if (logs_pinned()) return;
    set_show(false);
    set_logs_auto_opened(false);
  }

  function handle_copy_logs() {
    const text = props.logs.map(e => e.msg).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function handle_clear_logs() {
    worker_client.clear_logs();
  }

  createEffect(() => {
    void props.logs.length;
    if (props.show && log_ref) {
      requestAnimationFrame(() => { log_ref!.scrollTop = log_ref!.scrollHeight; });
    }
  });

  createEffect(() => {
    const s = worker_client.status();
    const was = prev_log_status;
    prev_log_status = s;
    if (s === "error" && was !== "error") {
      if (!untrack(() => props.show) && !untrack(logs_pinned)) {
        set_logs_auto_opened(true);
        set_show(true);
      }
    } else if ((s === "success" || s === "idle") && was === "error") {
      if (untrack(logs_auto_opened) && !untrack(logs_pinned)) {
        set_show(false);
        set_logs_auto_opened(false);
      }
    }
  });

  createEffect(() => {
    if (worker_client.status() === "success" && status_btn_ref) {
      status_btn_ref.classList.remove("flash-success");
      void status_btn_ref.offsetWidth;
      status_btn_ref.classList.add("flash-success");
    }
  });

  onCleanup(() => {
    prev_log_status = undefined;
  });

  return (
    <>
      <AnimatedShow when={props.show}>
        <Show when={!logs_pinned()}>
          <div class="click-interceptor" onMouseDown={dismiss_logs} />
        </Show>
        <div class="compile-logs-popover">
          <div class="popover-action-bar">
            <button
              class={`icon-btn popover-pin ${logs_pinned() ? "active" : ""}`}
              title={logs_pinned() ? "Unpin" : "Pin open"}
              onClick={() => set_logs_pinned(v => !v)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={logs_pinned() ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>
            </button>
            <button class="icon-btn" title="Copy all" onClick={handle_copy_logs}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="icon-btn" title="Clear log" onClick={handle_clear_logs}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
          <div class="compile-logs-scroll" ref={log_ref}>
            <For each={props.logs}>
              {(entry) => <div class={log_class(entry)}>{entry.msg}</div>}
            </For>
            <Show when={props.logs.length === 0}>
              <div class="log-empty">No logs yet.</div>
            </Show>
          </div>
        </div>
      </AnimatedShow>
      <button
        ref={status_btn_ref}
        class={`compile-group-status ${props.show ? "expanded" : ""}`}
        onClick={() => { props.on_toggle(); set_logs_auto_opened(false); }}
        title="Show compilation logs"
        style={{ color: status_color() }}
      >
        <span class="compile-group-text">{worker_client.status_text()}</span>
        <Show when={worker_client.last_elapsed()}>
          <span class="compile-group-elapsed">{worker_client.last_elapsed()}</span>
        </Show>
      </button>
    </>
  );
};

export default ToolbarLogs;
