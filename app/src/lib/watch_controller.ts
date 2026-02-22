// watch controller -- state machine for auto-compile scheduling
// decoupled from SolidJS reactivity to avoid spurious triggers
//
// cancel support: when a compile has been running longer than CANCEL_THRESHOLD_MS
// and the user makes changes, we cancel via worker_client.cancel_and_recompile()
// which swaps to a pre-initialized standby worker for instant responsiveness.

import { createSignal } from "solid-js";
import type { ProjectFiles } from "./project_store";

export type WatchState = "idle" | "scheduled" | "compiling" | "dirty_compiling";

export type CompileRequest = {
  files: ProjectFiles;
  main: string;
};

type WatchDeps = {
  get_files: () => ProjectFiles;
  get_main: () => string;
  is_ready: () => boolean;
  compile: (req: CompileRequest) => void;
  cancel_and_recompile?: (req: CompileRequest) => boolean;
};

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 2000;
const DIRTY_DEBOUNCE_MS = 200;
// minimum compile duration before we consider cancelling (avoid churn on fast compiles)
const CANCEL_THRESHOLD_MS = 3000;

// FNV-1a hash of all project files (name + content, sorted by key)
// ~1GB/s in JS -- negligible for typical LaTeX projects
function hash_files(files: ProjectFiles): number {
  let h = 0x811c9dc5;
  const keys = Object.keys(files).sort();
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const val = files[key];
    if (typeof val === "string") {
      for (let i = 0; i < val.length; i++) {
        h ^= val.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    } else {
      // Uint8Array: hash byteLength as proxy (avoid byte-by-byte for large binaries)
      h ^= val.byteLength;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

export function create_watch_controller(deps: WatchDeps) {
  const [state, set_state] = createSignal<WatchState>("idle");
  const [enabled, set_enabled] = createSignal(false);
  const [dirty, set_dirty] = createSignal(false);

  let debounce_timer: ReturnType<typeof setTimeout> | undefined;
  let max_wait_timer: ReturnType<typeof setTimeout> | undefined;
  let last_compiled_hash: number = 0;
  let pre_compile_hash: number = 0;
  let compile_started_at: number = 0;

  function clear_timers() {
    if (debounce_timer !== undefined) { clearTimeout(debounce_timer); debounce_timer = undefined; }
    if (max_wait_timer !== undefined) { clearTimeout(max_wait_timer); max_wait_timer = undefined; }
  }

  function fire_compile() {
    clear_timers();
    if (!deps.is_ready()) {
      set_state("idle");
      return;
    }

    const files = deps.get_files();
    const h = hash_files(files);

    if (h === last_compiled_hash) {
      set_state("idle");
      set_dirty(false);
      return;
    }

    pre_compile_hash = h;
    compile_started_at = performance.now();
    set_state("compiling");
    set_dirty(false);
    deps.compile({ files: { ...files }, main: deps.get_main() });
  }

  // attempt to cancel the running compile and immediately start a new one.
  // returns true if cancel succeeded (standby was ready), false otherwise.
  function try_cancel_and_recompile(): boolean {
    if (!deps.cancel_and_recompile) return false;

    const files = deps.get_files();
    const h = hash_files(files);
    if (h === last_compiled_hash) {
      // content hasn't actually changed from last successful compile
      return false;
    }

    const req: CompileRequest = { files: { ...files }, main: deps.get_main() };
    const swapped = deps.cancel_and_recompile(req);
    if (swapped) {
      pre_compile_hash = h;
      compile_started_at = performance.now();
      set_state("compiling");
      set_dirty(false);
      return true;
    }
    return false;
  }

  // called by project_store on any content/structure change
  function notify_change() {
    if (!enabled()) return;
    const current = state();

    if (current === "compiling" || current === "dirty_compiling") {
      const elapsed = performance.now() - compile_started_at;
      if (elapsed >= CANCEL_THRESHOLD_MS) {
        // compile has been running long enough -- try to cancel and recompile
        if (try_cancel_and_recompile()) {
          // successfully swapped to standby and fired new compile
          return;
        }
      }
      // either too early to cancel, or standby not ready -- mark dirty and wait
      set_state("dirty_compiling");
      set_dirty(true);
      return;
    }

    // idle or scheduled: (re)start debounce
    set_state("scheduled");
    set_dirty(true);

    if (debounce_timer !== undefined) clearTimeout(debounce_timer);
    debounce_timer = setTimeout(fire_compile, DEBOUNCE_MS);

    // max wait: guarantee compile within MAX_WAIT_MS of first change in this burst
    if (max_wait_timer === undefined) {
      max_wait_timer = setTimeout(fire_compile, MAX_WAIT_MS);
    }
  }

  // called by worker_client on compile completion (imperative callback, not reactive)
  function notify_compile_done() {
    last_compiled_hash = pre_compile_hash;
    const was_dirty = state() === "dirty_compiling";
    set_state("idle");

    if (was_dirty && enabled()) {
      set_state("scheduled");
      debounce_timer = setTimeout(fire_compile, DIRTY_DEBOUNCE_MS);
    }
  }

  // toggle watch -- seed hash so enabling doesn't spuriously compile unchanged content
  function toggle(on?: boolean) {
    const next = on !== undefined ? on : !enabled();
    if (next && !enabled()) {
      // seeding hash on enable prevents compile of unchanged content
      last_compiled_hash = hash_files(deps.get_files());
    }
    if (!next) {
      clear_timers();
      set_state("idle");
      set_dirty(false);
    }
    set_enabled(next);
  }

  function cleanup() {
    clear_timers();
  }

  return {
    state,
    enabled,
    dirty,
    toggle,
    notify_change,
    notify_compile_done,
    cleanup,
  };
}

export type WatchController = ReturnType<typeof create_watch_controller>;
