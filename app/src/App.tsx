import { type Component, onMount, onCleanup, createSignal, createEffect, Show } from "solid-js";
import AnimatedShow from "./components/AnimatedShow";
import { worker_client } from "./lib/worker_client";
import { parse_synctex } from "./lib/synctex";
import { create_project_store } from "./lib/project_store";
import {
  load_project,
  load_pdf,
  load_synctex,
  load_catalog,
  load_ydoc_snapshot,
  migrate_v1_default_project,
  save_ydoc_project,
  save_project,
  create_fresh_project,
} from "./lib/project_persist";
import { get_project, set_current_project } from "./lib/project_manager";
import { parse_collab_url, get_owned_room } from "./lib/collab_share";
import { create_collab_provider, type CollabProvider, type CollabStatus, type CollabPermission } from "./lib/collab_provider";
import { get_or_create_identity } from "./lib/identity";
import { create_local_folder_sync, type ConflictInfo } from "./lib/local_folder_sync";
import { create_watch_controller } from "./lib/watch_controller";
import { get_all_commands, IS_MAC } from "./lib/commands";
import { init_commands } from "./lib/register_commands";
import { create_agent_review_store, type AgentReviewStore } from "./lib/agent_review";
import Toolbar from "./components/Toolbar";
import CommandPalette from "./components/CommandPalette";
import ConflictDialog from "./components/ConflictDialog";
import AgentPanel from "./components/AgentPanel";

import FilePanel from "./components/FilePanel";
import Editor from "./components/Editor";
import Preview from "./components/Preview";
import DiagnosticPill from "./components/DiagnosticPill";
import ResizeHandle from "./components/ResizeHandle";
import Onboarding, { is_onboarded } from "./components/Onboarding";

