// worker client -- reactive interface to worker thread
// spawns a module worker and exposes signals for status/progress/logs/pdf

import { createSignal, batch } from "solid-js";
import type { ProjectFiles } from "./project_store";
import type { Diagnostic } from "../worker/protocol";
import { decompress_gzip, parse_synctex, sync_to_pdf, sync_to_code } from "./synctex";
import type { PdfSyncObject, SyncToPdfResult } from "./synctex";

export type CompileMode = "preview" | "full";

export type LogEntry = {
  msg: string;
  cls: string;
  ts: number;
};

export type WorkerStatus = "idle" | "loading" | "compiling" | "success" | "error";

export type CompileRequest = {
  files: ProjectFiles;
  main?: string;
  mode?: CompileMode;
};

const [status, set_status] = createSignal<WorkerStatus>("idle");
const [status_text, set_status_text] = createSignal("Initializing...");
const [progress, set_progress] = createSignal(0);
const [logs, set_logs] = createSignal<LogEntry[]>([]);
const [pdf_url, set_pdf_url] = createSignal<string | null>(null);
const [pdf_bytes, set_pdf_bytes] = createSignal<Uint8Array | null>(null);
const [ready, set_ready] = createSignal(false);
const [compiling, set_compiling] = createSignal(false);
const [last_elapsed, set_last_elapsed] = createSignal<string | null>(null);
const [diagnostics, set_diagnostics] = createSignal<Diagnostic[]>([]);

// synctex state
const [synctex_data, set_synctex_data] = createSignal<PdfSyncObject | null>(null);
const [synctex_text, set_synctex_text] = createSignal<string | null>(null);
const [sync_target, set_sync_target] = createSignal<SyncToPdfResult | null>(null);

// goto request: set by diagnostic clicks or reverse sync, consumed by Editor to jump to file:line
export type GotoRequest = { file: string; line: number } | null;
const [goto_request, set_goto_request] = createSignal<GotoRequest>(null);

function request_goto(file: string, line: number): void {
  set_goto_request({ file, line });
}

let worker: Worker | null = null;
let prev_pdf_url: string | null = null;

// imperative compile-done callbacks -- supports multiple subscribers
const _on_compile_done_cbs: Array<() => void> = [];
function on_compile_done(cb: () => void): () => void {
  _on_compile_done_cbs.push(cb);
  return () => { const i = _on_compile_done_cbs.indexOf(cb); if (i >= 0) _on_compile_done_cbs.splice(i, 1); };
}

// imperative ready callback -- used by App for auto-compile on load
const _on_ready_cbs: Array<() => void> = [];
function on_ready(cb: () => void): () => void {
  _on_ready_cbs.push(cb);
  return () => {
    const i = _on_ready_cbs.indexOf(cb);
    if (i >= 0) _on_ready_cbs.splice(i, 1);
  };
}

// detect ?debug=1 query param for debug mode passthrough to worker
const _debug = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

function append_log(msg: string, cls: string = "") {
  const entry: LogEntry = { msg, cls, ts: Date.now() };
  set_logs((prev) => [...prev, entry]);
}

function clear_logs() {
  set_logs([]);
}

type CompleteMessage = {
  pdf: Uint8Array | null;
  synctex: Uint8Array | null;
  elapsed?: number;
};

