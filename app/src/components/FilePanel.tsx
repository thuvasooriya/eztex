import { type Component, For, Show, createSignal } from "solid-js";
import type { ProjectStore } from "../lib/project_store";

type Props = {
  store: ProjectStore;
};

const FilePanel: Component<Props> = (props) => {
  const [renaming, set_renaming] = createSignal<string | null>(null);
  const [rename_value, set_rename_value] = createSignal("");

  const tex_files = () => props.store.file_names().filter((n) => n.endsWith(".tex"));
  const show_main_controls = () => tex_files().length > 1;

  function start_rename(name: string) {
    set_renaming(name);
    set_rename_value(name);
  }

  function finish_rename() {
    const old_name = renaming();
    const new_name = rename_value().trim();
    if (old_name && new_name && old_name !== new_name) {
      props.store.rename_file(old_name, new_name);
    }
    set_renaming(null);
  }

  return (
    <div class="file-panel">
      <div class="file-list">
        <For each={props.store.file_names()}>
          {(name) => (
            <div
              class={`file-item ${name === props.store.current_file() ? "active" : ""}`}
              onClick={() => props.store.set_current_file(name)}
              onDblClick={() => start_rename(name)}
            >
              {renaming() === name ? (
                <input
                  class="rename-input"
                  value={rename_value()}
                  onInput={(e) => set_rename_value(e.currentTarget.value)}
                  onBlur={finish_rename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") finish_rename();
                    if (e.key === "Escape") set_renaming(null);
                  }}
                  autofocus
                />
              ) : (
                <>
                  <span class={`file-icon ${name === props.store.main_file() ? "main" : ""}`}>
                    {name.endsWith(".tex") ? "T"
                      : name.endsWith(".bib") ? "B"
                      : name.endsWith(".sty") ? "S"
                      : "#"}
                  </span>
                  <span class="file-name">{name}</span>
                  <div class="file-item-actions">
                    <Show when={show_main_controls() && name.endsWith(".tex")}>
                      <button
                        class={`set-main-btn ${name === props.store.main_file() ? "active" : ""}`}
                        title={name === props.store.main_file() ? "Main file" : "Set as main file"}
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
          )}
        </For>
      </div>
    </div>
  );
};

export default FilePanel;
