import { type Component, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import { use_app_context } from "../lib/app_context";
import { get_collab_ws_url } from "../lib/collab_config";
import { bind_project_to_room, close_room, create_room_links, delete_room as delete_shared_room, download_rooms_backup, get_exportable_room_count, get_owned_room, get_owned_room_links, load_rooms_backup_from_file, type OwnedRoom } from "../lib/collab_share";
import type { ProjectStore } from "../lib/project_store";
import { ProjectRepository } from "../lib/project_repository";
import type { RoomRegistry } from "../lib/room_registry";

export type InputModalOptions = {
  title: string;
  message?: string;
  placeholder?: string;
  default_value?: string;
};

export type ConfirmModalOptions = {
  title: string;
  message?: string;
  confirm_label?: string;
  cancel_label?: string;
  danger?: boolean;
};

export type ChoiceModalOptions = {
  title: string;
  message?: string;
  options: Array<{ label: string; value: string; variant?: "default" | "primary" | "danger" }>;
};

type Props = {
  show: boolean;
  on_close: () => void;
  store: ProjectStore;
  room_registry: RoomRegistry;
  on_alert: (title: string, message: string) => void;
  on_input: (opts: InputModalOptions) => Promise<string | null>;
  on_confirm: (opts: ConfirmModalOptions) => Promise<boolean>;
  on_choice: (opts: ChoiceModalOptions) => Promise<string | null>;
};

async function handle_copy_link(url: string) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    document.body.appendChild(a);
    document.execCommand("copy");
    a.remove();
  }
}

