import { type Component, For, Show, createSignal, createEffect, onCleanup, type JSX } from "solid-js";
import type { ProjectStore } from "../lib/project_store";
import { is_binary } from "../lib/project_store";
import { build_tree, collect_folder_paths, auto_suffix, type TreeNode } from "../lib/file_tree";
import type { LocalFolderSync } from "../lib/local_folder_sync";
import FolderSyncStatus from "./FolderSyncStatus";

function file_icon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "tex": case "dtx": return "T";
    case "bib": case "bbl": return "B";
    case "sty": case "cls": case "clo": return "S";
    case "png": case "jpg": case "jpeg": case "gif": case "bmp": case "webp": case "svg": return "I";
    case "ttf": case "otf": case "woff": case "woff2": return "F";
    case "pdf": case "eps": case "ps": return "P";
    default: return "#";
  }
}

type Props = {
  store: ProjectStore;
  folder_sync?: LocalFolderSync;
};

const FilePanel: Component<Props> = (props) => {
  const [renaming, set_renaming] = createSignal<string | null>(null);
  const [rename_value, set_rename_value] = createSignal("");
  const [ctx_menu, set_ctx_menu] = createSignal<{ file: string; x: number; y: number } | null>(null);
  const [os_drag_over, set_os_drag_over] = createSignal(false);
  const [open_folders, set_open_folders] = createSignal<Set<string>>(new Set());
  const [dragging, set_dragging] = createSignal<string | null>(null);
  const [drop_target, set_drop_target] = createSignal<string | null>(null);

  const tex_files = () => props.store.file_names().filter((n) => n.endsWith(".tex"));
  const show_main_controls = () => tex_files().length > 1;

  const tree = () => build_tree(props.store.file_names());

  // auto-open all folders when tree changes
  createEffect(() => {
    const paths = collect_folder_paths(tree());
    set_open_folders(new Set(paths));
  });

  // dismiss context menu
  createEffect(() => {
    if (!ctx_menu()) return;
    const on_click = () => set_ctx_menu(null);
    const on_key = (e: KeyboardEvent) => { if (e.key === "Escape") set_ctx_menu(null); };
    document.addEventListener("click", on_click);
    document.addEventListener("keydown", on_key);
    onCleanup(() => {
      document.removeEventListener("click", on_click);
      document.removeEventListener("keydown", on_key);
    });
  });

  function start_rename(name: string) {
    set_renaming(name);
    // for folders show just the segment name, not full path + slash
    if (name.endsWith("/")) {
      set_rename_value(name.replace(/\/$/, "").split("/").pop()!);
    } else {
      set_rename_value(name);
    }
  }

  function finish_rename() {
    const old_name = renaming();
    const new_val = rename_value().trim();
    set_renaming(null);
    if (!old_name || !new_val) return;

    if (old_name.endsWith("/")) {
      // folder rename — rebuild prefix, then bulk rename all files inside
      const new_seg = new_val.replace(/\/$/, "");
      const parent_parts = old_name.replace(/\/$/, "").split("/").slice(0, -1);
      const new_prefix = parent_parts.length > 0
        ? parent_parts.join("/") + "/" + new_seg + "/"
        : new_seg + "/";
      if (new_prefix === old_name) return;
      const files = props.store.file_names().filter(f => f.startsWith(old_name));
      for (const old_path of files) {
        props.store.rename_file(old_path, new_prefix + old_path.slice(old_name.length));
      }
      // keep folder open under new path
      set_open_folders(prev => {
        const next = new Set(prev);
        next.delete(old_name);
        next.add(new_prefix);
        return next;
      });
    } else {
      if (old_name !== new_val) props.store.rename_file(old_name, new_val);
    }
  }

  function toggle_folder(path: string) {
    set_open_folders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handle_add_file(folder_prefix?: string) {
    const existing = props.store.file_names();
    let name = folder_prefix ? `${folder_prefix}untitled.tex` : "untitled.tex";
    if (existing.includes(name)) name = auto_suffix(name, existing);
    props.store.add_file(name, "");
    start_rename(name);
  }

  function handle_add_folder(folder_prefix?: string) {
    const existing = props.store.file_names();
    const base = folder_prefix ? `${folder_prefix}new-folder/` : "new-folder/";
    let folder_name = base.replace(/\/$/, "");
    let counter = 1;
    while (existing.some(f => f.startsWith(folder_name + "/"))) {
      folder_name = `${base.replace(/\/$/, "")}-${counter}`;
      counter++;
    }
    const placeholder = `${folder_name}/.gitkeep`;
    props.store.add_file(placeholder, "");
    start_rename(folder_name + "/");
  }

  // OS drag-drop handler
  async function handle_os_drop(e: DragEvent) {
    const dt = e.dataTransfer;
    if (!dt?.files?.length) return;
    for (const file of Array.from(dt.files)) {
      if (file.name.startsWith(".")) continue;
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const binary_exts = ["png","jpg","jpeg","gif","webp","svg","pdf","zip","tar","gz","bz2","woff","woff2","ttf","otf"];
      if (binary_exts.includes(ext)) {
        props.store.add_file(file.name, new Uint8Array(await file.arrayBuffer()));
      } else {
        props.store.add_file(file.name, await file.text());
      }
    }
  }

  // internal drag-drop handler
  function handle_internal_drop(target_folder: string) {
    const src = dragging();
    if (!src) return;
    set_dragging(null);
    set_drop_target(null);

    if (src.endsWith("/")) {
      // folder move
      const old_prefix = src;
      const folder_name = src.replace(/\/$/, "").split("/").pop()!;
      let new_prefix: string;
      if (target_folder === "__root__") {
        new_prefix = folder_name + "/";
      } else {
        new_prefix = target_folder.replace(/\/$/, "") + "/" + folder_name + "/";
      }
      if (old_prefix === new_prefix) return;
      if (new_prefix.startsWith(old_prefix)) return;
      const files = props.store.file_names().filter(f => f.startsWith(old_prefix));
      for (const old_path of files) {
        const new_path = new_prefix + old_path.slice(old_prefix.length);
        props.store.rename_file(old_path, new_path);
      }
      return;
    }

    // file move
    const filename = src.split("/").pop()!;
    let new_path = target_folder === "__root__" ? filename : target_folder.replace(/\/$/, "") + "/" + filename;
    if (new_path === src) return;
    const existing = props.store.file_names();
    if (existing.includes(new_path)) {
      new_path = auto_suffix(new_path, existing);
    }
    props.store.rename_file(src, new_path);
  }

  function render_file_node(node: TreeNode & { kind: "file" }, depth: number): JSX.Element {
    const name = node.path;
    return (
      <div
        class={`file-item ${name === props.store.current_file() ? "active" : ""} ${dragging() === node.path ? "dragging" : ""}`}
        style={{ "padding-left": `${8 + depth * 14}px` }}
        onClick={() => props.store.set_current_file(name)}
        onDblClick={() => start_rename(name)}
        draggable={true}
        onDragStart={(e) => { set_dragging(node.path); e.dataTransfer!.effectAllowed = "move"; }}
        onDragEnd={() => { set_dragging(null); set_drop_target(null); }}
        onContextMenu={(e) => {
          e.preventDefault();
          const x = Math.min(e.clientX, window.innerWidth - 160);
          const y = Math.min(e.clientY, window.innerHeight - 120);
          set_ctx_menu({ file: name, x, y });
        }}
      >
        {renaming() === name ? (
          <input
            class="rename-input"
            ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
            value={rename_value()}
            onInput={(e) => set_rename_value(e.currentTarget.value)}
            onBlur={finish_rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish_rename();
              if (e.key === "Escape") set_renaming(null);
            }}
          />
        ) : (
          <>
            <span class={`file-icon ${name === props.store.main_file() ? "main" : ""} ${is_binary(name) ? "binary" : ""}`}>
              {file_icon(name)}
            </span>
            <span class="file-name">{node.name}</span>
            <div class="file-item-actions">
              <Show when={show_main_controls() && name.endsWith(".tex")}>
                <button
                  class={`set-main-btn ${name === props.store.main_file() ? "active" : ""}`}
                  title={name === props.store.main_file() ? "Entry file" : "Set as entry file"}
                  onClick={(e) => { e.stopPropagation(); props.store.set_main_file(name); }}
                >
                  <Show
                    when={name === props.store.main_file()}
                    fallback={
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                      </svg>
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="4" fill="var(--bg-dark)" />
                    </svg>
                  </Show>
                </button>
              </Show>
            </div>
          </>
        )}
      </div>
    );
  }

  function render_folder_node(node: TreeNode & { kind: "folder" }, depth: number): JSX.Element {
    const is_open = () => open_folders().has(node.path);
    return (
      <div>
        <div
          class={`file-item folder-item ${drop_target() === node.path ? "drop-target" : ""} ${dragging() === node.path ? "dragging" : ""}`}
          style={{ "padding-left": `${8 + depth * 14}px` }}
          onClick={() => { if (renaming() !== node.path) toggle_folder(node.path); }}
          onDblClick={() => start_rename(node.path)}
          draggable={true}
          onDragStart={(e) => { e.stopPropagation(); set_dragging(node.path); e.dataTransfer!.effectAllowed = "move"; }}
          onDragEnd={() => { set_dragging(null); set_drop_target(null); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = "move"; set_drop_target(node.path); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) set_drop_target(null); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handle_internal_drop(node.path); }}
          onContextMenu={(e) => {
            e.preventDefault();
            const x = Math.min(e.clientX, window.innerWidth - 160);
            const y = Math.min(e.clientY, window.innerHeight - 120);
            set_ctx_menu({ file: node.path, x, y });
          }}
        >
          {renaming() === node.path ? (
            <input
              class="rename-input"
              ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
              value={rename_value()}
              onInput={(e) => set_rename_value(e.currentTarget.value)}
              onBlur={finish_rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish_rename();
                if (e.key === "Escape") set_renaming(null);
              }}
            />
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style={{ "flex-shrink": "0", color: "var(--fg-muted)" }}>
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              <span class="file-name">{node.name}</span>
              <span class="folder-chevron" style={{ "margin-left": "auto" }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  style={{ transform: is_open() ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}>
                  <polyline points="9 6 15 12 9 18" />
                </svg>
              </span>
            </>
          )}
        </div>
        <Show when={is_open()}>
          {render_nodes(node.children, depth + 1)}
        </Show>
      </div>
    );
  }

  function render_nodes(nodes: TreeNode[], depth: number): JSX.Element {
    return (
      <For each={nodes}>
        {(node) => node.kind === "folder" ? render_folder_node(node as TreeNode & { kind: "folder" }, depth) : render_file_node(node as TreeNode & { kind: "file" }, depth)}
      </For>
    );
  }

  return (
    <div
      class={`file-panel ${os_drag_over() ? "drag-over" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        const x = Math.min(e.clientX, window.innerWidth - 160);
        const y = Math.min(e.clientY, window.innerHeight - 120);
        set_ctx_menu({ file: "__empty__", x, y });
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          set_os_drag_over(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          set_os_drag_over(false);
        }
      }}
      onDrop={async (e) => {
        set_os_drag_over(false);
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          await handle_os_drop(e);
        }
      }}
    >
      <Show when={props.folder_sync?.state().active}>
        <div class="folder-sync-panel-bar">
          <FolderSyncStatus
            state={props.folder_sync!.state()}
            on_disconnect={() => props.folder_sync?.disconnect()}
          />
        </div>
      </Show>
      <div
        class={`file-list ${drop_target() === "__root__" ? "drop-target-root" : ""}`}
        onDragOver={(e) => { if (dragging() && e.target === e.currentTarget) { e.preventDefault(); set_drop_target("__root__"); } }}
        onDrop={(e) => { if (dragging()) { e.preventDefault(); handle_internal_drop("__root__"); } }}
      >
        {render_nodes(tree(), 0)}
      </div>

      <Show when={ctx_menu()}>
        {(menu) => (
          <div class="ctx-menu"
            style={{ position: "fixed", left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(e) => e.stopPropagation()}>
            {/* file-specific actions */}
            <Show when={menu().file !== "__empty__" && !menu().file.endsWith("/")}>
              <button class="ctx-menu-item" onClick={() => { start_rename(menu().file); set_ctx_menu(null); }}>
                Rename
              </button>
              <Show when={menu().file.endsWith(".tex") && menu().file !== props.store.main_file()}>
                <button class="ctx-menu-item" onClick={() => { props.store.set_main_file(menu().file); set_ctx_menu(null); }}>
                  Set as entry file
                </button>
              </Show>
              <Show when={menu().file !== props.store.main_file() && props.store.file_names().length > 1}>
                <button class="ctx-menu-item danger" onClick={() => { props.store.remove_file(menu().file); set_ctx_menu(null); }}>
                  Delete
                </button>
              </Show>
              <div class="ctx-menu-divider" />
            </Show>
            {/* folder-specific actions */}
            <Show when={menu().file !== "__empty__" && menu().file.endsWith("/")}>
              <button class="ctx-menu-item" onClick={() => { start_rename(menu().file); set_ctx_menu(null); }}>
                Rename
              </button>
              <button class="ctx-menu-item danger" onClick={() => {
                const all = props.store.file_names().filter(f => f.startsWith(menu().file));
                if (all.some(f => f === props.store.main_file())) {
                  alert("Cannot delete folder containing the entry file.");
                  return;
                }
                for (const f of all) props.store.remove_file(f);
                set_ctx_menu(null);
              }}>Delete folder</button>
              <div class="ctx-menu-divider" />
            </Show>
            {/* always show new file / new folder */}
            <button class="ctx-menu-item" onClick={() => {
              const prefix = menu().file.endsWith("/") ? menu().file : undefined;
              handle_add_file(prefix);
              set_ctx_menu(null);
            }}>
              New File
            </button>
            <button class="ctx-menu-item" onClick={() => {
              const prefix = menu().file.endsWith("/") ? menu().file : undefined;
              handle_add_folder(prefix);
              set_ctx_menu(null);
            }}>
              New Folder
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default FilePanel;
