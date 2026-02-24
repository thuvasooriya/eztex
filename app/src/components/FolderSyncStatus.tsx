// folder sync status indicator -- shows sync state in the toolbar area
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

  const status_text = createMemo(() => {
    if (props.state.error) return "Sync error";
    if (props.state.syncing) return "Syncing...";
    const n = props.state.dirty_files.size;
    if (n > 0) return `${n} pending`;
    return "Synced";
  });

  const dot_color = createMemo(() => {
    if (props.state.error) return "var(--red)";
    if (props.state.syncing) return "var(--yellow)";
    if (props.state.dirty_files.size > 0) return "var(--yellow)";
    return "var(--green)";
  });

  return (
    <div class={`folder-sync-status ${status_class()}`} title={
      props.state.error
        ? props.state.error
        : `Synced to ${props.state.folder_name}/`
    }>
      <span class="folder-sync-dot" style={{ background: dot_color() }} />
      {/* folder icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
      </svg>
      <span class="folder-sync-text">{status_text()}</span>
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
