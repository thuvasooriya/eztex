// worker client -- reactive interface to worker thread
// spawns a module worker and exposes signals for status/progress/logs/pdf

import { createSignal, batch } from "solid-js";
import type { ProjectFiles } from "./project_store";

export type LogEntry = {
  msg: string;
  cls: string;
  ts: number;
};

export type WorkerStatus = "idle" | "loading" | "compiling" | "success" | "error";

export type CompileRequest = {
  files: ProjectFiles;
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

// imperative compile-done callbacks -- supports multiple subscribers
const _on_compile_done_cbs: Array<() => void> = [];
function on_compile_done(cb: () => void): () => void {
  _on_compile_done_cbs.push(cb);
  return () => { const i = _on_compile_done_cbs.indexOf(cb); if (i >= 0) _on_compile_done_cbs.splice(i, 1); };
}

// imperative ready callback -- used by App for auto-compile on load
let _on_ready_cb: (() => void) | null = null;
function on_ready(cb: () => void) { _on_ready_cb = cb; }

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
      _on_ready_cb?.();
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
      for (const cb of _on_compile_done_cbs) cb();
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
  set_progress(0);
  worker.postMessage({
    type: "compile",
    files: req.files,
    main: req.main,
    debug: _debug,
  });
}

// stub: SAB-based cancellation not yet implemented -- falls back to dirty_compiling in watch_controller
function cancel_and_recompile(_req: CompileRequest): boolean {
  return false;
}

function clear_cache() {
  if (!worker) return;
  worker.postMessage({ type: "clear_cache" });
  append_log("[ui] cache clear requested", "log-info");
}

function restore_pdf_url(url: string) {
  if (prev_pdf_url) URL.revokeObjectURL(prev_pdf_url);
  prev_pdf_url = url;
  set_pdf_url(url);
}

export const worker_client = {
  init: init_worker,
  compile,
  cancel_and_recompile,
  clear_cache,
  clear_logs,
  on_compile_done,
  on_ready,
  restore_pdf_url,
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
