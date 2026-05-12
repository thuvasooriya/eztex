import { type Component, Show, For, onCleanup, onMount, createSignal, createEffect, createMemo, type Setter } from "solid-js";
import ProgressBar from "./ProgressBar";
import ToolbarFileActions from "./ToolbarFileActions";
import ProjectMenu from "./ProjectMenu";
import SettingsModal from "./SettingsModal";
import ShareMenu from "./ShareMenu";
import ToolbarLogs from "./ToolbarLogs";
import UserAvatar from "./UserAvatar";
import { worker_client } from "../lib/worker_client";
import { use_app_context } from "../lib/app_context";
import type { ProjectStore } from "../lib/project_store";
import { clear_bundle_cache, reset_all_persistence, ProjectRepository, type ProjectCatalogEntry } from "../lib/project_repository";
import { get_or_create_identity } from "../lib/identity";
import { get_jjk_name } from "../lib/jjk_names";
import type { RoomRegistry } from "../lib/room_registry";
import type { ConflictInfo } from "../lib/local_folder_sync";
import type { CompileScheduler } from "../lib/compile_scheduler";
import type { AppSettings } from "../lib/settings_store";
import logo_svg from "/logo.svg?raw";
import { show_input_modal, show_confirm_modal, show_choice_modal, show_alert_modal } from "../lib/modal_store";

