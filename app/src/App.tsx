import { type Component, onMount, onCleanup, createSignal, createEffect, createMemo, Show, batch } from "solid-js";
import type { EditorView } from "@codemirror/view";
import AnimatedShow from "./components/AnimatedShow";
import { worker_client } from "./lib/worker_client";
import type { CompileMode } from "./lib/worker_client";
import { parse_synctex } from "./lib/synctex";
import { create_project_store } from "./lib/project_store";
import { ProjectSessionManager } from "./lib/project_session_manager";
import type { ProjectSession } from "./lib/project_session";
import { get_collab_ws_url } from "./lib/collab_config";
import {
  create_share_token,
  get_share_token_permission,
  parse_collab_url,
  get_owned_room,
} from "./lib/collab_share";
import { create_collab_provider, type CollabProvider, type CollabStatus, type CollabPermission } from "./lib/collab_provider";
import { get_or_create_identity } from "./lib/identity";
import { AppContextProvider } from "./lib/app_context";
import { create_compile_scheduler } from "./lib/compile_scheduler";
import { get_all_commands, IS_MAC } from "./lib/commands";
import { show_alert_modal } from "./lib/modal_store";
import { init_commands } from "./lib/register_commands";
import { create_agent_review_store, type AgentReviewStore } from "./lib/agent_review";
import Toolbar from "./components/Toolbar";
import CommandPalette from "./components/CommandPalette";
import SearchPanel from "./components/SearchPanel";
import ConflictDialog from "./components/ConflictDialog";
import AgentPanel from "./components/AgentPanel";

import FilePanel from "./components/FilePanel";
import Editor from "./components/Editor";
import Preview from "./components/Preview";
import DiagnosticPill from "./components/DiagnosticPill";
import ResizeHandle from "./components/ResizeHandle";
import Onboarding, { is_onboarded } from "./components/Onboarding";
import Modal from "./components/Modal";
import type { ConflictInfo } from "./lib/local_folder_sync";
import { load_settings, set_setting, type AppSettings } from "./lib/settings_store";

