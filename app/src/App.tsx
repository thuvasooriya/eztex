import { type Component, onMount, onCleanup, createSignal, createEffect, createMemo, Show, batch } from "solid-js";
import type { EditorView } from "@codemirror/view";
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
  load_project_manifest,
  migrate_v1_default_project,
  save_ydoc_project,
  save_project,
  create_fresh_project,
} from "./lib/project_persist";
import { get_project, set_current_project } from "./lib/project_manager";
import { get_collab_ws_url } from "./lib/collab_config";
import { create_share_token, get_share_token_permission, parse_collab_url, get_owned_room } from "./lib/collab_share";
import { create_collab_provider, type CollabProvider, type CollabStatus, type CollabPermission } from "./lib/collab_provider";
import { get_or_create_identity } from "./lib/identity";
import { AppContextProvider } from "./lib/app_context";
import { create_local_folder_sync, type ConflictInfo } from "./lib/local_folder_sync";
import { create_watch_controller } from "./lib/watch_controller";
import { get_all_commands, IS_MAC } from "./lib/commands";
import { show_alert_modal } from "./lib/modal_store";
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
import Modal from "./components/Modal";

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

  const [collab_status, set_collab_status] = createSignal<CollabStatus>("idle");
  const [collab_permission, set_collab_permission] = createSignal<CollabPermission | null>(null);
  const [collab_peer_count, set_collab_peer_count] = createSignal(0);
  const read_only = createMemo(() => collab_permission() === "read");
  const [collab_room_id, set_collab_room_id] = createSignal<string | null>(null);

  const [collab_provider, set_collab_provider] = createSignal<CollabProvider | null>(null);
  const collab_awareness = createMemo(() => collab_provider() ? store.awareness() : null);

  const agent_review_store: AgentReviewStore = create_agent_review_store();
  const [show_agent_panel, set_show_agent_panel] = createSignal(false);

  let editor_view: EditorView | undefined;
  function set_editor_view_ref(view: EditorView) { editor_view = view; }
  function get_editor_view(): EditorView | undefined { return editor_view; }

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
  const cleanup_watch_change = store.on_change(() => watch.notify_change());
  const cleanup_watch_compile = worker_client.on_compile_done(() => watch.notify_compile_done());

  const [conflicts, set_conflicts] = createSignal<ConflictInfo[]>([]);
  const show_conflicts = createMemo(() => conflicts().length > 0);

  const [show_reconnect, set_show_reconnect] = createSignal(false);
  const [reconnect_folder_name, set_reconnect_folder_name] = createSignal("");

  const files_overlay = createMemo(() => is_narrow() && files_visible());
  const use_swap_mode = createMemo(() => is_narrow() && split_dir() === "horizontal");

  let layout_switch_timer: ReturnType<typeof setTimeout> | undefined;
  let layout_switch_reset_timer: ReturnType<typeof setTimeout> | undefined;
  let save_timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup_autosave: (() => void) | undefined;
  let cleanup_folder_compile_sync: (() => void) | undefined;
  let cleanup_worker_ready: (() => void) | undefined;

  async function resolve_collab_auth(room_id: string): Promise<{ token: string; room_secret: string | null } | null> {
    const collab_url = parse_collab_url(new URL(window.location.href));
    if (collab_url && collab_url.room_id === room_id) {
      const owned = get_owned_room(room_id);
      const permission = get_share_token_permission(collab_url.token);
      return {
        token: collab_url.token,
        room_secret: permission === "write" ? owned?.room_secret ?? null : null,
      };
    }

    const owned = get_owned_room(room_id);
    if (!owned) return null;

    return {
      token: await create_share_token(owned.room_secret, room_id, "w"),
      room_secret: owned.room_secret,
    };
  }

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
    if (layout_switch_timer !== undefined) clearTimeout(layout_switch_timer);
    if (layout_switch_reset_timer !== undefined) clearTimeout(layout_switch_reset_timer);
    set_layout_switching(true);
    layout_switch_timer = setTimeout(() => {
      set_split_dir((d) => {
        const next = d === "horizontal" ? "vertical" : "horizontal";
        localStorage.setItem(SPLIT_DIR_KEY, next);
        return next;
      });
      layout_switch_reset_timer = setTimeout(() => set_layout_switching(false), 100);
    }, 100);
  }

  async function handle_sync_result(result: Awaited<ReturnType<typeof folder_sync.sync_now>>) {
    if (result.status === "conflict") {
      set_conflicts(result.conflicts);
    }
  }

  init_commands({
    project: {
      store,
      folder_sync,
    },
    compile: {
      watch,
      show_logs,
      set_show_logs,
    },
    layout: {
      files_visible,
      set_files_visible,
      preview_visible,
      set_preview_visible,
      split_dir,
      toggle_split,
      toggle_preview,
      set_show_info_modal,
      set_show_onboarding,
    },
    editor: {
      get_editor_view,
      set_vim_enabled,
      vim_enabled,
    },
    uploads: {
      trigger_file_upload: () => _trigger_file_upload(),
      trigger_folder_upload: () => _trigger_folder_upload(),
      trigger_zip_upload: () => _trigger_zip_upload(),
    },
    agent: {
      agent_review_store,
      set_show_agent_panel,
      on_copy_agent_write_link: handle_copy_agent_write_link,
    },
  });

  let cleanup_resize: (() => void) | null = null;
  let cleanup_keydown: (() => void) | null = null;
  onCleanup(() => {
    cleanup_autosave?.();
    cleanup_folder_compile_sync?.();
    cleanup_worker_ready?.();
    cleanup_watch_change();
    cleanup_watch_compile();
    watch.cleanup();
    if (layout_switch_timer !== undefined) clearTimeout(layout_switch_timer);
    if (layout_switch_reset_timer !== undefined) clearTimeout(layout_switch_reset_timer);
    if (save_timer !== undefined) clearTimeout(save_timer);
    cleanup_resize?.();
    cleanup_keydown?.();
    collab_provider()?.destroy();
    set_collab_provider(null);
    folder_sync.cleanup();
    store.destroy();
    worker_client.destroy();
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
      if (store.file_names().length === 0) {
        loaded_from_snapshot = false;
      } else {
        // sync main_file signal from restored ydoc metadata
        const meta = store.ydoc().getMap("meta");
        const saved_main = meta.get("main_file") as string | undefined;
        if (saved_main) {
          store.set_main_file(saved_main);
          store.set_current_file(saved_main);
        }
      }
    }

    // check if this is a v2 project (exists in catalog)
    const catalog = await load_catalog();
    const is_v2_project = catalog.projects.some(p => p.id === project_id);

    const [pdf_bytes, synctex_text] = await Promise.all([
      load_pdf(project_id),
      load_synctex(project_id),
    ]);

    let pdf_restored = false;
    if (!loaded_from_snapshot) {
      if (is_v2_project) {
        // v2 project with no files - load template for fresh projects
        await store.init_from_template();
      } else {
        // v1 fallback only for legacy projects not in catalog
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
      }
    } else {
      await store.load_persisted_blobs();
      // restore main_file from manifest if not already set from snapshot
      const manifest = await load_project_manifest(project_id);
      if (manifest?.main_file && store.file_names().includes(manifest.main_file)) {
        store.set_main_file(manifest.main_file);
        store.set_current_file(manifest.main_file);
      }
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

    // capture room from share URL so the reactive collab connector can pick it up
    const collab_url = parse_collab_url(new URL(window.location.href));
    if (collab_url) {
      store.set_room_id(collab_url.room_id);
    }

    set_project_ready(true);

    cleanup_worker_ready = worker_client.on_ready(() => {
      if (!pdf_restored) {
        const files = { ...store.files };
        worker_client.compile({ files, main: store.main_file(), mode: "preview" });
      }
    });
    // if worker is already ready by now, trigger compile directly
    if (worker_client.ready() && !pdf_restored) {
      const files = { ...store.files };
      worker_client.compile({ files, main: store.main_file(), mode: "preview" });
    }

    cleanup_autosave = store.on_change(() => {
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

    cleanup_folder_compile_sync = worker_client.on_compile_done(() => {
      if (folder_sync.state().active && folder_sync.state().dirty_files.size > 0) {
        folder_sync.sync_now().then(handle_sync_result);
      }
    });

    if (folder_sync.is_supported()) {
      const has_handle = await folder_sync.has_stored_handle();
      if (has_handle) {
        const name = await folder_sync.get_stored_folder_name();
        const is_fresh = store.file_names().length <= 1;
        if (is_fresh) {
          await folder_sync.reconnect();
        } else {
          set_reconnect_folder_name(name ?? "folder");
          set_show_reconnect(true);
        }
      }
    }

    const on_resize = () => {
      const w = window.innerWidth;
      const narrow = w < NARROW_BREAKPOINT;
      batch(() => {
        set_is_narrow(narrow);
        set_is_too_narrow(w <= TOO_NARROW_BREAKPOINT);
        if (!narrow) {
          set_show_preview_in_narrow(false);
        }
      });
    };
    window.addEventListener("resize", on_resize);
    cleanup_resize = () => window.removeEventListener("resize", on_resize);

    document.addEventListener("keydown", handle_keydown);
    cleanup_keydown = () => document.removeEventListener("keydown", handle_keydown);
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

  createEffect(() => {
    if (!project_ready()) return;

    const room_id = store.room_id();
    const active_room_id = collab_room_id();
    const current_provider = collab_provider();

    if (!room_id) {
      if (current_provider) {
        current_provider.destroy();
        set_collab_provider(null);
        set_collab_room_id(null);
      }
      return;
    }

    if (active_room_id === room_id && current_provider) return;

    if (current_provider && active_room_id && active_room_id !== room_id) {
      current_provider.destroy();
      set_collab_provider(null);
      set_collab_room_id(null);
    }

    let cancelled = false;
    void resolve_collab_auth(room_id).then((auth) => {
      if (cancelled || !auth) return;

      collab_provider()?.destroy();
      set_collab_provider(null);

      const provider = create_collab_provider({
        room_id,
        token: auth.token,
        room_secret: auth.room_secret,
        doc: store.ydoc(),
        awareness: store.awareness(),
        identity: get_or_create_identity(),
        ws_url: get_collab_ws_url(room_id),
        on_status: set_collab_status,
        on_permission: set_collab_permission,
        on_peer_count: set_collab_peer_count,
      });
      set_collab_provider(provider);
      set_collab_room_id(room_id);
      provider.connect();
    });

    onCleanup(() => {
      cancelled = true;
    });
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

  const workspace_class = createMemo(() => {
    let cls = "workspace";
    if (is_narrow()) cls += " narrow-mode";
    if (use_swap_mode() && show_preview_in_narrow()) cls += " show-preview";
    if (is_resizing()) cls += " is-resizing";
    if (layout_switching()) cls += " layout-switching";
    cls += ` split-${split_dir()}`;
    return cls;
  });

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
    const owned = get_owned_room(rid);
    if (!owned) return;
    const token = await create_share_token(owned.room_secret, rid, "w");
    const ws_url = get_collab_ws_url(rid);
    const link = `${ws_url}#${token}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      await show_alert_modal({
        title: "Agent Write Link",
        message: link,
      });
    }
  }

  function handle_accept_review(id: string) {
    agent_review_store.accept(id, store.ydoc());
  }

  function handle_reject_review(id: string) {
    agent_review_store.reject(id);
  }

  const app_context = {
    folder_sync,
    collab: {
      status: collab_status,
      permission: collab_permission,
      peer_count: collab_peer_count,
      awareness: collab_awareness,
    },
    agent_review_store,
  };

  return (
    <AppContextProvider value={app_context}>
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
          on_show_agent_panel={() => set_show_agent_panel(true)}
        />

        <div class={workspace_class()}>
          <Show when={!is_narrow()}>
            <div
              class={`file-panel-wrapper panel-wrapper panel-box ${!files_visible() ? "panel-collapsed" : ""}`}
              style={{ "--panel-width": files_visible() ? `${file_panel_width()}px` : "0px" }}
            >
              <FilePanel store={store} />
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
                class={`preview-wrapper panel-wrapper panel-box ${split_dir() === "vertical" ? "preview-vertical-sized" : "preview-horizontal-sized"} ${!preview_visible() ? "panel-collapsed" : ""}`}
                style={split_dir() === "vertical"
                  ? { "--preview-size": preview_visible() ? `${preview_height()}px` : "0px" }
                  : { "--preview-size": preview_visible() ? `${preview_width()}px` : "0px" }
                }
              >
                <Preview />
              </div>
            </Show>

            <Show when={use_swap_mode() && show_preview_in_narrow()}>
              <div class="preview-wrapper panel-wrapper panel-box preview-fill">
                <Preview />
              </div>
            </Show>
          </div>
        </div>

      <AnimatedShow when={files_overlay()}>
        <div class="file-panel-wrapper overlay-mode panel-wrapper panel-box">
          <FilePanel store={store} />
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
          on_accept={handle_accept_review}
          on_reject={handle_reject_review}
          on_clear_completed={() => agent_review_store.clear_completed()}
          on_close={() => set_show_agent_panel(false)}
        />
      </Show>
        <Modal />
      </div>
    </AppContextProvider>
  );
};

export default App;
