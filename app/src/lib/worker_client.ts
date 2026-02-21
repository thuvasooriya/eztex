// worker client -- reactive interface to worker thread
// spawns a module worker and exposes signals for status/progress/logs/pdf

import { createSignal, batch } from "solid-js";

export type LogEntry = {
  msg: string;
  cls: string;
  ts: number;
};

export type WorkerStatus = "idle" | "loading" | "compiling" | "success" | "error";

export type CompileRequest = {
  files: Record<string, string>;
  main?: string;
};

const [status, set_status] = createSignal<WorkerStatus>("idle");
const [status_text, set_status_text] = createSignal("Initializing...");
const [progress, set_progress] = createSignal(0);
const [logs, set_logs] = createSignal<LogEntry[]>([]);
const [pdf_url, set_pdf_url] = createSignal<string | null>(null);
const [ready, set_ready] = createSignal(false);
const [compiling, set_compiling] = createSignal(false);
const [last_elapsed, set_last_elapsed] = createSignal<string | null>(null);

let worker: Worker | null = null;
let prev_pdf_url: string | null = null;

// imperative compile-done callback -- used by watch_controller
let _on_compile_done_cb: (() => void) | null = null;
function on_compile_done(cb: () => void) { _on_compile_done_cb = cb; }

// detect ?debug=1 query param for debug mode passthrough to worker
const _debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

function append_log(msg: string, cls: string = "") {
  const entry: LogEntry = { msg, cls, ts: Date.now() };
  set_logs((prev) => [...prev, entry]);
}

function clear_logs() {
  set_logs([]);
}

function handle_message(e: MessageEvent) {
  const data = e.data;
  switch (data.type) {
    case "status":
      set_status_text(data.msg);
      if (data.cls === "loading") set_status("loading");
      else if (data.cls === "success") set_status("success");
      else if (data.cls === "error") set_status("error");
      break;
    case "progress":
      set_progress(data.pct);
      break;
    case "log":
      append_log(data.msg, data.cls || "");
      break;
    case "cache_status":
      append_log(`[cache] ${data.status}${data.detail ? ": " + data.detail : ""}`, "log-info");
      break;
    case "ready":
      batch(() => {
        set_ready(true);
        set_status("idle");
        set_status_text("Ready");
        set_progress(100);
      });
      break;
    case "complete": {
      const pdf_data = data.pdf;
      if (pdf_data) {
        if (prev_pdf_url) URL.revokeObjectURL(prev_pdf_url);
        const blob = new Blob([pdf_data], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        prev_pdf_url = url;
        set_pdf_url(url);
      }
      batch(() => {
        set_compiling(false);
        set_last_elapsed(data.elapsed ? `${data.elapsed}s` : null);
        if (!pdf_data) {
          set_status("error");
          set_status_text("Error");
        } else {
          set_status_text("Success");
        }
      });
      _on_compile_done_cb?.();
      break;
    }
  }
}

function init_worker() {
  if (worker) return;
  worker = new Worker(new URL("../worker/worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = handle_message;
  worker.onerror = (e) => {
    append_log(`worker error: ${e.message}`, "log-error");
    set_status("error");
  };
  set_status("loading");
  set_status_text("Loading WASM...");
  worker.postMessage({ type: "init", debug: _debug });
}

function compile(req: CompileRequest) {
  if (!worker || !ready()) return;
  set_compiling(true);
  set_status("compiling");
  set_status_text("Compiling...");
  worker.postMessage({
    type: "compile",
    files: req.files,
    main: req.main,
    debug: _debug,
  });
}

function clear_cache() {
  if (!worker) return;
  worker.postMessage({ type: "clear_cache" });
  append_log("[ui] cache clear requested", "log-info");
}

export const worker_client = {
  init: init_worker,
  compile,
  clear_cache,
  clear_logs,
  on_compile_done,
  // signals (read-only)
  status,
  status_text,
  progress,
  logs,
  pdf_url,
  ready,
  compiling,
  last_elapsed,
};
