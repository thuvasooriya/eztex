// conflict resolution dialog -- shows when disk files changed externally during sync
import { type Component, For, Show, createSignal } from "solid-js";
import type { ConflictInfo } from "../lib/local_folder_sync";
import { is_binary } from "../lib/project_store";

type Props = {
  conflicts: ConflictInfo[];
  on_resolve: (path: string, resolution: "eztex" | "disk") => void;
  on_close: () => void;
};

// simple line diff for text content
interface DiffLine {
  type: "add" | "remove" | "same";
  text: string;
}

function compute_diff(disk: string, eztex: string): DiffLine[] {
  const disk_lines = disk.split("\n");
  const eztex_lines = eztex.split("\n");
  const result: DiffLine[] = [];

  // LCS-based diff (simple O(n*m) for small files, capped for performance)
  const max = 2000;
  if (disk_lines.length > max || eztex_lines.length > max) {
    // fallback: show all as removed/added
    for (const line of disk_lines) result.push({ type: "remove", text: line });
    for (const line of eztex_lines) result.push({ type: "add", text: line });
    return result;
  }

  // build LCS table
  const m = disk_lines.length;
  const n = eztex_lines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (disk_lines[i - 1] === eztex_lines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // backtrack
  const diff: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && disk_lines[i - 1] === eztex_lines[j - 1]) {
      diff.push({ type: "same", text: disk_lines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.push({ type: "add", text: eztex_lines[j - 1] });
      j--;
    } else {
      diff.push({ type: "remove", text: disk_lines[i - 1] });
      i--;
    }
  }
  diff.reverse();
  return diff;
}

function format_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ConflictDialog: Component<Props> = (props) => {
  const [current_idx, set_current_idx] = createSignal(0);
  const current = () => props.conflicts[current_idx()];
  const total = () => props.conflicts.length;

  function handle_resolve(resolution: "eztex" | "disk") {
    const c = current();
    if (!c) return;
    props.on_resolve(c.path, resolution);
    if (current_idx() < total() - 1) {
      set_current_idx(i => i + 1);
    } else {
      props.on_close();
    }
  }

  const is_binary_file = () => is_binary(current()?.path ?? "");

  const diff_lines = () => {
    const c = current();
    if (!c || is_binary_file()) return [];
    const disk_text = typeof c.disk_content === "string" ? c.disk_content : "[binary]";
    const eztex_text = typeof c.eztex_content === "string" ? c.eztex_content : "[binary]";
    return compute_diff(disk_text, eztex_text);
  };

  return (
    <div class="conflict-overlay">
      <div class="conflict-dialog">
        <div class="conflict-header">
          <span class="conflict-title">Conflict detected</span>
          <span class="conflict-count">{current_idx() + 1} / {total()}</span>
          <button class="conflict-close" onClick={props.on_close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="conflict-path">{current()?.path}</div>
        <div class="conflict-description">
          This file was modified on disk since your last sync. Choose which version to keep.
        </div>

        <Show when={!is_binary_file()}>
          <div class="conflict-diff">
            <For each={diff_lines()}>
              {(line) => (
                <div class={`diff-line diff-${line.type}`}>
                  <span class="diff-marker">
                    {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                  </span>
                  <span class="diff-text">{line.text || "\u00A0"}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={is_binary_file()}>
          <div class="conflict-binary-info">
            <div class="conflict-binary-row">
              <span class="conflict-binary-label">Disk version:</span>
              <span class="conflict-binary-size">
                {format_size(current()?.disk_content instanceof Uint8Array ? current()!.disk_content.length : new TextEncoder().encode(current()?.disk_content as string ?? "").length)}
              </span>
            </div>
            <div class="conflict-binary-row">
              <span class="conflict-binary-label">eztex version:</span>
              <span class="conflict-binary-size">
                {format_size(current()?.eztex_content instanceof Uint8Array ? current()!.eztex_content.length : new TextEncoder().encode(current()?.eztex_content as string ?? "").length)}
              </span>
            </div>
          </div>
        </Show>

        <div class="conflict-actions">
          <button class="conflict-btn conflict-btn-disk" onClick={() => handle_resolve("disk")}>
            Keep disk version
          </button>
          <button class="conflict-btn conflict-btn-eztex" onClick={() => handle_resolve("eztex")}>
            Keep eztex version
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConflictDialog;