async function handle_complete(data: CompleteMessage) {
  const pdf_data = data.pdf;
  const synctex_raw = data.synctex;
  if (pdf_data) {
    set_pdf_bytes(new Uint8Array(pdf_data));
    if (prev_pdf_url) URL.revokeObjectURL(prev_pdf_url);
    const blob = new Blob([pdf_data as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    prev_pdf_url = url;
    set_pdf_url(url);
  }

  if (synctex_raw && synctex_raw.length > 0) {
    try {
      const text = await decompress_gzip(synctex_raw);
      const parsed = parse_synctex(text);
      if (parsed) {
        set_synctex_text(text);
        set_synctex_data(parsed);
      }
    } catch {
      append_log("[synctex] failed to parse synchronization data", "log-error");
    }
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
    case "diagnostic":
      set_diagnostics((prev) => [...prev, data.diag as Diagnostic]);
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
      for (const cb of _on_ready_cbs) cb();
      break;
    case "complete": {
      void handle_complete(data as CompleteMessage);
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
  const mode = req.mode ?? "full";
  set_compiling(true);
  set_status("compiling");
  set_status_text(mode === "preview" ? "Previewing..." : "Compiling...");
  set_progress(0);
  set_diagnostics([]);
  worker.postMessage({
    type: "compile",
    files: req.files,
    main: req.main,
    mode,
    debug: _debug,
  });
}

function compile_and_wait(req: CompileRequest): Promise<boolean> {
  if (!worker || !ready() || compiling()) return Promise.resolve(false);

  return new Promise((resolve) => {
    const off = on_compile_done(() => {
      off();
      resolve(status() === "success" && pdf_url() !== null);
    });
    compile(req);
  });
}

// stub: SAB-based cancellation not yet implemented -- falls back to dirty_compiling in watch_controller
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

function restore_pdf_bytes(bytes: Uint8Array) {
  set_pdf_bytes(bytes);
}

function restore_synctex(parsed: PdfSyncObject) {
  set_synctex_data(parsed);
}

function destroy() {
  worker?.terminate();
  worker = null;
  if (prev_pdf_url) URL.revokeObjectURL(prev_pdf_url);
  prev_pdf_url = null;
    _on_compile_done_cbs.length = 0;
  _on_ready_cbs.length = 0;
  batch(() => {
    set_status("idle");
    set_status_text("Initializing...");
    set_progress(0);
    set_logs([]);
    set_pdf_url(null);
    set_pdf_bytes(null);
    set_ready(false);
    set_compiling(false);
    set_last_elapsed(null);
    set_diagnostics([]);
    set_synctex_data(null);
    set_synctex_text(null);
    set_sync_target(null);
    set_goto_request(null);
  });
}

// forward sync: editor cursor -> PDF highlight
function sync_forward(file: string, line: number): void {
  const data = synctex_data();
  if (!data) {
    if (import.meta.env.DEV) console.debug("[synctex:data] sync_forward: synctex_data is null, skipping");
    return;
  }
  if (import.meta.env.DEV) console.debug("[synctex:forward] sync_forward called", { file, line });
  const result = sync_to_pdf(data, file, line);
  if (import.meta.env.DEV) console.debug("[synctex:forward] sync_forward result", result);
  set_sync_target(result);
}

// reverse sync: PDF click -> editor jump
function do_sync_to_code(page: number, x: number, y: number): void {
  const data = synctex_data();
  if (!data) {
    if (import.meta.env.DEV) console.debug("[synctex:data] do_sync_to_code: synctex_data is null, skipping");
    return;
  }
  if (import.meta.env.DEV) console.debug("[synctex:reverse] do_sync_to_code called", { page, x, y });
  const result = sync_to_code(data, page, x, y);
  if (import.meta.env.DEV) console.debug("[synctex:reverse] do_sync_to_code result", result);
  if (result) request_goto(result.file, result.line);
}

export const worker_client = {
  init: init_worker,
  compile,
  compile_and_wait,
  clear_cache,
  clear_logs,
  on_compile_done,
  on_ready,
  restore_pdf_url,
  restore_pdf_bytes,
  restore_synctex,
  destroy,
  request_goto,
  clear_goto: () => set_goto_request(null),
  sync_forward,
  sync_to_code: do_sync_to_code,
  // signals (read-only)
  status,
  status_text,
  progress,
  logs,
  pdf_url,
  pdf_bytes,
  ready,
  compiling,
  last_elapsed,
  diagnostics,
  goto_request,
  synctex_data,
  synctex_text,
  sync_target,
};