const NARROW_BREAKPOINT = 900;
const TOO_NARROW_BREAKPOINT = 600;
const PREVIEW_WIDTH_KEY = "eztex_preview_width";
const SPLIT_DIR_KEY = "eztex_split_dir";
const FILES_VISIBLE_KEY = "eztex_files_visible";
const PREVIEW_VISIBLE_KEY = "eztex_preview_visible";
const VIM_ENABLED_KEY = "eztex_vim_enabled";

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
  const [files_visible, set_files_visible] = createSignal(
    window.innerWidth >= NARROW_BREAKPOINT && localStorage.getItem(FILES_VISIBLE_KEY) !== "false"
  );
  const [preview_visible, set_preview_visible] = createSignal(
    localStorage.getItem(PREVIEW_VISIBLE_KEY) !== "false"
  );
  const [is_narrow, set_is_narrow] = createSignal(window.innerWidth < NARROW_BREAKPOINT);
  const [is_too_narrow, set_is_too_narrow] = createSignal(window.innerWidth <= TOO_NARROW_BREAKPOINT);
  const [show_preview_in_narrow, set_show_preview_in_narrow] = createSignal(false);
  const [split_dir, set_split_dir] = createSignal<"horizontal" | "vertical">(
    (localStorage.getItem(SPLIT_DIR_KEY) as "horizontal" | "vertical") || "horizontal"
  );
  const [is_resizing, set_is_resizing] = createSignal(false);
  const [layout_switching, set_layout_switching] = createSignal(false);

  createEffect(() => localStorage.setItem(FILES_VISIBLE_KEY, String(files_visible())));
  createEffect(() => localStorage.setItem(PREVIEW_VISIBLE_KEY, String(preview_visible())));

  const [show_onboarding, set_show_onboarding] = createSignal(!is_onboarded());
  const [project_ready, set_project_ready] = createSignal(false);

  const [show_logs, set_show_logs] = createSignal(false);
  const [show_info_modal, set_show_info_modal] = createSignal(false);

  const [vim_enabled, set_vim_enabled] = createSignal(localStorage.getItem(VIM_ENABLED_KEY) === "true");
  createEffect(() => localStorage.setItem(VIM_ENABLED_KEY, String(vim_enabled())));

  const [_collab_status, set_collab_status] = createSignal<CollabStatus>("idle");
  const [collab_permission, set_collab_permission] = createSignal<CollabPermission | null>(null);
  const [_collab_peer_count, set_collab_peer_count] = createSignal(0);
  const [read_only, set_read_only] = createSignal(false);
  createEffect(() => set_read_only(collab_permission() === "read"));

  let _collab_provider: CollabProvider | null = null;

  const agent_review_store: AgentReviewStore = create_agent_review_store();
  const [show_agent_panel, set_show_agent_panel] = createSignal(false);

  let _editor_view: any = undefined;
  function set_editor_view_ref(v: any) { _editor_view = v; }
  function get_editor_view() { return _editor_view; }

  let _trigger_file_upload = () => {};
  let _trigger_folder_upload = () => {};
  let _trigger_zip_upload = () => {};

  const watch = create_watch_controller({
    get_files: () => store.files,
    get_main: () => store.main_file(),
    is_ready: () => worker_client.ready() && !worker_client.compiling(),
    compile: (req) => worker_client.compile(req),
    cancel_and_recompile: (req) => worker_client.cancel_and_recompile(req),
  });
  store.on_change(() => watch.notify_change());
  worker_client.on_compile_done(() => watch.notify_compile_done());
  onCleanup(() => watch.cleanup());

  const [conflicts, set_conflicts] = createSignal<ConflictInfo[]>([]);
  const show_conflicts = () => conflicts().length > 0;

  const [show_reconnect, set_show_reconnect] = createSignal(false);
  const [reconnect_folder_name, set_reconnect_folder_name] = createSignal("");

  const files_overlay = () => is_narrow() && files_visible();
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
    set_layout_switching(true);
    setTimeout(() => {
      set_split_dir((d) => {
        const next = d === "horizontal" ? "vertical" : "horizontal";
        localStorage.setItem(SPLIT_DIR_KEY, next);
        return next;
      });
      setTimeout(() => set_layout_switching(false), 100);
    }, 100);
  }

  async function handle_sync_result(result: Awaited<ReturnType<typeof folder_sync.sync_now>>) {
    if (result.status === "conflict") {
      set_conflicts(result.conflicts);
    }
  }

  init_commands({
    store,
    folder_sync,
    watch,
    files_visible,
    set_files_visible,
    preview_visible,
    set_preview_visible,
    split_dir,
    toggle_split,
    toggle_preview,
    show_logs,
    set_show_logs,
    set_show_info_modal,
    set_show_onboarding,
    get_editor_view,
    set_vim_enabled,
    vim_enabled,
    trigger_file_upload: () => _trigger_file_upload(),
    trigger_folder_upload: () => _trigger_folder_upload(),
    trigger_zip_upload: () => _trigger_zip_upload(),
    agent_review_store,
    set_show_agent_panel,
    on_copy_agent_write_link: handle_copy_agent_write_link,
  });

  let _cleanup_resize: (() => void) | null = null;
  let _cleanup_keydown: (() => void) | null = null;
  onCleanup(() => {
    _cleanup_resize?.();
    _cleanup_keydown?.();
    _collab_provider?.destroy();
    _collab_provider = null;
  });

  onMount(async () => {
    worker_client.init();

    let project_id: string | null = null;
    const url_params = new URLSearchParams(window.location.search);
    const url_project_id = url_params.get("project");

    if (url_project_id) {
      const exists = await get_project(url_project_id);
      if (exists) {
        project_id = url_project_id;
        await set_current_project(project_id);
      }
    }

    if (!project_id) {
      try {
        const catalog = await load_catalog();
        if (catalog.current_project_id) {
          project_id = catalog.current_project_id;
        } else {
          project_id = await migrate_v1_default_project();
        }
      } catch {}
    }

    if (!project_id) {
      project_id = await create_fresh_project();
    }

    store.init(project_id);
    worker_client.set_project_id(project_id);

    let loaded_from_snapshot = false;
    const snapshot = await load_ydoc_snapshot(project_id);
    if (snapshot && snapshot.length > 0) {
      store.apply_ydoc_snapshot(snapshot);
      loaded_from_snapshot = true;
    }

    const [pdf_bytes, synctex_text] = await Promise.all([
      load_pdf(project_id),
      load_synctex(project_id),
    ]);

    let pdf_restored = false;
    if (!loaded_from_snapshot) {
      const saved = await load_project();
      if (saved && Object.keys(saved.files).length > 0) {
        store.load_files(saved.files);
        if (saved.main_file && saved.main_file in saved.files) {
          store.set_main_file(saved.main_file);
          store.set_current_file(saved.main_file);
        }
      } else {
        await store.init_from_template();
      }
    } else {
      await store.load_persisted_blobs();
    }

    if (pdf_bytes && pdf_bytes.length > 0) {
      const url = URL.createObjectURL(new Blob([pdf_bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
      worker_client.restore_pdf_url(url);
      worker_client.restore_pdf_bytes(new Uint8Array(pdf_bytes));
      pdf_restored = true;
    }
    if (synctex_text) {
      const parsed = parse_synctex(synctex_text);
      if (parsed) {
        worker_client.restore_synctex(parsed);
      }
    }

    // initialize collaboration if room detected
    const collab_url = parse_collab_url(new URL(window.location.href));
    let room_id = store.room_id();
    let token: string | null = null;

    if (collab_url) {
      room_id = collab_url.room_id;
      token = collab_url.token;
      store.set_room_id(room_id);
    } else if (room_id) {
      const owned = get_owned_room(room_id);
      if (owned) {
        token = await import("./lib/collab_share").then(m => m.create_share_token(owned.room_secret, room_id!, "w"));
      }
    }

    if (room_id && token) {
      const ws_url = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/collab/ws/${room_id}`;
      const identity = get_or_create_identity();
      const provider = create_collab_provider({
        room_id,
        token,
        doc: store.ydoc(),
        awareness: store.awareness(),
        identity,
        ws_url,
        on_status: set_collab_status,
        on_permission: set_collab_permission,
        on_peer_count: set_collab_peer_count,
      });
      _collab_provider = provider;
      provider.connect();
    }

    set_project_ready(true);

    worker_client.on_ready(() => {
      if (!pdf_restored) {
        const files = { ...store.files };
        worker_client.compile({ files, main: store.main_file(), mode: "preview" });
      }
    });

    let save_timer: ReturnType<typeof setTimeout> | undefined;
    store.on_change(() => {
      if (folder_sync.state().active) return;
      if (save_timer !== undefined) clearTimeout(save_timer);
      save_timer = setTimeout(async () => {
        const pid = store.project_id();
        if (pid) {
          await store.flush_dirty_blobs();
          save_ydoc_project(pid, store.encode_ydoc_snapshot(), store.main_file()).catch(() => {});
        } else {
          save_project(store.files, store.main_file()).catch(() => {});
        }
      }, 1000);
    });

    worker_client.on_compile_done(() => {
      if (folder_sync.state().active && folder_sync.state().dirty_files.size > 0) {
        folder_sync.sync_now().then(handle_sync_result);
      }
    });

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
    _cleanup_resize = () => window.removeEventListener("resize", on_resize);

    document.addEventListener("keydown", handle_keydown);
    _cleanup_keydown = () => document.removeEventListener("keydown", handle_keydown);
  });

  function handle_keydown(e: KeyboardEvent) {
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

    const tag = (e.target as HTMLElement)?.tagName;
    if (!mod && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
    const shift = e.shiftKey;
    const key = e.key;

    const parts: string[] = [];
    if (mod) parts.push("Cmd");
    if (shift) parts.push("Shift");
    let key_name = key;
    if (key === "Enter") key_name = "Enter";
    else if (key === "/") key_name = "/";
    else if (key === ".") key_name = ".";
    else if (key.length === 1) key_name = key.toUpperCase();
    parts.push(key_name);
    const binding = parts.join("+");

    const cmds = get_all_commands();
    for (const cmd of cmds) {
      if (!cmd.keybinding) continue;
      if (cmd.keybinding === binding) {
        if (cmd.when && !cmd.when()) continue;
        e.preventDefault();
        cmd.action();
        return;
      }
    }

    if (key === "F8" && !mod) {
      const fk_binding = shift ? "Shift+F8" : "F8";
      for (const cmd of cmds) {
        if (cmd.keybinding === fk_binding) {
          if (cmd.when && !cmd.when()) continue;
          e.preventDefault();
          cmd.action();
          return;
        }
      }
    }
  }

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

  createEffect(() => {
    const req = worker_client.goto_request();
    if (!req) return;
    const file_exists = store.files[req.file] !== undefined;
    if (!file_exists) return;
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
    if (is_resizing()) cls += " is-resizing";
    if (layout_switching()) cls += " layout-switching";
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

  async function handle_copy_agent_write_link() {
    const rid = store.room_id();
    if (!rid) return;
    const { get_owned_room, create_share_token } = await import("./lib/collab_share");
    const owned = get_owned_room(rid);
    if (!owned) return;
    const token = await create_share_token(owned.room_secret, rid, "w");
    const ws_proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws_url = `${ws_proto}//${window.location.host}/collab/ws/${rid}`;
    const link = `${ws_url}#${token}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      alert(`Agent write link: ${link}`);
    }
  }

  function handle_accept_review(id: string) {
    agent_review_store.accept(id, store.ydoc());
  }

  function handle_reject_review(id: string) {
    agent_review_store.reject(id);
  }

  return (
    <div class="app">
      <Toolbar
        store={store}
        watch={watch}
        on_toggle_files={toggle_files}
        on_toggle_preview={toggle_preview}
        on_toggle_split={toggle_split}
        files_visible={files_visible()}
        preview_visible={use_swap_mode() ? show_preview_in_narrow() : preview_visible()}
        split_dir={split_dir()}
        swap_mode={use_swap_mode()}
        folder_sync={folder_sync}
        on_upload_conflicts={(c) => set_conflicts(c)}
        reconnect_folder={show_reconnect() ? reconnect_folder_name() : null}
        on_reconnect={handle_reconnect}
        on_dismiss_reconnect={dismiss_reconnect}
        on_start_tour={() => set_show_onboarding(true)}
        show_logs={show_logs()}
        set_show_logs={set_show_logs}
        show_info_modal={show_info_modal()}
        set_show_info_modal={set_show_info_modal}
        register_file_triggers={(file_fn, folder_fn, zip_fn) => {
          _trigger_file_upload = file_fn;
          _trigger_folder_upload = folder_fn;
          _trigger_zip_upload = zip_fn;
        }}
        collab_status={_collab_status()}
        collab_permission={collab_permission()}
        collab_peer_count={_collab_peer_count()}
        agent_review_store={agent_review_store}
        awareness={_collab_provider ? store.awareness() : null}
        on_show_agent_panel={() => set_show_agent_panel(true)}
        on_copy_agent_write_link={handle_copy_agent_write_link}
      />

      <div class={workspace_class()}>
        <Show when={!is_narrow()}>
          <div
            class={`file-panel-wrapper panel-wrapper panel-box ${!files_visible() ? "panel-collapsed" : ""}`}
            style={{ width: files_visible() ? `${file_panel_width()}px` : "0px", "flex-shrink": 0 }}
          >
            <FilePanel store={store} folder_sync={folder_sync} />
          </div>
          <ResizeHandle
            direction="horizontal"
            on_resize={handle_file_resize}
            on_drag_start={() => set_is_resizing(true)}
            on_drag_end={() => set_is_resizing(false)}
          />
        </Show>

        <div class={`split-container split-${split_dir()}`}>
          <div class="editor-wrapper panel-box">
            <Show when={project_ready()}>
              <Editor
                store={store}
                vim_enabled={vim_enabled()}
                read_only={read_only()}
                on_editor_view={set_editor_view_ref}
              />
            </Show>
          </div>

          <Show when={!use_swap_mode()}>
            <ResizeHandle
              direction={split_dir() === "vertical" ? "vertical" : "horizontal"}
              on_resize={handle_preview_resize}
              on_drag_start={() => set_is_resizing(true)}
              on_drag_end={() => set_is_resizing(false)}
            />
            <div
              class={`preview-wrapper panel-wrapper panel-box ${!preview_visible() ? "panel-collapsed" : ""}`}
              style={split_dir() === "vertical"
                ? { height: preview_visible() ? `${preview_height()}px` : "0px", "flex-shrink": 0 }
                : { width: preview_visible() ? `${preview_width()}px` : "0px", "flex-shrink": 0 }
              }
            >
              <Preview />
            </div>
          </Show>

          <Show when={use_swap_mode() && show_preview_in_narrow()}>
            <div class="preview-wrapper panel-wrapper panel-box" style={{ flex: 1 }}>
              <Preview />
            </div>
          </Show>
        </div>
      </div>

      <AnimatedShow when={files_overlay()}>
        <div class="file-panel-wrapper overlay-mode panel-wrapper panel-box">
          <FilePanel store={store} folder_sync={folder_sync} />
        </div>
      </AnimatedShow>

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

      <AnimatedShow when={show_conflicts()}>
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
      </AnimatedShow>

      <DiagnosticPill store={store} />

      <Onboarding
        visible={show_onboarding()}
        on_close={() => set_show_onboarding(false)}
      />

      <CommandPalette store={store} />

      <Show when={show_agent_panel()}>
        <AgentPanel
          awareness={_collab_provider ? store.awareness() : null}
          review_store={agent_review_store}
          on_accept={handle_accept_review}
          on_reject={handle_reject_review}
          on_clear_completed={() => agent_review_store.clear_completed()}
          on_close={() => set_show_agent_panel(false)}
        />
      </Show>
    </div>
  );
};

export default App;
