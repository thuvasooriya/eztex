import { createSignal } from "solid-js";
import type { ProjectFiles } from "./project_store";
import type { CompileMode } from "./worker_client";
import { get_setting, set_setting } from "./settings_store";
import { fnv1a_hash_sync } from "./crypto_utils";

export type WatchState = "idle" | "scheduled" | "compiling" | "dirty_compiling";

export type CompileRequest = {
  files: ProjectFiles;
  main: string;
  mode: CompileMode;
};

type CompileSchedulerDeps = {
  get_files: () => ProjectFiles;
  get_main: () => string;
  is_ready: () => boolean;
  compile: (req: CompileRequest) => void;
  get_permission: () => string | null;
  project_id: () => string | undefined;
};

export type CompileStatus =
  | { kind: "idle" }
  | { kind: "debouncing"; ms_remaining: number }
  | { kind: "compiling"; mode: CompileMode }
  | { kind: "waiting_for_tab"; reason: string }
  | { kind: "readonly"; reason: string };

const DEBOUNCE_MS = 800;
const MAX_DEBOUNCE_MS = 3000;
const RATE_LIMIT_MS = 3000;
const DIRTY_DEBOUNCE_MS = 200;

function deep_clone_files(files: ProjectFiles): ProjectFiles {
  const result: ProjectFiles = {};
  for (const [path, content] of Object.entries(files)) {
    result[path] = content instanceof Uint8Array ? new Uint8Array(content) : content;
  }
  return result;
}

function hash_files(files: ProjectFiles): string {
  let input = "";
  const keys = Object.keys(files).sort();
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    input += `p:${key.length}:${key};`;
    const val = files[key];
    if (typeof val === "string") {
      input += `s:${val.length}:${val};`;
    } else {
      input += `b:${val.byteLength};`;
    }
  }
  return fnv1a_hash_sync(input);
}

function has_significant_change(prev: ProjectFiles, curr: ProjectFiles): boolean {
  const prev_keys = new Set(Object.keys(prev));
  const curr_keys = new Set(Object.keys(curr));
  for (const k of curr_keys) {
    if (!prev_keys.has(k)) return true;
  }
  for (const k of prev_keys) {
    if (!curr_keys.has(k)) return true;
  }
  for (const k of curr_keys) {
    const old_val = prev[k];
    const new_val = curr[k];
    if (typeof old_val !== typeof new_val) return true;
    if (new_val instanceof Uint8Array) {
      if (!(old_val instanceof Uint8Array)) return true;
      if (old_val.byteLength !== new_val.byteLength) return true;
      for (let i = 0; i < new_val.byteLength; i++) {
        if (old_val[i] !== new_val[i]) return true;
      }
      continue;
    }
    if (typeof old_val === "string" && typeof new_val === "string") {
      if (old_val === new_val) continue;
      if (k.endsWith(".tex")) return true;
      const trimmed_old = old_val.trim();
      const trimmed_new = new_val.trim();
      if (trimmed_old !== trimmed_new) return true;
    }
  }
  return false;
}

type CompileBCMessage = {
  type: "compile-requested" | "compile-done" | "compile-failed";
  tab_id: string;
  timestamp: number;
  content_hash: string;
};