const ShareMenu: Component<Props> = (props) => {
  const collab = use_app_context().collab;
  const repo = new ProjectRepository();
  const [creating_room, set_creating_room] = createSignal(false);
  const [copied_link, set_copied_link] = createSignal<string | null>(null);
  const [share_links, set_share_links] = createSignal<{ room_id: string; write_url: string; read_url: string } | null>(null);
  const [exportable_room_count, set_exportable_room_count] = createSignal(0);
  const [current_owned_room, set_current_owned_room] = createSignal<OwnedRoom | null>(null);
  let rooms_backup_input_ref: HTMLInputElement | undefined;
  let copied_link_timer: ReturnType<typeof setTimeout> | undefined;

  const can_export_rooms = createMemo(() => exportable_room_count() > 0);

  onCleanup(() => {
    if (copied_link_timer !== undefined) clearTimeout(copied_link_timer);
  });

  function flash_copied(kind: "write" | "read") {
    set_copied_link(kind);
    if (copied_link_timer !== undefined) clearTimeout(copied_link_timer);
    copied_link_timer = setTimeout(() => set_copied_link(null), 2000);
  }

  async function refresh_exportable_room_count() {
    try {
      set_exportable_room_count(await get_exportable_room_count(props.room_registry));
    } catch {
      set_exportable_room_count(0);
    }
  }

  createEffect(() => {
    const room_id = props.store.room_id();
    const links = share_links();
    if (links && links.room_id !== room_id) {
      set_share_links(null);
    }
    if (!room_id) {
      set_current_owned_room(null);
      return;
    }
    let active = true;
    get_owned_room(props.room_registry, room_id).then((room) => {
      if (active) set_current_owned_room(room);
    }).catch(() => {
      if (active) set_current_owned_room(null);
    });
    onCleanup(() => { active = false; });
  });

  createEffect(() => {
    if (props.show) void refresh_exportable_room_count();
  });

  async function handle_create_room() {
    const pid = props.store.project_id();
    if (!pid) return;
    set_creating_room(true);
    try {
      const project = await repo.get_project(pid);
      const links = await create_room_links(props.room_registry, pid, project?.name ?? "Untitled Project");
      await bind_project_to_room(props.room_registry, pid, links.room_id);
      set_share_links({ room_id: links.room_id, write_url: links.write_url, read_url: links.read_url });
      props.store.set_room_id(links.room_id);
      await refresh_exportable_room_count();
    } finally {
      set_creating_room(false);
    }
  }

  async function handle_close_room() {
    const room_id = props.store.room_id();
    if (!room_id) return;
    const confirmed = await props.on_confirm({
      title: "Close Room Locally",
      message: "This removes the room secret from this browser and disconnects this project from the shared room. The room stays online and collaborators keep access. You can regain ownership only from an exported room backup.",
      confirm_label: "Close Locally",
    });
    if (!confirmed) return;
    const closed = await close_room(props.room_registry, room_id);
    if (!closed) return;
    props.store.set_room_id(undefined);
    set_share_links(null);
    await refresh_exportable_room_count();
    props.on_close();
  }

  async function handle_delete_room() {
    const room_id = props.store.room_id();
    if (!room_id) return;
    const confirmed = await props.on_confirm({
      title: "Delete Shared Room",
      message: "This permanently deletes the collaboration room from the server, disconnects all collaborators, and makes existing share links unusable. Your local project files stay on this device. This cannot be undone.",
      confirm_label: "Delete Room",
      danger: true,
    });
    if (!confirmed) return;

    const result = await delete_shared_room(props.room_registry, room_id, get_collab_ws_url(room_id));
    if (result.ok) {
      props.store.set_room_id(undefined);
      set_share_links(null);
      await refresh_exportable_room_count();
      props.on_close();
      return;
    }

    props.on_alert("Delete Failed", result.message);
  }

  async function handle_copy_write_share_link() {
    const room_id = props.store.room_id();
    const local_links = share_links();
    const links = local_links?.room_id === room_id ? local_links : room_id ? await get_owned_room_links(props.room_registry, room_id) : null;
    if (links) {
      await handle_copy_link(links.write_url);
      flash_copied("write");
      return;
    }
    props.on_alert("Write Link Unavailable", "This browser does not have the room secret for generating a write link.");
  }

  async function handle_copy_read_share_link() {
    const room_id = props.store.room_id();
    const local_links = share_links();
    const links = local_links?.room_id === room_id ? local_links : room_id ? await get_owned_room_links(props.room_registry, room_id) : null;
    const url = links?.read_url ?? window.location.href;
    await handle_copy_link(url);
    flash_copied("read");
  }

  async function handle_export_rooms() {
    props.on_close();
    await download_rooms_backup(props.room_registry);
  }

  async function handle_import_rooms_backup(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const result = await load_rooms_backup_from_file(props.room_registry, file);
      props.on_alert("Rooms Imported", `Imported ${result.imported} room(s). Skipped ${result.skipped}.`);
      await refresh_exportable_room_count();
      const room_id = props.store.room_id();
      if (room_id) {
        try {
          set_current_owned_room(await get_owned_room(props.room_registry, room_id));
        } catch {
          set_current_owned_room(null);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to import room backup.";
      props.on_alert("Import Error", message);
    }

    input.value = "";
  }

  return (
    <>
      <AnimatedShow when={props.show}>
        <div class="upload-dropdown share-dropdown" role="menu" aria-label="Share project">
          <Show when={!props.store.room_id()}>
            <button class="upload-dropdown-item" role="menuitem" onClick={() => { void handle_create_room(); }} disabled={creating_room()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              {creating_room() ? "Creating Room..." : "Create Room"}
            </button>
            <div class="upload-dropdown-divider" role="separator" />
          </Show>
          <Show when={props.store.room_id()}>
            <div class="share-dropdown-status">
              <span class="share-status-dot" classList={{ connected: collab.status() === "connected" }} />
              <span class="share-status-text">
                {collab.status() === "deleted" ? "Room deleted" : collab.status() === "connected" ? "Connected" : collab.status() === "connecting" ? "Connecting..." : "Disconnected"}
              </span>
              <Show when={collab.permission() === "read"}>
                <span class="share-permission-badge">Read-only</span>
              </Show>
            </div>
            <div class="upload-dropdown-divider" role="separator" />
            <Show when={(share_links()?.room_id === props.store.room_id() && share_links()) || current_owned_room()}>
              <button
                class="upload-dropdown-item"
                role="menuitem"
                onClick={() => { void handle_copy_write_share_link(); }}
              >
                <Show when={copied_link() !== "write"} fallback={(
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Copied!
                  </>
                )}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copy Write Link
                </Show>
              </button>
            </Show>
            <button
              class="upload-dropdown-item"
              role="menuitem"
              onClick={() => { void handle_copy_read_share_link(); }}
            >
              <Show when={copied_link() !== "read"} fallback={(
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied!
                </>
              )}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Copy Read Link
              </Show>
            </button>
            <Show when={props.store.room_id() && current_owned_room()}>
              <div class="upload-dropdown-divider" role="separator" />
              <button class="upload-dropdown-item" role="menuitem" onClick={() => { void handle_close_room(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
                Close Room
              </button>
              <button class="upload-dropdown-item danger-item" role="menuitem" onClick={() => { void handle_delete_room(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
                Delete Room
              </button>
            </Show>
            <div class="upload-dropdown-divider" role="separator" />
          </Show>
          <button
            class="upload-dropdown-item"
            role="menuitem"
            onClick={handle_export_rooms}
            disabled={!can_export_rooms()}
            title={can_export_rooms() ? "Export owned room backup" : "No owned rooms to export"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export Rooms
          </button>
          <button class="upload-dropdown-item" role="menuitem" onClick={() => { props.on_close(); rooms_backup_input_ref?.click(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Import Rooms
          </button>
        </div>
      </AnimatedShow>
      <input ref={rooms_backup_input_ref} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={handle_import_rooms_backup} />
    </>
  );
};

export default ShareMenu;