const NARROW_BREAKPOINT = 900;
const TOO_NARROW_BREAKPOINT = 600;
const PREVIEW_WIDTH_KEY = "eztex_preview_width";
const MAX_CREATE_BLOB_ENCODED_BYTES = 768 * 1024;
const MAX_CREATE_BLOBS_TOTAL_ENCODED_BYTES = 768 * 1024;

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
  const initial_settings = load_settings();
  const session_manager = new ProjectSessionManager();
  const store = create_project_store();
  session_manager.set_store(store);

  const [settings, set_settings] = createSignal<AppSettings>(initial_settings);
  const [file_panel_width, set_file_panel_width] = createSignal(200);
  const [preview_width, set_preview_width] = createSignal(get_initial_preview_width());
  const [preview_height, set_preview_height] = createSignal(Math.floor((window.innerHeight - 44) / 2));
  const [files_visible, set_files_visible] = createSignal(
    window.innerWidth >= NARROW_BREAKPOINT && initial_settings.show_file_panel
  );
  const [preview_visible, set_preview_visible] = createSignal(initial_settings.show_preview);
  const [is_narrow, set_is_narrow] = createSignal(window.innerWidth < NARROW_BREAKPOINT);
  const [is_too_narrow, set_is_too_narrow] = createSignal(window.innerWidth <= TOO_NARROW_BREAKPOINT);
  const [show_preview_in_narrow, set_show_preview_in_narrow] = createSignal(false);
  const [split_dir, set_split_dir] = createSignal<"horizontal" | "vertical">(initial_settings.split_direction);
  const [is_resizing, set_is_resizing] = createSignal(false);
  const [layout_switching, set_layout_switching] = createSignal(false);

  const [show_onboarding, set_show_onboarding] = createSignal(!is_onboarded());
  const [project_ready, set_project_ready] = createSignal(false);

  const [show_logs, set_show_logs] = createSignal(false);
  const [show_info_modal, set_show_info_modal] = createSignal(false);
  const [show_search, set_show_search] = createSignal(false);

  const [vim_enabled, set_vim_enabled] = createSignal(initial_settings.vim_mode);

  const [collab_status, set_collab_status] = createSignal<CollabStatus>("idle");
  const [collab_permission, set_collab_permission] = createSignal<CollabPermission | null>(null);
  const [collab_peer_count, set_collab_peer_count] = createSignal(0);
  const [collab_ready, set_collab_ready] = createSignal(false);
  const [collab_role, set_collab_role] = createSignal<"owner" | "guest" | null>(null);
  const [joining_room, set_joining_room] = createSignal(false);
  const [room_deleted_notice, set_room_deleted_notice] = createSignal(false);
  const [room_deleted_countdown, set_room_deleted_countdown] = createSignal(5);
  const read_only = createMemo(() => collab_permission() === "read" || room_deleted_notice());
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
  let room_deleted_timer: ReturnType<typeof setInterval> | undefined;
  let room_deleted_cleanup_started = false;

  async function compile_project(req: { files: Record<string, string | Uint8Array>; main: string; mode: CompileMode }) {
    await store.flush_dirty_blobs();
    const missing = await store.missing_blob_paths();
    if (missing.length > 0) {
      await store.request_missing_blobs();
      scheduler.notify_compile_done(false);
      if (req.mode === "full") {
        await show_alert_modal({
          title: "Waiting for Binary Files",
          message: `Still syncing binary file data for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`,
        });
      }
      return;
    }
    worker_client.compile({ files: store.current_files(), main: req.main, mode: req.mode });
  }

  const scheduler = create_compile_scheduler({
    get_files: () => store.current_files(),
    get_main: () => store.main_file(),
    is_ready: () => worker_client.ready() && !worker_client.compiling(),
    compile: (req) => { void compile_project(req); },
    get_permission: () => collab_permission(),
    project_id: () => store.project_id() ?? undefined,
  });

  function apply_setting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    set_setting(key, value);
    set_settings(load_settings());

    if (key === "vim_mode") set_vim_enabled(value as boolean);
    if (key === "show_file_panel") set_files_visible(value as boolean);
    if (key === "show_preview") {
      set_preview_visible(value as boolean);
      set_show_preview_in_narrow(value as boolean);
    }
    if (key === "split_direction") set_split_dir(value as "horizontal" | "vertical");
    if (key === "auto_compile") scheduler.toggle(value as boolean);
  }

  const set_files_visible_setting = (value: boolean | ((prev: boolean) => boolean)): boolean => {
    const next = typeof value === "function" ? value(files_visible()) : value;
    apply_setting("show_file_panel", next);
    return next;
  };

  const set_preview_visible_setting = (value: boolean | ((prev: boolean) => boolean)): boolean => {
    const next = typeof value === "function" ? value(preview_visible()) : value;
    apply_setting("show_preview", next);
    return next;
  };

  const set_vim_enabled_setting = (value: boolean | ((prev: boolean) => boolean)): boolean => {
    const next = typeof value === "function" ? value(vim_enabled()) : value;
    apply_setting("vim_mode", next);
    return next;
  };

  createEffect(() => {
    const enabled = scheduler.enabled();
    set_settings((current) => current.auto_compile === enabled ? current : { ...current, auto_compile: enabled });
  });

  const [conflicts, set_conflicts] = createSignal<ConflictInfo[]>([]);
  const show_conflicts = createMemo(() => conflicts().length > 0);

  const [show_reconnect, set_show_reconnect] = createSignal(false);
  const [reconnect_folder_name, set_reconnect_folder_name] = createSignal("");

  const files_overlay = createMemo(() => is_narrow() && files_visible());
  const use_swap_mode = createMemo(() => is_narrow() && split_dir() === "horizontal");

  let layout_switch_timer: ReturnType<typeof setTimeout> | undefined;
  let layout_switch_reset_timer: ReturnType<typeof setTimeout> | undefined;
  let save_timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup_watch_change: (() => void) | undefined;
  let cleanup_autosave: (() => void) | undefined;
  let cleanup_folder_compile_sync: (() => void) | undefined;
  let cleanup_worker_ready: (() => void) | undefined;
  let cleanup_watch_compile: (() => void) | undefined;
  let initial_preview_requested = false;

  function sync_main_file_from_doc() {
    const meta = store.ydoc().getMap("meta");
    const saved_main = meta.get("main_file") as string | undefined;
    const names = store.file_names();
    if (saved_main && names.includes(saved_main)) {
      store.set_main_file(saved_main);
      if (!names.includes(store.current_file())) {
        store.set_current_file(saved_main);
      }
      return;
    }
    if (names.length > 0 && !names.includes(store.current_file())) {
      store.set_current_file(names[0]);
    }
  }

  function request_initial_preview() {
    if (!scheduler.enabled()) return;
    if (initial_preview_requested || !worker_client.ready() || worker_client.compiling()) return;
    if (joining_room() && !collab_ready()) return;
    const files = store.current_files();
    if (Object.keys(files).length === 0) return;
    initial_preview_requested = true;
    void compile_project({ files, main: store.main_file(), mode: "preview" });
  }

  async function resolve_collab_auth(room_id: string): Promise<{ token: string; room_secret: string | null } | null> {
    const collab_url = parse_collab_url(new URL(window.location.href));
    if (collab_url && collab_url.room_id === room_id) {
      const owned = await get_owned_room(session_manager.get_room_registry(), room_id);
      const permission = get_share_token_permission(collab_url.token);
      return {
        token: collab_url.token,
        room_secret: permission === "write" ? owned?.room_secret ?? null : null,
      };
    }

    const room = await session_manager.get_room_registry().get_by_room_id(room_id);
    if (room?.role === "guest" && room.invite_token) {
      return {
        token: room.invite_token,
        room_secret: null,
      };
    }

    const owned = await get_owned_room(session_manager.get_room_registry(), room_id);
    if (!owned) return null;

    return {
      token: await create_share_token(owned.room_secret, room_id, "w"),
      room_secret: owned.room_secret,
    };
  }

  function toggle_files() {
    set_files_visible_setting((v) => !v);
  }

  function toggle_preview() {
    if (use_swap_mode()) {
      set_show_preview_in_narrow((v) => !v);
    } else {
      set_preview_visible_setting((v) => !v);
    }
  }

  function toggle_split() {
    if (layout_switch_timer !== undefined) clearTimeout(layout_switch_timer);
    if (layout_switch_reset_timer !== undefined) clearTimeout(layout_switch_reset_timer);
    set_layout_switching(true);
    layout_switch_timer = setTimeout(() => {
      set_split_dir((d) => {
        const next = d === "horizontal" ? "vertical" : "horizontal";
        set_setting("split_direction", next);
        set_settings(load_settings());
        return next;
      });
      layout_switch_reset_timer = setTimeout(() => set_layout_switching(false), 100);
    }, 100);
  }

  function get_current_folder_sync() {
    return session_manager.current()?.folder_sync ?? null;
  }

  function clear_collab_state() {
    store.set_blob_sync_sender(null);
    set_collab_provider(null);
    set_collab_room_id(null);
    set_collab_status("idle");
    set_collab_permission(null);
    set_collab_peer_count(0);
    set_collab_ready(false);
    set_collab_role(null);
  }

  init_commands({
    project: {
      store,
      room_registry: session_manager.get_room_registry(),
      folder_sync: {
        state: () => get_current_folder_sync()?.state() ?? {
          dir_handle: null, folder_name: "", active: false,
          baseline_hashes: new Map(), last_sync: 0, syncing: false,
          dirty_files: new Set(), error: null,
        },
        open_folder: async () => get_current_folder_sync()?.open_folder() ?? false,
        pick_folder: async () => get_current_folder_sync()?.pick_folder() ?? null,
        reconnect: async () => get_current_folder_sync()?.reconnect() ?? false,
        disconnect: () => get_current_folder_sync()?.disconnect(),
        cleanup: () => get_current_folder_sync()?.cleanup(),
        sync_now: async () => get_current_folder_sync()?.sync_now() ?? { status: "ok" as const, files_written: 0 },
        sync_file: async (path: string) => get_current_folder_sync()?.sync_file(path) ?? { status: "ok" as const, files_written: 0 },
        resolve_conflict: async (path: string, resolution: "eztex" | "disk") => { await get_current_folder_sync()?.resolve_conflict(path, resolution); },
        resolve_conflict_with_content: async (path: string, content: any) => { await get_current_folder_sync()?.resolve_conflict_with_content(path, content); },
        write_pdf: async (bytes: Uint8Array) => { await get_current_folder_sync()?.write_pdf(bytes); },
        is_supported: () => get_current_folder_sync()?.is_supported() ?? false,
        has_stored_handle: async () => get_current_folder_sync()?.has_stored_handle() ?? false,
        get_stored_folder_name: async () => get_current_folder_sync()?.get_stored_folder_name() ?? null,
      },
      on_switch_project: handle_switch_project,
    },
    compile: {
      watch: scheduler,
      show_logs,
      set_show_logs,
    },
    layout: {
      files_visible,
      set_files_visible: set_files_visible_setting,
      preview_visible,
      set_preview_visible: set_preview_visible_setting,
      split_dir,
      toggle_split,
      toggle_preview,
      set_show_info_modal,
      set_show_onboarding,
      set_show_search,
    },
    editor: {
      get_editor_view,
      set_vim_enabled: set_vim_enabled_setting,
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
  let cleanup_pagehide: (() => void) | null = null;

  createEffect(() => {
    if (!settings().warn_before_close) return;
    const handle_beforeunload = (e: BeforeUnloadEvent) => {
      const fs = get_current_folder_sync();
      const has_pending_save = save_timer !== undefined || !!(fs && fs.state().dirty_files.size > 0);
      if (!has_pending_save) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handle_beforeunload);
    onCleanup(() => window.removeEventListener("beforeunload", handle_beforeunload));
  });

  onCleanup(() => {
    cleanup_autosave?.();
    cleanup_folder_compile_sync?.();
    cleanup_worker_ready?.();
    cleanup_watch_change?.();
    cleanup_watch_compile?.();
    scheduler.destroy();
    if (layout_switch_timer !== undefined) clearTimeout(layout_switch_timer);
    if (layout_switch_reset_timer !== undefined) clearTimeout(layout_switch_reset_timer);
    if (save_timer !== undefined) clearTimeout(save_timer);
    if (room_deleted_timer !== undefined) clearInterval(room_deleted_timer);
    cleanup_resize?.();
    cleanup_keydown?.();
    cleanup_pagehide?.();
    collab_provider()?.destroy();
    clear_collab_state();
    store.destroy();
    worker_client.destroy();
  });

  async function finish_room_deleted_cleanup() {
    if (room_deleted_cleanup_started) return;
    room_deleted_cleanup_started = true;
    if (room_deleted_timer !== undefined) {
      clearInterval(room_deleted_timer);
      room_deleted_timer = undefined;
    }

    const session = session_manager.current();
    const deleted_project_id = session?.project_id ?? null;
    const repo = session_manager.get_repository();
    const record = deleted_project_id ? await repo.get_project(deleted_project_id) : null;
    const fallback = (await repo.list_projects()).find((p) => p.id !== deleted_project_id && p.origin !== "guest-room");
    if (fallback) {
      await repo.set_current_project(fallback.id);
    } else {
      await repo.create_project("Demo Project");
    }

    collab_provider()?.destroy();
    clear_collab_state();
    await session_manager.close_current("delete");
    if (deleted_project_id && record?.origin === "guest-room") {
      await session_manager.delete_project(deleted_project_id).catch(() => {});
    }

    window.location.assign(new URL("/", window.location.origin).toString());
  }

  async function cleanup_deleted_owner_room() {
    if (room_deleted_timer !== undefined) {
      clearInterval(room_deleted_timer);
      room_deleted_timer = undefined;
    }
    set_room_deleted_notice(false);
    set_room_deleted_countdown(5);
    const room_id = store.room_id();
    collab_provider()?.destroy();
    store.set_room_id(undefined);
    clear_collab_state();
    if (room_id) {
      await session_manager.get_room_registry().delete_room_record(room_id).catch(() => {});
    }
    set_project_ready(true);
  }

  function handle_room_deleted(role: "owner" | "guest" | null = collab_role()) {
    if (role === "owner") {
      void cleanup_deleted_owner_room();
      return;
    }
    if (room_deleted_notice()) return;
    set_room_deleted_notice(true);
    set_room_deleted_countdown(5);
    set_project_ready(false);
    set_collab_ready(false);
    if (room_deleted_timer !== undefined) clearInterval(room_deleted_timer);
    room_deleted_timer = setInterval(() => {
      set_room_deleted_countdown((current) => {
        if (current <= 1) {
          void finish_room_deleted_cleanup();
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  }

  async function setup_after_session(session: ProjectSession, is_collab: boolean) {
    const pid = session.project_id;
    const repo = session_manager.get_repository();
    const fs = session.folder_sync;

    cleanup_watch_change?.();
    cleanup_watch_change = store.on_change(() => scheduler.notify_change());

    cleanup_watch_compile?.();
    cleanup_watch_compile = worker_client.on_compile_done(() => {
      scheduler.notify_compile_done(worker_client.status() === "success");
      const synctex_text = worker_client.synctex_text();
      if (synctex_text) {
        repo.save_synctex(synctex_text, pid).catch(() => {});
      }
    });

    cleanup_autosave?.();
    cleanup_autosave = store.on_change(() => {
      if (fs && fs.state().active) return;
      if (save_timer !== undefined) clearTimeout(save_timer);
      const timer = setTimeout(async () => {
        const current_pid = store.project_id();
        try {
          if (current_pid) {
            await store.flush_dirty_blobs();
            await repo.save_snapshot(current_pid, store.encode_ydoc_snapshot());
            await repo.update_main_file(current_pid, store.main_file());
          }
        } finally {
          if (save_timer === timer) save_timer = undefined;
        }
      }, 1000);
      save_timer = timer;
    });

    cleanup_folder_compile_sync?.();
    cleanup_folder_compile_sync = worker_client.on_compile_done(() => {
      if (fs && fs.state().active && fs.state().dirty_files.size > 0) {
        fs.sync_now().then((result) => {
          if (result && result.status === "conflict") {
            set_conflicts(result.conflicts);
          }
        });
      }
    });

    const [pdf_bytes, synctex_text] = await Promise.all([
      repo.load_pdf(pid),
      repo.load_synctex(pid),
    ]);

    let pdf_restored = false;
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

    if (!is_collab) {
      set_project_ready(true);
    }

    cleanup_worker_ready?.();
    cleanup_worker_ready = worker_client.on_ready(() => {
      if (!pdf_restored) request_initial_preview();
    });
    if (worker_client.ready() && !pdf_restored) request_initial_preview();

    if (fs && fs.is_supported()) {
      const has_handle = await fs.has_stored_handle();
      if (has_handle) {
        const name = await fs.get_stored_folder_name();
        const is_fresh = store.file_names().length <= 1;
        if (is_fresh) {
          await fs.reconnect();
        } else {
          set_reconnect_folder_name(name ?? "folder");
          set_show_reconnect(true);
        }
      }
    }
  }

  onMount(async () => {
    worker_client.init();
    await session_manager.init();

    const collab_url = parse_collab_url(new URL(window.location.href));
    let session: ProjectSession;
    let is_collab = false;

    if (collab_url) {
      is_collab = true;
      set_joining_room(true);
      const room_reg = session_manager.get_room_registry();
      const owned = await room_reg.get_by_room_id(collab_url.room_id);
      if (owned && owned.role === "owner") {
        const repo = session_manager.get_repository();
        const exists = await repo.get_project(owned.project_id);
        if (exists) {
          session = await session_manager.open_owned_room(owned.project_id, collab_url.room_id);
        } else {
          session = await session_manager.open_local(owned.project_id);
          store.set_room_id(collab_url.room_id);
        }
      } else {
        session = await session_manager.open_guest_room(collab_url.room_id, collab_url.token);
      }
    } else {
      const repo = session_manager.get_repository();
      const url_params = new URLSearchParams(window.location.search);
      const url_project_id = url_params.get("project");
      const current_id = await repo.get_current_project();
      const project_id = url_project_id || current_id;

      if (project_id) {
        session = await session_manager.open_local(project_id);
      } else {
        const record = await repo.create_project();
        session = await session_manager.open_local(record.id);
      }
    }

    scheduler.set_project_id(session.project_id);
    scheduler.seed_current_files();

    if (is_collab && session.collab_provider) {
      session.collab_provider.destroy();
      (session as any).collab_provider = null;
    }

    await setup_after_session(session, is_collab);

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

    const handle_pagehide = () => {
      if (save_timer !== undefined) {
        clearTimeout(save_timer);
        save_timer = undefined;
      }
      const pid = store.project_id();
      if (!pid) return;
      const repo = session_manager.get_repository();
      store.flush_dirty_blobs().then(() => {
        const snapshot = store.encode_ydoc_snapshot();
        return Promise.all([
          repo.save_snapshot(pid, snapshot),
          repo.update_main_file(pid, store.main_file()),
        ]);
      }).catch(() => {});
    };

    window.addEventListener("pagehide", handle_pagehide);
    cleanup_pagehide = () => window.removeEventListener("pagehide", handle_pagehide);
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
    const fs = get_current_folder_sync();
    if (current !== prev_file && fs && fs.state().active) {
      const file_to_sync = prev_file;
      if (fs.state().dirty_files.has(file_to_sync)) {
        fs.sync_file(file_to_sync).then((result) => {
          if (result && result.status === "conflict") {
            set_conflicts(result.conflicts);
          }
        });
      }
    }
    prev_file = current;
  });

  createEffect(() => {
    const req = worker_client.goto_request();
    if (!req) return;
    const file_exists = store.file_names().includes(req.file);
    if (!file_exists) return;
    if (req.file !== store.current_file()) {
      store.set_current_file(req.file);
    }
  });

  createEffect(() => {
    const pid = store.project_id();
    const room_id = store.room_id();
    const active_room_id = collab_room_id();
    const current_provider = collab_provider();

    if (!pid) return;

    if (!room_id) {
      if (current_provider) {
        current_provider.destroy();
      }
      clear_collab_state();
      return;
    }

    if (active_room_id === room_id && current_provider) return;

    if (current_provider && active_room_id && active_room_id !== room_id) {
      current_provider.destroy();
      clear_collab_state();
    }

    let cancelled = false;
    void resolve_collab_auth(room_id).then(async (auth) => {
      if (cancelled || !auth) return;

      collab_provider()?.destroy();
      clear_collab_state();

      const is_owner = !!auth.room_secret && auth.token.startsWith("w.");
      set_collab_role(is_owner ? "owner" : "guest");
      let precomputed_blobs: Record<string, string> | undefined;
      if (is_owner) {
        precomputed_blobs = await store.export_blobs({
          max_blob_encoded_bytes: MAX_CREATE_BLOB_ENCODED_BYTES,
          max_total_encoded_bytes: MAX_CREATE_BLOBS_TOTAL_ENCODED_BYTES,
        });
      }

      const provider = create_collab_provider({
        room_id,
        token: auth.token,
        room_secret: auth.room_secret,
        doc: store.ydoc(),
        awareness: store.awareness(),
        identity: get_or_create_identity(),
        ws_url: get_collab_ws_url(room_id),
        precomputed_blobs,
        on_status: (status) => {
          set_collab_status(status);
          if (status === "deleted") {
            set_collab_ready(false);
          } else {
            set_collab_ready(status === "connected");
          }
          if (status === "connected") {
            store.clear_snapshot_expected();
            sync_main_file_from_doc();
            void store.announce_available_blobs();
            void store.request_missing_blobs();
          }
        },
        on_permission: set_collab_permission,
        on_peer_count: set_collab_peer_count,
        on_room_deleted: () => handle_room_deleted(is_owner ? "owner" : "guest"),
        on_blob_available: (hash) => { void store.handle_blob_available(hash); },
        on_blob_request: (hash) => { void store.handle_blob_request(hash); },
        on_blob_response: (hash, bytes) => { void store.handle_blob_response(hash, bytes); },
        put_blobs: (blobs) => store.import_blobs(blobs),
      });
      store.set_blob_sync_sender({
        send_blob_available: provider.send_blob_available,
        send_blob_request: provider.send_blob_request,
        send_blob_response: provider.send_blob_response,
      });
      set_collab_provider(provider);
      set_collab_room_id(room_id);
      provider.connect();
    });

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!joining_room() || !collab_ready()) return;
    store.clear_snapshot_expected();
    sync_main_file_from_doc();
    set_project_ready(true);
    request_initial_preview();
  });

  createEffect(() => {
    if (collab_status() !== "deleted") return;
    if (!store.room_id()) return;
    handle_room_deleted();
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
    const fs = get_current_folder_sync();
    if (fs) await fs.reconnect();
  }

  function dismiss_reconnect() {
    set_show_reconnect(false);
  }

  async function handle_switch_project(new_id: string) {
    set_project_ready(false);

    const session = await session_manager.switch_to(new_id);

    scheduler.set_project_id(new_id);
    scheduler.seed_current_files();

    const current_provider = collab_provider();
    if (current_provider) {
      current_provider.destroy();
      clear_collab_state();
    }

    await setup_after_session(session, false);

    initial_preview_requested = false;
    set_project_ready(true);

    const url = new URL(window.location.href);
    url.searchParams.set("project", new_id);
    history.pushState({}, "", url.pathname + url.search);

    request_initial_preview();
  }

  async function handle_delete_project(id: string) {
    await session_manager.delete_project(id);
  }

  async function handle_before_reset_all() {
    await session_manager.close_current("delete");
    clear_collab_state();
    store.destroy();
    worker_client.destroy();
  }

  async function handle_copy_agent_write_link() {
    const rid = store.room_id();
    if (!rid) return;
    const owned = await get_owned_room(session_manager.get_room_registry(), rid);
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
    get_folder_sync: () => get_current_folder_sync(),
    collab: {
      status: collab_status,
      permission: collab_permission,
      peer_count: collab_peer_count,
      awareness: collab_awareness,
    },
    agent_review_store,
  };

  createEffect(() => {
    if (store.room_id()) set_show_agent_panel(false);
  });

  return (
    <AppContextProvider value={app_context}>
      <div class="app">
        <Show when={room_deleted_notice()}>
          <div class="room-deleted-overlay" role="alertdialog" aria-modal="true" aria-labelledby="room-deleted-title">
            <div class="room-deleted-card">
              <div id="room-deleted-title" class="room-deleted-title">Room deleted</div>
              <p class="room-deleted-message">
                This shared room has been deleted. Editing is disabled and you will be redirected in {room_deleted_countdown()} seconds.
              </p>
              <button class="room-deleted-action" onClick={() => { void finish_room_deleted_cleanup(); }}>
                Go home now
              </button>
            </div>
          </div>
        </Show>
        <Toolbar
          store={store}
          room_registry={session_manager.get_room_registry()}
          watch={scheduler}
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
          settings={settings()}
          on_update_setting={apply_setting}
          register_file_triggers={(file_fn, folder_fn, zip_fn) => {
            _trigger_file_upload = file_fn;
            _trigger_folder_upload = folder_fn;
            _trigger_zip_upload = zip_fn;
          }}
          on_show_agent_panel={() => set_show_agent_panel(true)}
          on_switch_project={handle_switch_project}
          on_delete_project={handle_delete_project}
          on_before_reset_all={handle_before_reset_all}
          get_folder_sync={get_current_folder_sync}
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
                  word_wrap={settings().word_wrap}
                  editor_font_size={settings().editor_font_size}
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
              const fs = get_current_folder_sync();
              if (fs) fs.resolve_conflict(path, resolution);
            }
            set_conflicts(prev => prev.filter(c => c.path !== path));
          }}
          on_resolve_merged={(path, content) => {
            const conflict = conflicts().find(c => c.path === path);
            const is_upload = conflict && !conflict.eztex_hash && !conflict.disk_hash;
            if (is_upload) {
              store.update_content(path, content);
            } else {
              const fs = get_current_folder_sync();
              if (fs) fs.resolve_conflict_with_content(path, content);
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
      <SearchPanel store={store} show={show_search()} on_close={() => set_show_search(false)} />

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