export function create_compile_scheduler(deps: CompileSchedulerDeps) {
  const [state, set_state] = createSignal<WatchState>("idle");
  const [enabled, set_enabled] = createSignal(get_setting("auto_compile"));
  const [dirty, set_dirty] = createSignal(false);

  let debounce_timer: ReturnType<typeof setTimeout> | undefined;
  let max_wait_timer: ReturnType<typeof setTimeout> | undefined;
  let last_compiled_hash = "";
  let pre_compile_hash = "";
  let last_compile_ended_at: number = 0;
  let needs_seed = enabled();

  const tab_id = crypto.randomUUID();
  let compile_bc: BroadcastChannel | null = null;
  let other_tab_compiling = false;

  function setup_compile_bc() {
    teardown_compile_bc();
    const pid = deps.project_id();
    if (!pid) return;
    compile_bc = new BroadcastChannel(`eztex.compile.${pid}`);
    compile_bc.onmessage = (e: MessageEvent) => {
      const msg = e.data as CompileBCMessage | undefined;
      if (!msg || msg.tab_id === tab_id) return;
      if (msg.type === "compile-requested") {
        other_tab_compiling = true;
        if (state() === "scheduled") {
          clear_timers();
          set_state("idle");
          set_dirty(false);
        }
      } else if (msg.type === "compile-done" || msg.type === "compile-failed") {
        other_tab_compiling = false;
        if (dirty() && enabled()) {
          schedule_debounce(DIRTY_DEBOUNCE_MS);
        }
      }
    };
  }

  function teardown_compile_bc() {
    if (compile_bc) {
      compile_bc.close();
      compile_bc = null;
    }
    other_tab_compiling = false;
  }

  function broadcast_compile_requested(h: string) {
    if (!compile_bc) return;
    compile_bc.postMessage({
      type: "compile-requested",
      tab_id,
      timestamp: Date.now(),
      content_hash: h,
    } satisfies CompileBCMessage);
  }

  function broadcast_compile_done() {
    if (!compile_bc) return;
    compile_bc.postMessage({
      type: "compile-done",
      tab_id,
      timestamp: Date.now(),
      content_hash: pre_compile_hash,
    } satisfies CompileBCMessage);
  }

  function clear_timers() {
    if (debounce_timer !== undefined) { clearTimeout(debounce_timer); debounce_timer = undefined; }
    if (max_wait_timer !== undefined) { clearTimeout(max_wait_timer); max_wait_timer = undefined; }
  }

  function schedule_debounce(ms: number) {
    clear_timers();
    set_state("scheduled");
    set_dirty(true);
    debounce_timer = setTimeout(fire_compile, ms);
    if (max_wait_timer === undefined) {
      max_wait_timer = setTimeout(fire_compile, MAX_DEBOUNCE_MS);
    }
  }

  function fire_compile() {
    clear_timers();
    if (!deps.is_ready()) {
      set_state("idle");
      set_dirty(false);
      return;
    }

    const perm = deps.get_permission();
    if (perm === "read") {
      set_state("idle");
      set_dirty(false);
      return;
    }

    if (other_tab_compiling) {
      set_state("idle");
      set_dirty(true);
      return;
    }

    const now = Date.now();
    const since_last = now - last_compile_ended_at;
    if (since_last < RATE_LIMIT_MS) {
      const wait = RATE_LIMIT_MS - since_last;
      debounce_timer = setTimeout(fire_compile, wait);
      return;
    }

    const files = deps.get_files();
    const h = hash_files(files);

    if (h === last_compiled_hash) {
      set_state("idle");
      set_dirty(false);
      return;
    }

    if (!has_significant_change(last_compiled_files, files)) {
      set_state("idle");
      set_dirty(false);
      last_compiled_hash = h;
      return;
    }

    pre_compile_hash = h;
    set_state("compiling");
    set_dirty(false);
    broadcast_compile_requested(h);
    deps.compile({ files: { ...files }, main: deps.get_main(), mode: "preview" });
  }

  let last_compiled_files: ProjectFiles = {};

  function seed_current_files() {
    needs_seed = false;
    const files = deps.get_files();
    last_compiled_hash = hash_files(files);
    last_compiled_files = deep_clone_files(files);
  }

  function notify_change() {
    if (!enabled()) return;

    if (needs_seed) {
      seed_current_files();
      return;
    }

    const perm = deps.get_permission();
    if (perm === "read") return;

    const current = state();

    if (current === "compiling" || current === "dirty_compiling") {
      set_state("dirty_compiling");
      set_dirty(true);
      return;
    }

    if (other_tab_compiling) {
      set_dirty(true);
      return;
    }

    schedule_debounce(DEBOUNCE_MS);
  }

  function notify_compile_done(success: boolean) {
    last_compile_ended_at = Date.now();
    if (success) {
      last_compiled_hash = pre_compile_hash;
      last_compiled_files = deep_clone_files(deps.get_files());
    }
    const was_dirty = state() === "dirty_compiling";
    set_state("idle");

    if (success) {
      broadcast_compile_done();
    } else if (compile_bc) {
      compile_bc.postMessage({
        type: "compile-failed",
        tab_id,
        timestamp: Date.now(),
        content_hash: pre_compile_hash,
      } satisfies CompileBCMessage);
    }

    if (was_dirty && enabled()) {
      schedule_debounce(DIRTY_DEBOUNCE_MS);
    }
  }

  function request_compile(files: ProjectFiles, main: string, mode: CompileMode) {
    const perm = deps.get_permission();
    if (perm === "read") return;

    clear_timers();

    const h = hash_files(files);
    pre_compile_hash = h;
    set_state("compiling");
    set_dirty(false);
    broadcast_compile_requested(h);
    deps.compile({ files: { ...files }, main, mode });
  }

  function toggle(on?: boolean) {
    const next = on !== undefined ? on : !enabled();
    needs_seed = false;
    if (next && !enabled()) {
      const files = deps.get_files();
      last_compiled_hash = hash_files(files);
      last_compiled_files = deep_clone_files(files);
    }
    if (!next) {
      clear_timers();
      set_state("idle");
      set_dirty(false);
    }
    set_enabled(next);
    set_setting("auto_compile", next);
  }

  function status(): CompileStatus {
    const perm = deps.get_permission();
    if (perm === "read") return { kind: "readonly", reason: "Collaboration read-only mode" };

    const s = state();
    if (s === "idle") return { kind: "idle" };
    if (s === "compiling") return { kind: "compiling", mode: "preview" };
    if (s === "scheduled") return { kind: "debouncing", ms_remaining: DEBOUNCE_MS };
    if (s === "dirty_compiling") return { kind: "compiling", mode: "preview" };
    if (other_tab_compiling) return { kind: "waiting_for_tab", reason: "Another tab is compiling" };
    return { kind: "idle" };
  }

  function destroy() {
    clear_timers();
    teardown_compile_bc();
  }

  function set_project_id(pid: string) {
    if (pid) {
      setup_compile_bc();
    } else {
      teardown_compile_bc();
    }
  }

  return {
    state,
    enabled,
    dirty,
    toggle,
    notify_change,
    notify_compile_done,
    request_compile,
    seed_current_files,
    status,
    destroy,
    set_project_id,
  };
}

export type CompileScheduler = ReturnType<typeof create_compile_scheduler>;
