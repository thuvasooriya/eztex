// folder sync status indicator -- shows sync state at top of file panel
import { type Component, Show, createMemo } from "solid-js";
import type { LocalSyncState } from "../lib/local_folder_sync";

type Props = {
  state: LocalSyncState;
  on_disconnect?: () => void;
};

const FolderSyncStatus: Component<Props> = (props) => {
  const status_class = createMemo(() => {
    if (props.state.error) return "folder-sync-error";
    if (props.state.syncing) return "folder-sync-syncing";
    if (props.state.dirty_files.size > 0) return "folder-sync-dirty";
    return "folder-sync-ok";
  });

  const icon_color = createMemo(() => {
    if (props.state.error) return "var(--red)";
    if (props.state.syncing) return "var(--yellow)";
    if (props.state.dirty_files.size > 0) return "var(--yellow)";
    return "var(--green)";
  });

  const dirty_count = createMemo(() => props.state.dirty_files.size);

  const tooltip = createMemo(() => {
    if (props.state.error) return `Sync error: ${props.state.error}`;
    if (props.state.syncing) return "Syncing...";
    const n = dirty_count();
    if (n > 0) return `${n} file${n > 1 ? "s" : ""} pending sync`;
    return `Synced to ${props.state.folder_name}/`;
  });

  return (
    <div class={`folder-sync-status ${status_class()}`} title={tooltip()}>
      {/* sync icon with state color */}
      <Show
        when={!props.state.syncing}
        fallback={
          <svg class="folder-sync-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={icon_color()} stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        }
      >
        <Show
          when={!props.state.error}
          fallback={
            <svg class="folder-sync-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={icon_color()} stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          }
        >
          <svg class="folder-sync-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={icon_color()} stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </Show>
      </Show>
      {/* folder name truncated */}
      <span class="folder-sync-name">{props.state.folder_name}/</span>
      {/* dirty count badge */}
      <Show when={dirty_count() > 0}>
        <span class="folder-sync-badge">{dirty_count()}</span>
      </Show>
      <Show when={props.on_disconnect}>
        <button
          class="folder-sync-disconnect"
          onClick={props.on_disconnect}
          title="Disconnect folder"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </Show>
    </div>
  );
};

export default FolderSyncStatus;
