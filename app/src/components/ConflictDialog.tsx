// conflict resolution dialog -- shows when disk files changed externally during sync
// supports per-hunk line selection for text files
import { type Component, For, Show, createSignal, createMemo } from "solid-js";
import type { ConflictInfo } from "../lib/local_folder_sync";
import type { FileContent } from "../lib/project_store";
import { is_binary } from "../lib/project_store";

type Props = {
  conflicts: ConflictInfo[];
  on_resolve: (path: string, resolution: "eztex" | "disk") => void;
  on_resolve_merged?: (path: string, content: FileContent) => void;
  on_close: () => void;
};

// diff types
interface DiffLine {
  type: "add" | "remove" | "same";
  text: string;
}

interface Hunk {
  // context lines before the change
  context_before: string[];
  // the changed lines from disk (remove) and eztex (add)
  disk_lines: string[];
  eztex_lines: string[];
  // context lines after the change
  context_after: string[];
}

const CONTEXT_LINES = 2;

function compute_diff(disk: string, eztex: string): DiffLine[] {
  const disk_lines = disk.split("\n");
  const eztex_lines = eztex.split("\n");

  const max = 2000;
  if (disk_lines.length > max || eztex_lines.length > max) {
    const result: DiffLine[] = [];
    for (const line of disk_lines) result.push({ type: "remove", text: line });
    for (const line of eztex_lines) result.push({ type: "add", text: line });
    return result;
  }

  // LCS table
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

// group diff lines into hunks with context
function extract_hunks(diff: DiffLine[]): Hunk[] {
  // find runs of changed lines (add/remove) and their surrounding context
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < diff.length) {
    // skip unchanged lines until we find a change
    if (diff[i].type === "same") { i++; continue; }

    // collect context before (up to CONTEXT_LINES)
    const ctx_start = Math.max(0, i - CONTEXT_LINES);
    const context_before: string[] = [];
    for (let c = ctx_start; c < i; c++) {
      if (diff[c].type === "same") context_before.push(diff[c].text);
    }

    // collect the changed region
    const disk_lines: string[] = [];
    const eztex_lines: string[] = [];
    while (i < diff.length && diff[i].type !== "same") {
      if (diff[i].type === "remove") disk_lines.push(diff[i].text);
      else eztex_lines.push(diff[i].text);
      i++;
    }

    // collect context after (up to CONTEXT_LINES)
    const context_after: string[] = [];
    for (let c = 0; c < CONTEXT_LINES && i + c < diff.length; c++) {
      if (diff[i + c].type === "same") context_after.push(diff[i + c].text);
      else break;
    }

    hunks.push({ context_before, disk_lines, eztex_lines, context_after });
  }

  return hunks;
}

