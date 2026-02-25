// worker -> main thread messaging protocol
// all worker-to-UI messages go through these helpers

export type Diagnostic = {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  context?: string; // pipe-indented context lines joined with \n
};

export type WorkerOutMsg =
  | { type: "status"; msg: string; cls: string }
  | { type: "progress"; pct: number }
  | { type: "log"; msg: string; cls: string }
  | { type: "diagnostic"; diag: Diagnostic }
  | { type: "cache_status"; status: string; detail: string }
  | { type: "ready" }
  | { type: "complete"; pdf: Uint8Array | null; synctex: Uint8Array | null; elapsed: string };

export type FileContent = string | Uint8Array;
export type ProjectFiles = Record<string, FileContent>;

export type WorkerInMsg =
  | { type: "init" }
  | { type: "compile"; files: ProjectFiles; main?: string }
  | { type: "clear_cache" };

// debug flag: set via ?debug=1 query param (passed from main thread) or EZTEX_DEBUG env
// workers can't read location.search directly, so main thread passes it via init message,
// or we check for the global flag set by the worker entry point
export let DEBUG = false;

export function set_debug(val: boolean): void {
  DEBUG = val;
}

// debug log: only emits when DEBUG is true. uses console.log for visibility in devtools.
export function dbg(scope: string, msg: string): void {
  if (!DEBUG) return;
  const line = `[dbg:${scope}] ${msg}`;
  console.log(line);
  send_log(line, "log-debug");
}

function send(type: string, data: Record<string, unknown> = {}): void {
  self.postMessage({ type, ...data });
}

export function send_log(msg: string, cls: string = ""): void {
  send("log", { msg, cls });
}

export type LogLevel = "info" | "warn" | "error";

const LEVEL_CLS: Record<LogLevel, string> = { info: "log-info", warn: "log-warn", error: "log-error" };

// structured log: [scope] level: message (info omits level tag for clean output)
export function log(scope: string, level: LogLevel, msg: string): void {
  const prefix = level === "info" ? `[${scope}]` : `[${scope}] ${level}:`;
  send_log(`${prefix} ${msg}`, LEVEL_CLS[level]);
}

export function send_status(msg: string, cls: string = ""): void {
  send("status", { msg, cls });
}

export function send_progress(pct: number): void {
  send("progress", { pct });
}

export function send_cache_status(status: string, detail: string = ""): void {
  send("cache_status", { status, detail });
}

export function send_complete(pdf: Uint8Array | null, synctex: Uint8Array | null, elapsed: string): void {
  const msg = { type: "complete", pdf, synctex, elapsed };
  const transfer: ArrayBuffer[] = [];
  if (pdf) transfer.push(pdf.buffer as ArrayBuffer);
  if (synctex) transfer.push(synctex.buffer as ArrayBuffer);
  self.postMessage(msg, { transfer });
}

export function send_ready(): void {
  send("ready", {});
}

export function format_size(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function send_diagnostic(diag: Diagnostic): void {
  send("diagnostic", { diag });
}
