import { type Component, onMount, onCleanup, createSignal, Show } from "solid-js";
import { worker_client } from "./lib/worker_client";
import { create_project_store } from "./lib/project_store";
import { save_project, load_project, load_pdf } from "./lib/project_persist";
import Toolbar from "./components/Toolbar";

import FilePanel from "./components/FilePanel";
import Editor from "./components/Editor";
import Preview from "./components/Preview";
import StatusPill from "./components/StatusPill";
import CachePill from "./components/CachePill";
import ResizeHandle from "./components/ResizeHandle";

const NARROW_BREAKPOINT = 900;
const PREVIEW_WIDTH_KEY = "eztex_preview_width";

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

  const [file_panel_width, set_file_panel_width] = createSignal(200);
  const [preview_width, set_preview_width] = createSignal(get_initial_preview_width());
  const [files_visible, set_files_visible] = createSignal(true);
  const [preview_visible, set_preview_visible] = createSignal(true);
  const [is_narrow, set_is_narrow] = createSignal(window.innerWidth < NARROW_BREAKPOINT);
  const [show_preview_in_narrow, set_show_preview_in_narrow] = createSignal(false);

  // in narrow mode, file panel is always overlay
  const files_overlay = () => is_narrow() && files_visible();

  function toggle_files() {
    set_files_visible((v) => !v);
  }

  function toggle_preview() {
    if (is_narrow()) {
      set_show_preview_in_narrow((v) => !v);
    } else {
      set_preview_visible((v) => !v);
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

    // auto-save project on changes (debounced)
    let save_timer: ReturnType<typeof setTimeout> | undefined;
    store.on_change(() => {
      if (save_timer !== undefined) clearTimeout(save_timer);
      save_timer = setTimeout(() => {
        save_project(store.files).catch(() => {});
      }, 1000);
    });

    const on_resize = () => {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      set_is_narrow(narrow);
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
  }

  function handle_file_resize(delta: number) {
    set_file_panel_width((w) => Math.max(140, Math.min(400, w + delta)));
  }

  function handle_preview_resize(delta: number) {
    set_preview_width((w) => {
      const next = Math.max(250, Math.min(900, w - delta));
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(next));
      return next;
    });
  }

  const workspace_class = () => {
    let cls = "workspace";
    if (is_narrow()) cls += " narrow-mode";
    if (show_preview_in_narrow()) cls += " show-preview";
    return cls;
  };

  return (
    <div class="app">
      <Toolbar
        store={store}
        on_toggle_files={toggle_files}
        on_toggle_preview={toggle_preview}
        files_visible={files_visible()}
        preview_visible={is_narrow() ? show_preview_in_narrow() : preview_visible()}
      />
      <div class={workspace_class()}>
        {/* file panel: overlay in narrow, inline in wide */}
        <Show when={files_visible() && !is_narrow()}>
          <div
            class="file-panel-wrapper panel-wrapper"
            style={{ width: `${file_panel_width()}px`, "flex-shrink": 0 }}
          >
            <FilePanel store={store} />
          </div>
          <ResizeHandle
            direction="horizontal"
            on_resize={handle_file_resize}
          />
        </Show>

        <div class="editor-wrapper">
          <Editor store={store} />
        </div>

        <Show when={!is_narrow() && preview_visible()}>
          <ResizeHandle
            direction="horizontal"
            on_resize={handle_preview_resize}
          />
          <div
            class="preview-wrapper panel-wrapper"
            style={{ width: `${preview_width()}px`, "flex-shrink": 0 }}
          >
            <Preview />
          </div>
        </Show>

        {/* narrow mode: full-width preview replaces editor */}
        <Show when={is_narrow() && show_preview_in_narrow()}>
          <div class="preview-wrapper panel-wrapper" style={{ flex: 1 }}>
            <Preview />
          </div>
        </Show>
      </div>

      {/* file panel overlay for narrow screens */}
      <Show when={files_overlay()}>
        <div class="file-panel-overlay" onClick={() => set_files_visible(false)} />
        <div class="file-panel-wrapper overlay-mode">
          <FilePanel store={store} />
        </div>
      </Show>

      <CachePill store={store} />
      <StatusPill />
    </div>
  );
};

export default App;