// reconstruct merged content from hunk selections
// "disk" means keep disk_lines (remove), "eztex" means keep eztex_lines (add)
function build_merged(diff: DiffLine[], selections: ("disk" | "eztex")[]): string {
  const result: string[] = [];
  let hunk_idx = 0;
  let i = 0;

  while (i < diff.length) {
    if (diff[i].type === "same") {
      result.push(diff[i].text);
      i++;
      continue;
    }

    // we're at a change region - find its extent
    const sel = hunk_idx < selections.length ? selections[hunk_idx] : "eztex";
    hunk_idx++;

    // collect the change region
    const disk_lines: string[] = [];
    const eztex_lines: string[] = [];
    while (i < diff.length && diff[i].type !== "same") {
      if (diff[i].type === "remove") disk_lines.push(diff[i].text);
      else eztex_lines.push(diff[i].text);
      i++;
    }

    if (sel === "disk") {
      result.push(...disk_lines);
    } else {
      result.push(...eztex_lines);
    }
  }

  return result.join("\n");
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

  const is_binary_file = () => is_binary(current()?.path ?? "");

  const diff = createMemo(() => {
    const c = current();
    if (!c || is_binary_file()) return [];
    const disk_text = typeof c.disk_content === "string" ? c.disk_content : "[binary]";
    const eztex_text = typeof c.eztex_content === "string" ? c.eztex_content : "[binary]";
    return compute_diff(disk_text, eztex_text);
  });

  const hunks = createMemo(() => extract_hunks(diff()));

  // per-hunk selection state: "disk" or "eztex" for each hunk
  const [selections, set_selections] = createSignal<("disk" | "eztex")[]>([]);

  // re-initialize selections when conflict changes
  const init_selections = createMemo(() => {
    const h = hunks();
    return h.map(() => "eztex" as "disk" | "eztex");
  });

  // keep selections in sync with hunks
  const current_selections = () => {
    const inited = init_selections();
    const sel = selections();
    if (sel.length === inited.length) return sel;
    return inited;
  };

  function set_hunk_selection(idx: number, choice: "disk" | "eztex") {
    const prev = current_selections();
    const next = [...prev];
    next[idx] = choice;
    set_selections(next);
  }

  function set_all(choice: "disk" | "eztex") {
    const h = hunks();
    set_selections(h.map(() => choice));
  }

  function handle_resolve_simple(resolution: "eztex" | "disk") {
    const c = current();
    if (!c) return;
    props.on_resolve(c.path, resolution);
    advance();
  }

  function handle_apply_merged() {
    const c = current();
    if (!c || is_binary_file()) return;
    const merged = build_merged(diff(), current_selections());
    if (props.on_resolve_merged) {
      props.on_resolve_merged(c.path, merged);
    } else {
      // fallback: treat as eztex
      props.on_resolve(c.path, "eztex");
    }
    advance();
  }

  function advance() {
    set_selections([]);
    if (current_idx() < total() - 1) {
      set_current_idx(i => i + 1);
    } else {
      props.on_close();
    }
  }

  // check if all hunks are same side (for showing "Apply merged" vs simple buttons)
  const all_same_side = () => {
    const sel = current_selections();
    if (sel.length === 0) return true;
    const first = sel[0];
    return sel.every(s => s === first);
  };

  const selected_side = () => {
    const sel = current_selections();
    return sel.length > 0 ? sel[0] : "eztex";
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
          This file was modified externally. Choose which version to keep for each change, or accept all from one side.
        </div>

        <Show when={!is_binary_file() && hunks().length > 0}>
          <div class="conflict-diff">
            <For each={hunks()}>
              {(hunk, idx) => {
                const sel = () => current_selections()[idx()];
                return (
                  <div class="conflict-hunk">
                    {/* context before */}
                    <For each={hunk.context_before}>
                      {(line) => (
                        <div class="diff-line diff-same">
                          <span class="diff-marker">{" "}</span>
                          <span class="diff-text">{line || "\u00A0"}</span>
                        </div>
                      )}
                    </For>

                    {/* change region with selection toggle */}
                    <div class={`hunk-change ${sel() === "disk" ? "hunk-sel-disk" : "hunk-sel-eztex"}`}>
                      <div class="hunk-toggle">
                        <button
                          class={`hunk-toggle-btn ${sel() === "disk" ? "active" : ""}`}
                          onClick={() => set_hunk_selection(idx(), "disk")}
                          title="Use disk version"
                        >disk</button>
                        <button
                          class={`hunk-toggle-btn ${sel() === "eztex" ? "active" : ""}`}
                          onClick={() => set_hunk_selection(idx(), "eztex")}
                          title="Use eztex version"
                        >eztex</button>
                      </div>

                      <Show when={hunk.disk_lines.length > 0}>
                        <div class={`hunk-side hunk-disk ${sel() === "disk" ? "" : "hunk-dimmed"}`}>
                          <For each={hunk.disk_lines}>
                            {(line) => (
                              <div class="diff-line diff-remove">
                                <span class="diff-marker">-</span>
                                <span class="diff-text">{line || "\u00A0"}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      <Show when={hunk.eztex_lines.length > 0}>
                        <div class={`hunk-side hunk-eztex ${sel() === "eztex" ? "" : "hunk-dimmed"}`}>
                          <For each={hunk.eztex_lines}>
                            {(line) => (
                              <div class="diff-line diff-add">
                                <span class="diff-marker">+</span>
                                <span class="diff-text">{line || "\u00A0"}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>

                    {/* context after */}
                    <For each={hunk.context_after}>
                      {(line) => (
                        <div class="diff-line diff-same">
                          <span class="diff-marker">{" "}</span>
                          <span class="diff-text">{line || "\u00A0"}</span>
                        </div>
                      )}
                    </For>

                    <Show when={idx() < hunks().length - 1}>
                      <div class="hunk-separator" />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={!is_binary_file() && hunks().length === 0 && diff().length === 0}>
          <div class="conflict-description" style={{ "padding-top": "0" }}>
            Files appear identical (no visible differences).
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
          <button class="conflict-btn conflict-btn-disk" onClick={() => {
            if (is_binary_file() || hunks().length === 0) {
              handle_resolve_simple("disk");
            } else {
              set_all("disk");
            }
          }}>
            Keep disk
          </button>
          <button class="conflict-btn conflict-btn-eztex" onClick={() => {
            if (is_binary_file() || hunks().length === 0) {
              handle_resolve_simple("eztex");
            } else {
              set_all("eztex");
            }
          }}>
            Keep eztex
          </button>
          <Show when={!is_binary_file() && hunks().length > 0}>
            <button class="conflict-btn conflict-btn-apply" onClick={handle_apply_merged}>
              {all_same_side()
                ? `Apply (${selected_side()})`
                : `Apply merged`}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default ConflictDialog;