type Props = {
  store: ProjectStore;
  room_registry: RoomRegistry;
  watch: CompileScheduler;
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
  settings: AppSettings;
  on_update_setting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  register_file_triggers?: (file_fn: () => void, folder_fn: () => void, zip_fn: () => void) => void;
  on_show_agent_panel?: () => void;
  on_switch_project?: (id: string) => Promise<void>;
  on_delete_project?: (id: string) => Promise<void>;
  on_before_reset_all?: () => Promise<void>;
  get_folder_sync?: () => import("../lib/local_folder_sync").LocalFolderSync | null;
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

const version_info = { version: "", commit: "", built: "" };

const Toolbar: Component<Props> = (props) => {
  const app = use_app_context();
  const folder_sync = () => props.get_folder_sync?.() ?? null;
  const collab = app.collab;
  const agent_review_store = () => app.agent_review_store;
  const local_identity = get_or_create_identity();
  const _repo = new ProjectRepository();

  let share_presence_ref: HTMLDivElement | undefined;
  let project_btn_ref: HTMLDivElement | undefined;
  let share_btn_ref: HTMLDivElement | undefined;
  let cleanup_compile_persist: (() => void) | undefined;
  let cleanup_clock: ReturnType<typeof setInterval> | undefined;
  let import_project_from_zip = () => {};
  let export_project_zip = () => {};

  const [show_project_menu, set_show_project_menu] = createSignal(false);
  const [show_share_menu, set_show_share_menu] = createSignal(false);
  const [active_tab, set_active_tab] = createSignal<"about" | "settings">("about");
  const [selected_peer_id, set_selected_peer_id] = createSignal<string | null>(null);
  const [selected_peer_left, set_selected_peer_left] = createSignal(0);
  const [projects, set_projects] = createSignal<ProjectCatalogEntry[]>([]);
  const [current_project_name, set_current_project_name] = createSignal("");
  const [awareness_revision, set_awareness_revision] = createSignal(0);
  const [clock_now, set_clock_now] = createSignal(Date.now());

  const show_info_modal = () => props.show_info_modal;
  const set_show_info_modal = props.set_show_info_modal;
  const show_logs = () => props.show_logs;
  const set_show_logs = props.set_show_logs;
  const watch = props.watch;

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

  onMount(() => {
    cleanup_compile_persist = worker_client.on_compile_done(() => {
      const url = worker_client.pdf_url();
      if (!url) return;
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          const pid = props.store.project_id();
          if (pid) _repo.save_pdf(bytes, pid).catch(() => {});
          const fs = folder_sync();
          if (fs && fs.state().active) {
            fs.write_pdf(bytes).catch(() => {});
          }
        })
        .catch(() => {});
    });
    cleanup_clock = setInterval(() => set_clock_now(Date.now()), 30000);
  });

  onCleanup(() => {
    cleanup_compile_persist?.();
    if (cleanup_clock !== undefined) clearInterval(cleanup_clock);
  });

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

  async function refresh_projects() {
    const entries = await _repo.list_projects();
    set_projects(entries);
    const current = entries.find((p) => p.id === props.store.project_id());
    set_current_project_name(current?.name ?? "Untitled Project");
  }

  onMount(() => {
    void refresh_projects();
  });

  createEffect(() => {
    props.store.project_id();
    void refresh_projects();
  });

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

  function handle_switch_project(id: string) {
    set_show_project_menu(false);
    void props.on_switch_project?.(id);
  }

  async function handle_new_project() {
    const all = await _repo.list_projects();
    const default_name = all.length === 0 ? "Demo Project" : "Untitled Project";
    const name = await show_input_modal({
      title: "New Project",
      message: "Enter a name for your new project.",
      placeholder: "Project name",
      default_value: default_name,
    });
    if (name === null) return;
    const record = await _repo.create_project(name || undefined);
    await _repo.set_current_project(record.id);
    if (props.on_switch_project) {
      await props.on_switch_project(record.id);
    }
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
    await _repo.rename_project(id, name.trim());
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
    if (props.on_delete_project) {
      await props.on_delete_project(id);
    } else {
      await _repo.delete_project(id);
    }
    const all = await _repo.list_projects();
    if (all.length > 0) {
      if (props.on_switch_project) {
        await props.on_switch_project(all[0].id);
      }
    } else {
      const record = await _repo.create_project();
      if (props.on_switch_project) {
        await props.on_switch_project(record.id);
      }
    }
  }

  async function handle_duplicate_project() {
    const id = props.store.project_id();
    if (!id) return;
    set_show_project_menu(false);
    const new_id = await _repo.duplicate_project(id);
    await _repo.set_current_project(new_id);
    if (props.on_switch_project) {
      await props.on_switch_project(new_id);
    }
  }

  async function handle_open_folder_project() {
    set_show_project_menu(false);
    const confirmed = await show_confirm_modal({
      title: "Open Local Folder",
      message: "This will create a new project from the selected folder. The current project will remain unchanged.",
      confirm_label: "Continue",
    });
    if (!confirmed) return;
    const fs = folder_sync();
    if (fs && fs.state().active) {
      fs.disconnect();
    }
    const folder_name = fs ? await fs.pick_folder() : null;
    if (!folder_name) return;
    const record = await _repo.create_project(folder_name);
    await _repo.set_current_project(record.id);
    if (props.on_switch_project) {
      await props.on_switch_project(record.id);
    }
  }

  function handle_compile() {
    const files = { ...props.store.files };
    worker_client.compile({ files, main: props.store.main_file(), mode: "full" });
  }

  async function handle_clear_cache() {
    try {
      worker_client.clear_cache();
      await clear_bundle_cache();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear cached files.";
      await show_alert_modal({ title: "Clear Cache Failed", message });
    }
  }

  async function handle_reset() {
    const confirmed = await show_confirm_modal({
      title: "Reset Everything",
      message: "Delete all projects, room data, cached files, and settings. This is irreversible.",
      confirm_label: "Reset",
      danger: true,
    });
    if (!confirmed) return;
    set_show_info_modal(false);
    try {
      worker_client.clear_cache();
      await props.on_before_reset_all?.();
      await reset_all_persistence();
      const url = new URL("/", window.location.origin);
      window.location.assign(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reset local data.";
      await show_alert_modal({ title: "Reset Failed", message });
    }
  }

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        <button class="logo-btn" title="Settings" onClick={() => { set_active_tab("about"); set_show_info_modal(true); }}>
          <Logo />
        </button>
        <SettingsModal
          show={show_info_modal()}
          on_close={() => set_show_info_modal(false)}
          active_tab={active_tab()}
          on_tab_change={set_active_tab}
          settings={props.settings}
          on_update_setting={props.on_update_setting}
          on_clear_cache={handle_clear_cache}
          on_reset_all={handle_reset}
          version_info={version_info}
          on_start_tour={props.on_start_tour}
        />
        <div class="upload-menu-wrapper" ref={project_btn_ref}>
          <button
            class="toolbar-project-btn"
            title="Switch project"
            onClick={() => set_show_project_menu(v => !v)}
          >
            <span class="toolbar-project-name">{current_project_name()}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <ProjectMenu
            show={show_project_menu()}
            on_close={() => set_show_project_menu(false)}
            projects={projects()}
            current_project_id={props.store.project_id()}
            on_switch={handle_switch_project}
            on_new={() => { void handle_new_project(); }}
            on_rename={() => { void handle_rename_project(); }}
            on_duplicate={() => { void handle_duplicate_project(); }}
            on_delete={() => { void handle_delete_project(); }}
            on_import={() => { set_show_project_menu(false); import_project_from_zip(); }}
            on_export={() => { set_show_project_menu(false); export_project_zip(); }}
            can_open_folder={folder_sync()?.is_supported()}
            on_open_folder={() => { void handle_open_folder_project(); }}
          />
        </div>
        <div class="toolbar-divider" />
        <Show when={props.on_toggle_files}>
          <button
            class={`toolbar-toggle ${props.files_visible ? "active" : ""}`}
            onClick={props.on_toggle_files}
            title="Toggle file panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
          </button>
        </Show>
        <ToolbarFileActions
          store={props.store}
          folder_sync={folder_sync}
          on_upload_conflicts={props.on_upload_conflicts}
          on_switch_project={props.on_switch_project}
          register_file_triggers={props.register_file_triggers}
          register_project_actions={(import_fn, export_fn) => {
            import_project_from_zip = import_fn;
            export_project_zip = export_fn;
          }}
        />
      </div>

      <Show when={props.reconnect_folder}>
        <div class="toolbar-center-pill">
          <button class="reconnect-pill-btn" onClick={props.on_reconnect}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            Reconnect
          </button>
          <span class="reconnect-pill-text">to <strong>{props.reconnect_folder}/</strong></span>
          <button class="reconnect-pill-dismiss" onClick={props.on_dismiss_reconnect}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
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
            aria-haspopup="menu"
            aria-expanded={show_share_menu()}
            onClick={() => set_show_share_menu(v => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
          </button>
          <ShareMenu
            show={show_share_menu()}
            on_close={() => set_show_share_menu(false)}
            store={props.store}
            room_registry={props.room_registry}
            on_alert={(title, message) => { void show_alert_modal({ title, message }); }}
            on_input={show_input_modal}
            on_confirm={show_confirm_modal}
            on_choice={show_choice_modal}
          />
        </div>
        <Show when={collab.status() === "connected"}>
          <button
            class="toolbar-toggle agent-indicator"
            title="Agent panel"
            onClick={() => props.on_show_agent_panel?.()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 12 2z"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/></svg>
            <Show when={agent_review_store().pending().length > 0}>
              <span class="share-peer-badge agent-pending-badge">{agent_review_store().pending().length}</span>
            </Show>
          </button>
        </Show>
        <div class="compile-group">
          <ToolbarLogs logs={worker_client.logs()} show={show_logs()} on_toggle={() => set_show_logs(v => !v)} />
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
            <Show when={!worker_client.compiling()} fallback={<span class="compile-spinner" />}>
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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="12" x2="21" y2="12" /></svg>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="15" x2="21" y2="15" /></svg>
                </Show>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
            </Show>
          </button>
        </Show>
      </div>
      <ProgressBar />
    </header>
  );
};

export default Toolbar;
