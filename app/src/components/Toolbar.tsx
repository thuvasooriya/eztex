import { type Component, Show, For, onCleanup, onMount, createSignal, createEffect, createMemo, untrack, type Setter } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import { worker_client, type LogEntry } from "../lib/worker_client";
import ProgressBar from "./ProgressBar";
import UserAvatar from "./UserAvatar";
import { read_zip, write_zip } from "../lib/zip_utils";
import { use_app_context } from "../lib/app_context";
import type { ProjectStore } from "../lib/project_store";
import { is_binary, is_text_ext } from "../lib/project_store";
import type { ProjectFiles } from "../lib/project_store";
import { save_pdf, clear_bundle_cache, reset_all_persistence } from "../lib/project_persist";
import type { ProjectCatalogEntry } from "../lib/project_persist";
import { list_projects, rename_project, delete_project, get_project_url, create_project, set_current_project, duplicate_project } from "../lib/project_manager";
import { create_room_links, download_rooms_backup, get_owned_room, get_owned_room_links, load_rooms_backup_from_file } from "../lib/collab_share";
import { get_or_create_identity } from "../lib/identity";
import { get_jjk_name } from "../lib/jjk_names";
import type { ConflictInfo } from "../lib/local_folder_sync";
import type { WatchController } from "../lib/watch_controller";
import logo_svg from "/logo.svg?raw";
import { show_input_modal, show_confirm_modal, show_choice_modal, show_alert_modal } from "../lib/modal_store";

type Props = {
  store: ProjectStore;
  watch: WatchController;
  on_toggle_files?: () => void;
  on_toggle_preview?: () => void;
  on_toggle_split?: () => void;
  files_visible?: boolean;
  preview_visible?: boolean;
  split_dir?: "horizontal" | "vertical";
  swap_mode?: boolean;
  on_upload_conflicts?: (conflicts: ConflictInfo[]) => void;
  reconnect_folder?: string | null;
  on_reconnect?: () => void;
  on_dismiss_reconnect?: () => void;
  on_start_tour?: () => void;
  show_logs: boolean;
  set_show_logs: Setter<boolean>;
  show_info_modal: boolean;
  set_show_info_modal: Setter<boolean>;
  register_file_triggers?: (file_fn: () => void, folder_fn: () => void, zip_fn: () => void) => void;
  on_show_agent_panel?: () => void;
};

const Logo: Component = () => (
  <span class="logo" aria-label="eztex" innerHTML={logo_svg} />
);

type HumanPeer = {
  user_id: string;
  display_name: string;
  color: string;
  current_file: string | null;
  current_line: number | null;
  last_active_at: number | null;
  edit_count: number;
  is_self: boolean;
};

