// watch controller -- state machine for auto-compile scheduling
// decoupled from SolidJS reactivity to avoid spurious triggers

import { createSignal } from "solid-js";

export type WatchState = "idle" | "scheduled" | "compiling" | "dirty_compiling";

export type CompileRequest = {
  files: Record<string, string>;
  main: string;
};

type WatchDeps = {
  get_files: () => Record<string, string>;
  get_main: () => string;
  is_ready: () => boolean;
  compile: (req: CompileRequest) => void;
};

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 2000;
const DIRTY_DEBOUNCE_MS = 200;

// FNV-1a hash of all project files (name + content, sorted by key)
// ~1GB/s in JS -- negligible for typical LaTeX projects
function hash_files(files: Record<string, string>): number {
  let h = 0x811c9dc5;
  const keys = Object.keys(files).sort();
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const val = files[key];
    for (let i = 0; i < val.length; i++) {
      h ^= val.charCodeAt(i);
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
    set_state("compiling");
    set_dirty(false);
    deps.compile({ files: { ...files }, main: deps.get_main() });
  }

  // called by project_store on any content/structure change
  function notify_change() {
    if (!enabled()) return;
    const current = state();

    if (current === "compiling") {
      set_state("dirty_compiling");
      set_dirty(true);
      return;
    }

    if (current === "dirty_compiling") {
      // already marked dirty, will re-schedule after compile
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
