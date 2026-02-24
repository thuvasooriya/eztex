import { type Component, onMount, onCleanup, createSignal, createEffect, Show } from "solid-js";
import { worker_client } from "./lib/worker_client";
import { create_project_store } from "./lib/project_store";
import { save_project, load_project, load_pdf } from "./lib/project_persist";
import { create_local_folder_sync, type ConflictInfo } from "./lib/local_folder_sync";
import Toolbar from "./components/Toolbar";
import ConflictDialog from "./components/ConflictDialog";

import FilePanel from "./components/FilePanel";
import Editor from "./components/Editor";
import Preview from "./components/Preview";
import StatusPill from "./components/StatusPill";
import ResizeHandle from "./components/ResizeHandle";

const NARROW_BREAKPOINT = 900;
const TOO_NARROW_BREAKPOINT = 600;
const PREVIEW_WIDTH_KEY = "eztex_preview_width";
const SPLIT_DIR_KEY = "eztex_split_dir";

function get_initial_preview_width(): number {
  const stored = localStorage.getItem(PREVIEW_WIDTH_KEY);
  const max_w = window.innerWidth - 400;
  if (stored) {
    const v = parseInt(stored, 10);
    if (!isNaN(v)) return Math.max(200, Math.min(max_w, v));
  }
  const available = window.innerWidth - 200 - 8;
  return Math.max(200, Math.min(max_w, Math.floor(available / 2)));
}