const Toolbar: Component<Props> = (props) => {
  const app = use_app_context();
  const folder_sync = () => app.folder_sync;
  const collab = app.collab;
  const agent_review_store = () => app.agent_review_store;
  const local_identity = get_or_create_identity();

  let zip_input_ref: HTMLInputElement | undefined;
  let folder_input_ref: HTMLInputElement | undefined;
  let file_input_ref: HTMLInputElement | undefined;
  let rooms_backup_input_ref: HTMLInputElement | undefined;
  let upload_btn_ref: HTMLDivElement | undefined;
  let download_btn_ref: HTMLDivElement | undefined;
  let share_presence_ref: HTMLDivElement | undefined;

  const [show_upload_menu, set_show_upload_menu] = createSignal(false);
  const [show_download_menu, set_show_download_menu] = createSignal(false);
  const [show_project_menu, set_show_project_menu] = createSignal(false);
  const [show_share_menu, set_show_share_menu] = createSignal(false);
  const [selected_peer_id, set_selected_peer_id] = createSignal<string | null>(null);
  const [selected_peer_left, set_selected_peer_left] = createSignal(0);
  const [share_links, set_share_links] = createSignal<{ write_url: string; read_url: string } | null>(null);
  const [projects, set_projects] = createSignal<ProjectCatalogEntry[]>([]);
  const [current_project_name, set_current_project_name] = createSignal("");
  // show_info_modal and show_logs are now received via props (lifted to App)
  const show_info_modal = () => props.show_info_modal;
  const set_show_info_modal = props.set_show_info_modal;
  const show_logs = () => props.show_logs;
  const set_show_logs = props.set_show_logs;
  const [logs_pinned, set_logs_pinned] = createSignal(false);
  const [logs_auto_opened, set_logs_auto_opened] = createSignal(false);
  let compile_group_ref: HTMLDivElement | undefined;
  let log_ref: HTMLDivElement | undefined;
  let project_btn_ref: HTMLDivElement | undefined;

  // cache state (moved from CachePill)
  const [cache_bytes, set_cache_bytes] = createSignal(0);
  const [clearing_cache, set_clearing_cache] = createSignal(false);
  const [awareness_revision, set_awareness_revision] = createSignal(0);
  const [clock_now, set_clock_now] = createSignal(Date.now());
  let estimate_opfs_timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup_compile_persist: (() => void) | undefined;
  let cleanup_clock: ReturnType<typeof setInterval> | undefined;
  const current_owned_room = createMemo(() => {
    const room_id = props.store.room_id();
    return room_id ? get_owned_room(room_id) : null;
  });
  const show_room_backup_actions = createMemo(() => !props.store.room_id() || current_owned_room() !== null);
  const connected_users = createMemo<HumanPeer[]>(() => {
    const awareness = collab.awareness();
    if (!awareness) return [];
    awareness_revision();

    const users = new Map<string, HumanPeer>();
    for (const [, state] of awareness.getStates()) {
      const user = state?.user;
      if (!user || user.kind === "agent" || typeof user.user_id !== "string") continue;
      users.set(user.user_id, {
        user_id: user.user_id,
        display_name: typeof user.name === "string" ? user.name : get_jjk_name(user.user_id),
        color: typeof user.color === "string" ? user.color : "var(--accent)",
        current_file: typeof state.cursor_file === "string" ? state.cursor_file : null,
        current_line: typeof state.cursor_line === "number" ? state.cursor_line : null,
        last_active_at: typeof state.last_active_at === "number" ? state.last_active_at : null,
        edit_count: typeof state.edit_count === "number" ? state.edit_count : 0,
        is_self: user.user_id === local_identity.user_id,
      });
    }

    return [...users.values()].sort((a, b) => {
      if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
      return a.display_name.localeCompare(b.display_name);
    });
  });
  const selected_peer = createMemo(() => connected_users().find((user) => user.user_id === selected_peer_id()) ?? null);

  createEffect(() => {
    const awareness = collab.awareness();
    if (!awareness) {
      set_awareness_revision(0);
      return;
    }

    const refresh = () => set_awareness_revision((v) => v + 1);
    refresh();
    awareness.on("change", refresh);
    onCleanup(() => awareness.off("change", refresh));
  });

  createEffect(() => {
    if (!selected_peer_id()) return;
    const on_click = (e: MouseEvent) => {
      if (share_presence_ref && share_presence_ref.contains(e.target as Node)) return;
      set_selected_peer_id(null);
    };
    const on_key = (e: KeyboardEvent) => {
      if (e.key === "Escape") set_selected_peer_id(null);
    };
    document.addEventListener("click", on_click);
    document.addEventListener("keydown", on_key);
    onCleanup(() => {
      document.removeEventListener("click", on_click);
      document.removeEventListener("keydown", on_key);
    });
  });

  function format_cache_size(bytes: number): string {
    if (bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function estimate_opfs() {
    try {
      const root = await navigator.storage.getDirectory();
      let total = 0;
      async function walk(dir: FileSystemDirectoryHandle) {
        for await (const [, handle] of (dir as any).entries()) {
          if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            total += file.size;
          } else if (handle.kind === "directory") {
            await walk(handle as FileSystemDirectoryHandle);
          }
        }
      }
      try {
        const cache_dir = await root.getDirectoryHandle("eztex-cache");
        await walk(cache_dir);
      } catch { /* cache dir doesn't exist yet */ }
      set_cache_bytes(total);
    } catch {
      set_cache_bytes(0);
    }
  }

  onMount(() => {
    estimate_opfs();
    // expose file input trigger callbacks to App via props
    props.register_file_triggers?.(
      () => file_input_ref?.click(),
      () => folder_input_ref?.click(),
      () => zip_input_ref?.click(),
    );
    cleanup_compile_persist = worker_client.on_compile_done(() => {
      const url = worker_client.pdf_url();
      if (!url) return;
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          save_pdf(bytes, props.store.project_id() || undefined).catch(() => {});
          if (folder_sync().state().active) {
            folder_sync().write_pdf(bytes).catch(() => {});
          }
        })
        .catch(() => {});
    });
    cleanup_clock = setInterval(() => set_clock_now(Date.now()), 30000);
  });

  onCleanup(() => {
    cleanup_compile_persist?.();
    if (cleanup_clock !== undefined) clearInterval(cleanup_clock);
    if (estimate_opfs_timer !== undefined) clearTimeout(estimate_opfs_timer);
  });

  // re-estimate after compile finishes
  createEffect(() => {
    const s = worker_client.status();
    if (estimate_opfs_timer !== undefined) {
      clearTimeout(estimate_opfs_timer);
      estimate_opfs_timer = undefined;
    }
    if (s === "success" || s === "error") {
      estimate_opfs_timer = setTimeout(estimate_opfs, 300);
    }
  });

  async function handle_clear_cache() {
    set_clearing_cache(true);
    try {
      worker_client.clear_cache();
      await clear_bundle_cache();
    } catch { /* noop */ }
    await estimate_opfs();
    set_clearing_cache(false);
  }

  // close upload menu on click outside
  createEffect(() => {
    if (!show_upload_menu()) return;
    const handler = (e: MouseEvent) => {
      if (upload_btn_ref && !upload_btn_ref.contains(e.target as Node)) {
        set_show_upload_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // close download menu on click outside
  createEffect(() => {
    if (!show_download_menu()) return;
    const handler = (e: MouseEvent) => {
      if (download_btn_ref && !download_btn_ref.contains(e.target as Node)) {
        set_show_download_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // load projects list
  async function refresh_projects() {
    const all = await list_projects();
    set_projects(all);
    const current = all.find((p) => p.id === props.store.project_id());
    set_current_project_name(current?.name ?? "Untitled Project");
  }

  onMount(() => {
    void refresh_projects();
  });

  // refresh project name when project_id changes (handles init + switches)
  createEffect(() => {
    props.store.project_id();
    void refresh_projects();
  });

  // close project menu on click outside
  createEffect(() => {
    if (!show_project_menu()) return;
    const handler = (e: MouseEvent) => {
      if (project_btn_ref && !project_btn_ref.contains(e.target as Node)) {
        set_show_project_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // close share menu on click outside
  let share_btn_ref: HTMLDivElement | undefined;
  createEffect(() => {
    if (!show_share_menu()) return;
    const handler = (e: MouseEvent) => {
      if (share_btn_ref && !share_btn_ref.contains(e.target as Node)) {
        set_show_share_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  async function handle_create_room() {
    const pid = props.store.project_id();
    if (!pid) return;
    const links = await create_room_links(pid, current_project_name());
    set_share_links({ write_url: links.write_url, read_url: links.read_url });
    props.store.set_room_id(links.room_id);
  }

  async function handle_copy_write_share_link() {
    const room_id = props.store.room_id();
    const links = share_links() ?? (room_id ? await get_owned_room_links(room_id) : null);
    if (links) {
      await handle_copy_link(links.write_url);
      return;
    }
    await show_alert_modal({
      title: "Write Link Unavailable",
      message: "This browser does not have the room secret for generating a write link.",
    });
  }

  async function handle_copy_read_share_link() {
    const room_id = props.store.room_id();
    const links = share_links() ?? (room_id ? await get_owned_room_links(room_id) : null);
    const url = links?.read_url ?? window.location.href;
    await handle_copy_link(url);
  }

  function handle_export_rooms() {
    set_show_project_menu(false);
    download_rooms_backup();
  }

  async function handle_import_rooms_backup(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const result = await load_rooms_backup_from_file(file);
      await show_alert_modal({
        title: "Rooms Imported",
        message: `Imported ${result.imported} room(s). Skipped ${result.skipped}.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to import room backup.";
      await show_alert_modal({
        title: "Import Error",
        message,
      });
    }

    input.value = "";
  }

  function handle_jump_to_peer(peer: HumanPeer) {
    if (!peer.current_file || !peer.current_line) return;
    set_selected_peer_id(null);
    props.store.set_current_file(peer.current_file);
    worker_client.request_goto(peer.current_file, peer.current_line);
  }

  function handle_select_peer(peer: HumanPeer, el: HTMLElement) {
    const root_rect = share_presence_ref?.getBoundingClientRect();
    const avatar_rect = el.getBoundingClientRect();
    set_selected_peer_left(root_rect ? avatar_rect.left - root_rect.left : 0);
    set_selected_peer_id((current) => current === peer.user_id ? null : peer.user_id);
  }

  function format_last_active(ts: number | null): string {
    void clock_now();
    if (!ts) return "Unknown";
    const diff_ms = Math.max(0, Date.now() - ts);
    const diff_sec = Math.floor(diff_ms / 1000);
    if (diff_sec < 10) return "Just now";
    if (diff_sec < 60) return `${diff_sec}s ago`;
    const diff_min = Math.floor(diff_sec / 60);
    if (diff_min < 60) return `${diff_min}m ago`;
    const diff_hr = Math.floor(diff_min / 60);
    if (diff_hr < 24) return `${diff_hr}h ago`;
    return `${Math.floor(diff_hr / 24)}d ago`;
  }

  async function handle_copy_link(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // fallback
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url;
      document.body.appendChild(a);
      document.execCommand("copy");
      a.remove();
    }
  }

  function handle_switch_project(id: string) {
    set_show_project_menu(false);
    set_current_project(id).then(() => {
      window.location.href = get_project_url(id);
    });
  }

  async function handle_new_project() {
    const all = await list_projects();
    const default_name = all.length === 0 ? "Demo Project" : "Untitled Project";
    const name = await show_input_modal({
      title: "New Project",
      message: "Enter a name for your new project.",
      placeholder: "Project name",
      default_value: default_name,
    });
    if (name === null) return;
    const id = await create_project(name || undefined);
    await set_current_project(id);
    window.location.href = get_project_url(id);
  }

  async function handle_rename_project() {
    const id = props.store.project_id();
    if (!id) return;
    const name = await show_input_modal({
      title: "Rename Project",
      message: `Rename "${current_project_name()}"`,
      placeholder: "New name",
      default_value: current_project_name(),
    });
    if (name === null || !name.trim()) return;
    await rename_project(id, name.trim());
    set_current_project_name(name.trim());
    await refresh_projects();
  }

  async function handle_delete_project() {
    const id = props.store.project_id();
    if (!id) return;
    const name = current_project_name();
    const confirmed = await show_confirm_modal({
      title: "Delete Project",
      message: `Delete "${name}"? This cannot be undone.`,
      confirm_label: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    set_show_project_menu(false);
    await delete_project(id);
    const all = await list_projects();
    if (all.length > 0) {
      set_current_project(all[0].id).then(() => {
        window.location.href = get_project_url(all[0].id);
      });
    } else {
      const new_id = await create_project();
      window.location.href = get_project_url(new_id);
    }
  }

  async function handle_duplicate_project() {
    const id = props.store.project_id();
    if (!id) return;
    set_show_project_menu(false);
    const new_id = await duplicate_project(id);
    await set_current_project(new_id);
    window.location.href = get_project_url(new_id);
  }

  // close info modal on Escape
  createEffect(() => {
    if (!show_info_modal()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") set_show_info_modal(false);
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  // close logs popover on click outside (interceptor overlay handles iframe clicks)
  function dismiss_logs() {
    if (logs_pinned()) return;
    set_show_logs(false);
    set_logs_auto_opened(false);
  }

  function handle_copy_logs() {
    const text = worker_client.logs().map(e => e.msg).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function handle_clear_logs() {
    worker_client.clear_logs();
  }

  // auto-scroll logs when new entries arrive and popover is open
  createEffect(() => {
    void worker_client.logs();
    if (show_logs() && log_ref) {
      requestAnimationFrame(() => { log_ref!.scrollTop = log_ref!.scrollHeight; });
    }
  });

  // auto-open logs on compile error, auto-close on resolution
  // edge-triggered: only opens on transition TO error, not while error persists
  let prev_log_status: string | undefined;
  createEffect(() => {
    const s = worker_client.status();
    const was = prev_log_status;
    prev_log_status = s;
    if (s === "error" && was !== "error") {
      if (!untrack(show_logs) && !untrack(logs_pinned)) {
        set_logs_auto_opened(true);
        set_show_logs(true);
      }
    } else if ((s === "success" || s === "idle") && was === "error") {
      if (untrack(logs_auto_opened) && !untrack(logs_pinned)) {
        set_show_logs(false);
        set_logs_auto_opened(false);
      }
    }
  });

  // compile success flash
  let status_btn_ref: HTMLButtonElement | undefined;
  createEffect(() => {
    if (worker_client.status() === "success" && status_btn_ref) {
      status_btn_ref.classList.remove("flash-success");
      void status_btn_ref.offsetWidth;
      status_btn_ref.classList.add("flash-success");
    }
  });

  function log_class(entry: LogEntry): string {
    if (entry.cls.includes("error")) return "log-line log-error";
    if (entry.cls.includes("warn")) return "log-line log-warn";
    if (entry.cls.includes("info")) return "log-line log-info";
    return "log-line";
  }

  function status_color(): string {
    const s = worker_client.status();
    if (s === "loading" || s === "compiling") return "var(--yellow)";
    if (s === "success") return "var(--green)";
    if (s === "error") return "var(--red)";
    return "var(--fg-dim)";
  }

  // watch controller is now created in App and passed via props
  const watch = props.watch;

  function handle_compile() {
    const files = { ...props.store.files };
    worker_client.compile({ files, main: props.store.main_file(), mode: "full" });
  }

  // compare content for equality (handles both string and Uint8Array)
  function content_equal(a: string | Uint8Array, b: string | Uint8Array): boolean {
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) { if (a[i] !== b[i]) return false; }
      return true;
    }
    return false;
  }

  // prompt user for how to handle imported files
  async function merge_or_load(incoming: ProjectFiles) {
    const choice = await show_choice_modal({
      title: "Import Files",
      message: "How would you like to import these files?",
      options: [
        { label: "Create new project", value: "new", variant: "primary" },
        { label: "Merge with current", value: "merge", variant: "default" },
        { label: "Replace current", value: "replace", variant: "danger" },
      ],
    });

    if (choice === "new") {
      const name = await show_input_modal({
        title: "New Project",
        message: "Enter a name for the imported project.",
        placeholder: "Project name",
        default_value: "Imported Project",
      });
      if (name === null) return;
      handle_import_as_new_project(incoming, name.trim() || "Imported Project");
      return;
    }

    if (choice === "replace") {
      props.store.load_files(incoming);
      return;
    }

    // choice === "merge" or null (cancelled):
    if (choice === null) return;
    const non_conflicting: ProjectFiles = {};
    const conflicts: ConflictInfo[] = [];

    for (const [name, content] of Object.entries(incoming)) {
      const existing = props.store.files[name];
      if (existing === undefined) {
        non_conflicting[name] = content;
      } else if (content_equal(existing, content)) {
        // same content, skip
      } else {
        conflicts.push({
          path: name,
          eztex_content: existing,
          disk_content: content,
          eztex_hash: "",
          disk_hash: "",
        });
      }
    }

    if (Object.keys(non_conflicting).length > 0) {
      props.store.merge_files(non_conflicting);
    }

    if (conflicts.length > 0 && props.on_upload_conflicts) {
      props.on_upload_conflicts(conflicts);
    }
  }

  async function handle_import_as_new_project(incoming: ProjectFiles, project_name: string) {
    const id = await create_project(project_name);
    await set_current_project(id);

    // save snapshot with the imported files
    const { create_y_project_doc, encode_snapshot: enc_snap, get_or_create_text_file, create_binary_file_ref, set_project_metadata } = await import("../lib/y_project_doc");
    const { save_ydoc_snapshot, save_blob, compute_hash, save_project_manifest, load_catalog, save_catalog } = await import("../lib/project_persist");
    const yp = create_y_project_doc(id, project_name);
    for (const [path, content] of Object.entries(incoming)) {
      if (content instanceof Uint8Array) {
        const hash = await compute_hash(content);
        await save_blob(id, hash, content);
        create_binary_file_ref(yp, path, hash, content.length);
      } else {
        get_or_create_text_file(yp, path, content);
      }
    }

    // detect entry file
    let detected_main: string | undefined;
    const tex_files = Object.entries(incoming).filter(([name, content]) =>
      typeof content === "string" && name.endsWith(".tex")
    );
    const files_with_documentclass = tex_files.filter(([_, content]) =>
      (content as string).includes("\\documentclass")
    );
    if (files_with_documentclass.length === 1) {
      detected_main = files_with_documentclass[0][0];
    } else if (files_with_documentclass.length > 1) {
      const choice = await show_choice_modal({
        title: "Select Entry File",
        message: "Which .tex file is the main entry point for compilation?",
        options: files_with_documentclass.map(([name]) => ({
          label: name,
          value: name,
          variant: "default" as const,
        })),
      });
      if (choice) detected_main = choice;
    } else if (tex_files.length > 0) {
      detected_main = tex_files[0][0];
    } else {
      // no tex files, use first file
      const first = Object.keys(incoming)[0];
      detected_main = first || "main.tex";
    }
    set_project_metadata(yp, { main_file: detected_main });

    await save_ydoc_snapshot(id, enc_snap(yp.doc));

    // update manifest and catalog with detected main_file
    await save_project_manifest(id, {
      version: 2,
      id,
      name: project_name,
      created_at: Date.now(),
      updated_at: Date.now(),
      main_file: detected_main ?? "main.tex",
      ydoc_file: "ydoc.bin",
      blobs_dir: "blobs",
      outputs_dir: "outputs",
    });
    const cat = await load_catalog();
    const entry = cat.projects.find(p => p.id === id);
    if (entry) {
      entry.name = project_name;
      entry.main_file = detected_main ?? "main.tex";
      await save_catalog(cat);
    }

    yp.doc.destroy();

    window.location.href = get_project_url(id);
  }

  async function handle_zip_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const files = await read_zip(file);
      if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No .tex files found in zip." }); return; }
      merge_or_load(files);
    } catch (err: any) {
      await show_alert_modal({ title: "Import Error", message: "Failed to read zip: " + err.message });
    }
    input.value = "";
  }

  async function handle_folder_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file_list = input.files;
    if (!file_list || file_list.length === 0) return;
    const files: ProjectFiles = {};
    for (const file of Array.from(file_list)) {
      const path = file.webkitRelativePath || file.name;
      const parts = path.split("/");
      const name = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
      if (name.startsWith(".") || name.startsWith("__MACOSX")) continue;
      if (is_binary(name)) {
        const buf = await file.arrayBuffer();
        files[name] = new Uint8Array(buf);
      } else if (is_text_ext(name)) {
        files[name] = await file.text();
      }
    }
    if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No supported files found in folder." }); return; }
    merge_or_load(files);
    input.value = "";
  }

  async function handle_file_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file_list = input.files;
    if (!file_list || file_list.length === 0) return;
    const files: ProjectFiles = {};
    for (const file of Array.from(file_list)) {
      const name = file.name;
      if (name.startsWith(".")) continue;
      if (is_binary(name)) {
        const buf = await file.arrayBuffer();
        files[name] = new Uint8Array(buf);
      } else if (is_text_ext(name)) {
        files[name] = await file.text();
      }
    }
    if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No supported files found." }); return; }
    merge_or_load(files);
    input.value = "";
  }

  async function handle_download_zip() {
    const blob = await write_zip(props.store.files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "project.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handle_reset() {
    const confirmed = await show_confirm_modal({
      title: "Reset Everything",
      message: "This will delete all project files and cached bundles. This cannot be undone.",
      confirm_label: "Reset",
      danger: true,
    });
    if (!confirmed) return;
    set_show_info_modal(false);
    worker_client.clear_cache();
    await reset_all_persistence();
    window.location.reload();
  }

  async function handle_download_pdf() {
    const ok = await worker_client.compile_and_wait({
      files: { ...props.store.files },
      main: props.store.main_file(),
      mode: "full",
    });
    if (!ok) return;

    const url = worker_client.pdf_url();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.pdf";
    a.click();
  }

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        <button class="logo-btn" title="About eztex" onClick={() => set_show_info_modal(true)}>
          <Logo />
        </button>
        <AnimatedShow when={show_info_modal()}>
          <div class="info-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) set_show_info_modal(false); }}>
            <div class="info-modal">
              <button class="info-modal-close" onClick={() => set_show_info_modal(false)} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
              <div class="info-modal-logo" innerHTML={logo_svg} />
              <div class="info-modal-name">eztex</div>
              <p class="info-modal-desc">A fast, local-first LaTeX editor that runs entirely in your browser. No server, no signup -- just open and write.</p>
              <div class="info-modal-links">
                <a class="info-modal-link" href="https://github.com/thuvasooriya/eztex" target="_blank" rel="noopener">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                  GitHub
                </a>
                <a class="info-modal-link donate" href="https://github.com/sponsors/thuvasooriya" target="_blank" rel="noopener">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                  Donate
                </a>
              </div>
              <div class="info-modal-divider" />
              <div class="info-modal-actions">
                <button class="info-modal-action" onClick={() => { set_show_info_modal(false); props.on_start_tour?.(); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>
                  </svg>
                  Start tutorial
                </button>
                <Show when={cache_bytes() > 0}>
                  <button
                    class={`info-modal-action ${clearing_cache() ? "clearing" : ""}`}
                    onClick={handle_clear_cache}
                    disabled={clearing_cache()}
                  >
                    <Show
                      when={!clearing_cache()}
                      fallback={
                        <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 12a9 9 0 11-6.2-8.6" />
                        </svg>
                      }
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </Show>
                    Clear cache ({format_cache_size(cache_bytes())})
                  </button>
                </Show>
                <button class="info-modal-action danger" onClick={handle_reset}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                  </svg>
                  Reset everything
                </button>
              </div>
            </div>
          </div>
        </AnimatedShow>
        <div class="upload-menu-wrapper" ref={project_btn_ref}>
        <button
          class="toolbar-project-btn"
          title="Switch project"
          onClick={() => set_show_project_menu(v => !v)}
        >
          <span class="toolbar-project-name">{current_project_name()}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <AnimatedShow when={show_project_menu()}>
          <div class="upload-dropdown project-dropdown">
            <For each={projects()}>
              {(project) => (
                <button
                  class={`upload-dropdown-item ${project.id === props.store.project_id() ? "active-project" : ""}`}
                  onClick={() => handle_switch_project(project.id)}
                >
                  <span class="project-name">{project.name}</span>
                </button>
              )}
            </For>
            <Show when={projects().length > 0}>
              <div class="upload-dropdown-divider" />
            </Show>
            <button class="upload-dropdown-item" onClick={handle_new_project}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Project
            </button>
            <button class="upload-dropdown-item" onClick={() => { set_show_project_menu(false); zip_input_ref?.click(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/></svg>
              Import Project
            </button>
            <Show when={folder_sync().is_supported()}>
              <button class="upload-dropdown-item" onClick={async () => {
                set_show_project_menu(false);
                const confirmed = await show_confirm_modal({
                  title: "Open Local Folder",
                  message: "This will create a new project from the selected folder. The current project will remain unchanged.",
                  confirm_label: "Continue",
                });
                if (!confirmed) return;
                if (folder_sync().state().active) {
                  folder_sync().disconnect();
                }
                const folder_name = await folder_sync().pick_folder();
                if (!folder_name) return;
                const id = await create_project(folder_name);
                await set_current_project(id);
                window.location.href = get_project_url(id);
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/><path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/><path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/></svg>
                Open Folder
              </button>
            </Show>
            <button class="upload-dropdown-item" onClick={() => { set_show_project_menu(false); handle_download_zip(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></svg>
              Export Project
            </button>
            <Show when={show_room_backup_actions()}>
              <button class="upload-dropdown-item" onClick={handle_export_rooms}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export Rooms
              </button>
              <button class="upload-dropdown-item" onClick={() => { set_show_project_menu(false); rooms_backup_input_ref?.click(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Import Rooms
              </button>
              <div class="upload-dropdown-divider" />
            </Show>
            <button class="upload-dropdown-item" onClick={handle_rename_project}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Rename
            </button>
            <button class="upload-dropdown-item" onClick={handle_duplicate_project}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Duplicate
            </button>
            <button class="upload-dropdown-item danger-item" onClick={handle_delete_project}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Delete
            </button>
          </div>
        </AnimatedShow>
      </div>
      <div class="toolbar-divider" />
        <Show when={props.on_toggle_files}>
          <button
            class={`toolbar-toggle ${props.files_visible ? "active" : ""}`}
            onClick={props.on_toggle_files}
            title="Toggle file panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </Show>
        <div class="toolbar-file-actions">
            <div class="upload-menu-wrapper" ref={upload_btn_ref}>
              <button class="toolbar-toggle" title="Upload files or folder" onClick={() => set_show_upload_menu(v => !v)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="17,8 12,3 7,8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
              <AnimatedShow when={show_upload_menu()}>
                <div class="upload-dropdown">
                  <button class="upload-dropdown-item" onClick={() => { file_input_ref?.click(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    Upload Files
                  </button>
                  <button class="upload-dropdown-item" onClick={() => { folder_input_ref?.click(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    Upload Folder
                  </button>
                </div>
              </AnimatedShow>
            </div>
            <div class="upload-menu-wrapper" ref={download_btn_ref}>
              <button class="toolbar-toggle" title="Download" disabled={!worker_client.pdf_url()} onClick={() => set_show_download_menu(v => !v)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7,10 12,15 17,10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
              <AnimatedShow when={show_download_menu()}>
                <div class="upload-dropdown">
                  <Show when={worker_client.pdf_url()}>
                    <button class="upload-dropdown-item" onClick={() => { void handle_download_pdf(); set_show_download_menu(false); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                      Download PDF
                    </button>
                  </Show>
                </div>
              </AnimatedShow>
            </div>
          </div>
        <input ref={zip_input_ref} type="file" accept=".zip" style={{ display: "none" }} onChange={handle_zip_upload} />
        <input ref={file_input_ref} type="file" multiple accept=".tex,.bib,.sty,.cls,.png,.jpg,.jpeg,.gif,.webp,.svg,.ttf,.otf,.woff,.woff2,.pdf" style={{ display: "none" }} onChange={handle_file_upload} />
        <input ref={folder_input_ref} type="file" {...{ webkitdirectory: true } as any} style={{ display: "none" }} onChange={handle_folder_upload} />
        <input ref={rooms_backup_input_ref} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={handle_import_rooms_backup} />
      </div>

      {/* center: reconnect pill (reusable notification area) */}
      <Show when={props.reconnect_folder}>
        <div class="toolbar-center-pill">
          <button class="reconnect-pill-btn" onClick={props.on_reconnect}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Reconnect
          </button>
          <span class="reconnect-pill-text">to <strong>{props.reconnect_folder}/</strong></span>
          <button class="reconnect-pill-dismiss" onClick={props.on_dismiss_reconnect}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </Show>

      <div class="toolbar-right">
        <div class="share-presence" ref={share_presence_ref}>
          <Show when={connected_users().length > 0}>
            <div class="share-avatar-stack avatar-stack" title={`${connected_users().length} collaborator(s)`}>
              <For each={connected_users()}>
                {(user) => (
                  <UserAvatar
                    user_id={user.user_id}
                    display_name={user.display_name}
                    color={user.color}
                    on_click={(e) => handle_select_peer(user, e.currentTarget)}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={selected_peer()}>
            {(peer) => (
              <div class="avatar-popover" style={{ left: `${selected_peer_left()}px` }}>
                <UserAvatar user_id={peer().user_id} display_name={peer().display_name} color={peer().color} />
                <div class="avatar-popover-name">{peer().display_name}</div>
                <div class="avatar-popover-meta">Last active: {format_last_active(peer().last_active_at)}</div>
                <div class="avatar-popover-meta">Currently editing: {peer().current_file ?? "Idle"}</div>
                <div class="avatar-popover-meta">Changes this session: {peer().edit_count}</div>
                <Show when={peer().current_file && peer().current_line}>
                  <button class="avatar-popover-action" onClick={() => handle_jump_to_peer(peer())}>
                    Jump to cursor
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>
        <div class="upload-menu-wrapper" ref={share_btn_ref}>
          <button
            class={`toolbar-toggle ${collab.status() === "connected" ? "active" : ""}`}
            title={collab.status() === "connected" ? "Collaboration active" : "Share project"}
            onClick={() => set_show_share_menu(v => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          </button>
          <AnimatedShow when={show_share_menu()}>
            <div class="upload-dropdown share-dropdown">
              <Show when={!props.store.room_id() && !share_links()}>
                <button class="upload-dropdown-item" onClick={handle_create_room}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  Create Room
                </button>
              </Show>
              <Show when={share_links() || props.store.room_id()}>
                <div class="share-dropdown-status">
                  <span class="share-status-dot" classList={{ connected: collab.status() === "connected" }} />
                  <span class="share-status-text">
                    {collab.status() === "connected" ? "Connected" : collab.status() === "connecting" ? "Connecting..." : "Disconnected"}
                  </span>
                  <Show when={collab.permission() === "read"}>
                    <span class="share-permission-badge">Read-only</span>
                  </Show>
                </div>
                <div class="upload-dropdown-divider" />
                <Show when={share_links() || current_owned_room()}>
                  <button
                    class="upload-dropdown-item"
                    onClick={() => { void handle_copy_write_share_link(); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    Copy Write Link
                  </button>
                </Show>
                <button
                  class="upload-dropdown-item"
                  onClick={() => { void handle_copy_read_share_link(); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Copy Read Link
                </button>
              </Show>
            </div>
          </AnimatedShow>
        </div>
        <Show when={collab.status() === "connected"}>
          <button
            class="toolbar-toggle agent-indicator"
            title="Agent panel"
            onClick={() => props.on_show_agent_panel?.()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 12 2z"/>
              <circle cx="9" cy="14" r="1" fill="currentColor"/>
              <circle cx="15" cy="14" r="1" fill="currentColor"/>
            </svg>
            <Show when={agent_review_store().pending().length > 0}>
              <span class="share-peer-badge agent-pending-badge">{agent_review_store().pending().length}</span>
            </Show>
          </button>
        </Show>
        <div class="compile-group" ref={compile_group_ref}>
          <AnimatedShow when={show_logs()}>
            <Show when={!logs_pinned()}>
              <div class="click-interceptor" onMouseDown={dismiss_logs} />
            </Show>
            <div class="compile-logs-popover">
              <div class="popover-action-bar">
                <button
                  class={`icon-btn popover-pin ${logs_pinned() ? "active" : ""}`}
                  title={logs_pinned() ? "Unpin" : "Pin open"}
                  onClick={() => set_logs_pinned(v => !v)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill={logs_pinned() ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>
                </button>
                <button class="icon-btn" title="Copy all" onClick={handle_copy_logs}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn" title="Clear log" onClick={handle_clear_logs}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
              <div class="compile-logs-scroll" ref={log_ref}>
                <For each={worker_client.logs()}>
                  {(entry) => <div class={log_class(entry)}>{entry.msg}</div>}
                </For>
                <Show when={worker_client.logs().length === 0}>
                  <div class="log-empty">No logs yet.</div>
                </Show>
              </div>
            </div>
          </AnimatedShow>
          <button
            ref={status_btn_ref}
            class={`compile-group-status ${show_logs() ? "expanded" : ""}`}
            onClick={() => { set_show_logs(v => !v); set_logs_auto_opened(false); }}
            title="Show compilation logs"
            style={{ color: status_color() }}
          >
            <span class="compile-group-text">{worker_client.status_text()}</span>
            <Show when={worker_client.last_elapsed()}>
              <span class="compile-group-elapsed">{worker_client.last_elapsed()}</span>
            </Show>
          </button>
          <button
            class={`compile-group-watch ${watch.enabled() ? "active" : ""} ${watch.dirty() ? "dirty" : ""}`}
            onClick={() => watch.toggle()}
            title={watch.enabled() ? "Disable auto-compile" : "Enable auto-compile"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-icon lucide-eye"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button
            class="compile-group-play"
            onClick={handle_compile}
            disabled={!worker_client.ready() || worker_client.compiling()}
            title="Compile"
          >
            <Show
              when={!worker_client.compiling()}
              fallback={<span class="compile-spinner" />}
            >
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>
            </Show>
          </button>
        </div>
        <Show when={props.on_toggle_split}>
          <button
            class={`toolbar-toggle${props.swap_mode ? " muted" : ""}`}
            onClick={props.on_toggle_split}
            title={props.split_dir === "horizontal" ? "Switch to stacked layout" : "Switch to side-by-side layout"}
          >
            <Show
              when={props.split_dir === "horizontal"}
              fallback={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                </svg>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </Show>
          </button>
        </Show>
        <Show when={props.on_toggle_preview}>
          <button
            class={`toolbar-toggle ${props.preview_visible ? "active" : ""}`}
            onClick={props.on_toggle_preview}
            title={props.swap_mode
              ? (props.preview_visible ? "Show editor" : "Show PDF")
              : "Toggle preview"
            }
          >
            <Show
              when={props.swap_mode}
              fallback={
                <Show
                  when={props.split_dir === "vertical"}
                  fallback={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="15" x2="21" y2="15" />
                  </svg>
                </Show>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </Show>
          </button>
        </Show>
      </div>
      <ProgressBar />
    </header>
  );
};

export default Toolbar;