const App: Component = () => {
  const store = create_project_store();
  const folder_sync = create_local_folder_sync(store);

  const [file_panel_width, set_file_panel_width] = createSignal(200);
  const [preview_width, set_preview_width] = createSignal(get_initial_preview_width());
  const [preview_height, set_preview_height] = createSignal(Math.floor((window.innerHeight - 44) / 2));
  const [files_visible, set_files_visible] = createSignal(window.innerWidth >= NARROW_BREAKPOINT);
  const [preview_visible, set_preview_visible] = createSignal(true);
  const [is_narrow, set_is_narrow] = createSignal(window.innerWidth < NARROW_BREAKPOINT);
  const [is_too_narrow, set_is_too_narrow] = createSignal(window.innerWidth <= TOO_NARROW_BREAKPOINT);
  const [show_preview_in_narrow, set_show_preview_in_narrow] = createSignal(false);
  const [split_dir, set_split_dir] = createSignal<"horizontal" | "vertical">(
    (localStorage.getItem(SPLIT_DIR_KEY) as "horizontal" | "vertical") || "horizontal"
  );

  // conflict dialog state
  const [conflicts, set_conflicts] = createSignal<ConflictInfo[]>([]);
  const show_conflicts = () => conflicts().length > 0;

  // reconnect banner state
  const [show_reconnect, set_show_reconnect] = createSignal(false);
  const [reconnect_folder_name, set_reconnect_folder_name] = createSignal("");

  // in narrow mode, file panel is always overlay
  const files_overlay = () => is_narrow() && files_visible();

  // horizontal split in narrow mode requires swap (too narrow for side-by-side)
  const use_swap_mode = () => is_narrow() && split_dir() === "horizontal";

  function toggle_files() {
    set_files_visible((v) => !v);
  }

  function toggle_preview() {
    if (use_swap_mode()) {
      set_show_preview_in_narrow((v) => !v);
    } else {
      set_preview_visible((v) => !v);
    }
  }

  function toggle_split() {
    set_split_dir((d) => {
      const next = d === "horizontal" ? "vertical" : "horizontal";
      localStorage.setItem(SPLIT_DIR_KEY, next);
      return next;
    });
  }

  // handle sync results -- check for conflicts
  async function handle_sync_result(result: Awaited<ReturnType<typeof folder_sync.sync_now>>) {
    if (result.status === "conflict") {
      set_conflicts(result.conflicts);
    }
  }

  onMount(async () => {
    // start engine loading in parallel with OPFS reads
    worker_client.init();

    // wait for both project + PDF restore before registering on_ready
    const [saved, pdf_bytes] = await Promise.all([load_project(), load_pdf()]);

    let pdf_restored = false;
    if (saved && Object.keys(saved).length > 0) {
      store.load_files(saved);
    }
    if (pdf_bytes && pdf_bytes.length > 0) {
      const url = URL.createObjectURL(new Blob([pdf_bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
      worker_client.restore_pdf_url(url);
      pdf_restored = true;
    }

    // auto-compile when engine becomes ready (if no PDF was restored)
    worker_client.on_ready(() => {
      if (!pdf_restored) {
        const files = { ...store.files };
        worker_client.compile({ files, main: store.main_file() });
      }
    });

    // auto-save project on changes (debounced) -- disabled when folder sync is active
    let save_timer: ReturnType<typeof setTimeout> | undefined;
    store.on_change(() => {
      if (folder_sync.state().active) return; // folder sync handles persistence
      if (save_timer !== undefined) clearTimeout(save_timer);
      save_timer = setTimeout(() => {
        save_project(store.files).catch(() => {});
      }, 1000);
    });

    // sync trigger: compile complete
    worker_client.on_compile_done(() => {
      if (folder_sync.state().active && folder_sync.state().dirty_files.size > 0) {
        folder_sync.sync_now().then(handle_sync_result);
      }
    });

    // check for stored folder handle and show reconnect banner
    if (folder_sync.is_supported()) {
      const has_handle = await folder_sync.has_stored_handle();
      if (has_handle) {
        const name = await folder_sync.get_stored_folder_name();
        set_reconnect_folder_name(name ?? "folder");
        set_show_reconnect(true);
      }
    }

    const on_resize = () => {
      const w = window.innerWidth;
      const narrow = w < NARROW_BREAKPOINT;
      set_is_narrow(narrow);
      set_is_too_narrow(w <= TOO_NARROW_BREAKPOINT);
      if (!narrow) {
        set_show_preview_in_narrow(false);
      }
    };
    window.addEventListener("resize", on_resize);
    onCleanup(() => window.removeEventListener("resize", on_resize));

    document.addEventListener("keydown", handle_keydown);
    onCleanup(() => document.removeEventListener("keydown", handle_keydown));
  });

  function handle_keydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      toggle_files();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "p") {
      e.preventDefault();
      toggle_preview();
    }
    // Cmd+S / Ctrl+S: trigger folder sync for current file
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (folder_sync.state().active) {
        folder_sync.sync_now().then(handle_sync_result);
      }
    }
  }

  // sync trigger: file switch -- sync the file being switched away from
  let prev_file = store.current_file();
  createEffect(() => {
    const current = store.current_file();
    if (current !== prev_file && folder_sync.state().active) {
      const file_to_sync = prev_file;
      if (folder_sync.state().dirty_files.has(file_to_sync)) {
        folder_sync.sync_file(file_to_sync).then(handle_sync_result);
      }
    }
    prev_file = current;
  });

  // when a diagnostic goto is requested, switch to the target file first
  createEffect(() => {
    const req = worker_client.goto_request();
    if (!req) return;
    if (req.file !== store.current_file()) {
      store.set_current_file(req.file);
    }
  });

  function handle_file_resize(delta: number) {
    set_file_panel_width((w) => Math.max(140, Math.min(400, w + delta)));
  }

  function handle_preview_resize(delta: number) {
    if (split_dir() === "vertical") {
      set_preview_height((h) => Math.max(100, Math.min(window.innerHeight - 200, h - delta)));
    } else {
      set_preview_width((w) => {
        const next = Math.max(250, Math.min(900, w - delta));
        localStorage.setItem(PREVIEW_WIDTH_KEY, String(next));
        return next;
      });
    }
  }

  const workspace_class = () => {
    let cls = "workspace";
    if (is_narrow()) cls += " narrow-mode";
    if (use_swap_mode() && show_preview_in_narrow()) cls += " show-preview";
    cls += ` split-${split_dir()}`;
    return cls;
  };

  async function handle_reconnect() {
    set_show_reconnect(false);
    await folder_sync.reconnect();
  }

  function dismiss_reconnect() {
    set_show_reconnect(false);
  }

  return (
    <div class="app">
      <Toolbar
        store={store}
        on_toggle_files={toggle_files}
        on_toggle_preview={toggle_preview}
        on_toggle_split={toggle_split}
        files_visible={files_visible()}
        preview_visible={use_swap_mode() ? show_preview_in_narrow() : preview_visible()}
        split_dir={split_dir()}
        swap_mode={use_swap_mode()}
        folder_sync={folder_sync}
        on_upload_conflicts={(c) => set_conflicts(c)}
      />

      {/* reconnect banner */}
      <Show when={show_reconnect()}>
        <div class="reconnect-banner">
          <span>Reconnect to <strong>{reconnect_folder_name()}/</strong>?</span>
          <button class="reconnect-btn" onClick={handle_reconnect}>Reconnect</button>
          <button class="reconnect-dismiss" onClick={dismiss_reconnect}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </Show>

      <div class={workspace_class()}>
        {/* file panel: inline in wide mode */}
        <Show when={files_visible() && !is_narrow()}>
          <div
            class="file-panel-wrapper panel-wrapper panel-box"
            style={{ width: `${file_panel_width()}px`, "flex-shrink": 0 }}
          >
            <FilePanel store={store} />
          </div>
          <ResizeHandle
            direction="horizontal"
            on_resize={handle_file_resize}
          />
        </Show>

        <div class={`split-container split-${split_dir()}`}>
          <div class="editor-wrapper panel-box">
            <Editor store={store} />
          </div>

          {/* Wide mode OR narrow+vertical stacked: show preview with resize handle */}
          <Show when={!use_swap_mode() && preview_visible()}>
            <ResizeHandle
              direction={split_dir() === "vertical" ? "vertical" : "horizontal"}
              on_resize={handle_preview_resize}
            />
            <div
              class="preview-wrapper panel-wrapper panel-box"
              style={split_dir() === "vertical"
                ? { height: `${preview_height()}px`, "flex-shrink": 0 }
                : { width: `${preview_width()}px`, "flex-shrink": 0 }
              }
            >
              <Preview />
            </div>
          </Show>

          {/* Narrow swap mode (side-by-side/horizontal in narrow): full swap */}
          <Show when={use_swap_mode() && show_preview_in_narrow()}>
            <div class="preview-wrapper panel-wrapper panel-box" style={{ flex: 1 }}>
              <Preview />
            </div>
          </Show>
        </div>
      </div>

      {/* file panel overlay for narrow screens */}
      <Show when={files_overlay()}>
        <div class="file-panel-wrapper overlay-mode panel-wrapper panel-box">
          <FilePanel store={store} />
        </div>
      </Show>

      <Show when={is_too_narrow()}>
        <div class="too-narrow-overlay">
          <div class="too-narrow-content">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" stroke-linecap="round" />
            </svg>
            <p>Screen too narrow</p>
            <p class="too-narrow-hint">Please resize your window or rotate your device.</p>
          </div>
        </div>
      </Show>

      {/* conflict resolution dialog */}
      <Show when={show_conflicts()}>
        <ConflictDialog
          conflicts={conflicts()}
          on_resolve={(path, resolution) => {
            const conflict = conflicts().find(c => c.path === path);
            const is_upload = conflict && !conflict.eztex_hash && !conflict.disk_hash;
            if (is_upload) {
              if (resolution === "disk" && conflict) {
                store.update_content(path, conflict.disk_content);
              }
            } else {
              folder_sync.resolve_conflict(path, resolution);
            }
            set_conflicts(prev => prev.filter(c => c.path !== path));
          }}
          on_resolve_merged={(path, content) => {
            const conflict = conflicts().find(c => c.path === path);
            const is_upload = conflict && !conflict.eztex_hash && !conflict.disk_hash;
            if (is_upload) {
              store.update_content(path, content);
            } else {
              folder_sync.resolve_conflict_with_content(path, content);
            }
            set_conflicts(prev => prev.filter(c => c.path !== path));
          }}
          on_close={() => set_conflicts([])}
        />
      </Show>

      <StatusPill store={store} />
    </div>
  );
};

export default App;
