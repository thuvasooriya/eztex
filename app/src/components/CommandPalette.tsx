// command palette -- modal overlay for keyboard-first command execution
// reads from command registry, owns no business logic

import { type Component, Show, For, createSignal, createEffect, createMemo } from "solid-js";
import { palette_open, set_palette_open, palette_filter, set_palette_filter, get_visible_commands, fuzzy_match, execute_command } from "../lib/commands";
import type { Command } from "../lib/commands";
import { worker_client } from "../lib/worker_client";

// file picker mode: palette_filter starts with "> "
// goto line mode: palette_filter starts with ": "

const CommandPalette: Component<{ store: any }> = (props) => {
  let input_ref: HTMLInputElement | undefined;
  const [selected, set_selected] = createSignal(0);

  const is_file_mode = () => palette_filter().startsWith("> ");
  const is_goto_mode = () => palette_filter().startsWith(": ");

  const file_list = createMemo(() => {
    if (!is_file_mode()) return [];
    const query = palette_filter().slice(2).toLowerCase();
    const names = props.store.file_names() as string[];
    if (!query) return names;
    return names.filter((n: string) => n.toLowerCase().includes(query));
  });

  const filtered_commands = createMemo(() => {
    if (is_file_mode() || is_goto_mode()) return [];
    const query = palette_filter();
    const visible = get_visible_commands();
    if (!query) return visible;

    const scored: { cmd: Command; score: number }[] = [];
    for (const cmd of visible) {
      // skip the palette.open command itself from results
      if (cmd.id === "palette.open") continue;
      const score = fuzzy_match(query, cmd);
      if (score !== null) scored.push({ cmd, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  });

  // group commands by category
  const grouped_commands = createMemo(() => {
    const cmds = filtered_commands();
    const groups: { category: string; commands: Command[] }[] = [];
    const seen = new Set<string>();
    for (const cmd of cmds) {
      if (cmd.id === "palette.open") continue;
      if (!seen.has(cmd.category)) {
        seen.add(cmd.category);
        groups.push({ category: cmd.category, commands: [] });
      }
      groups.find((g) => g.category === cmd.category)!.commands.push(cmd);
    }
    return groups;
  });

  // flat list for keyboard navigation
  const flat_items = createMemo((): { type: "command"; cmd: Command }[] | { type: "file"; name: string }[] => {
    if (is_file_mode()) {
      return file_list().map((name: string) => ({ type: "file" as const, name }));
    }
    if (is_goto_mode()) return [];
    return filtered_commands()
      .filter((c) => c.id !== "palette.open")
      .map((cmd) => ({ type: "command" as const, cmd }));
  });

  const total_items = () => flat_items().length;

  // reset selection when filter changes
  createEffect(() => {
    void palette_filter();
    set_selected(0);
  });

  // auto-focus input when palette opens
  createEffect(() => {
    if (palette_open()) {
      requestAnimationFrame(() => input_ref?.focus());
    }
  });

  function close() {
    set_palette_open(false);
    set_palette_filter("");
  }

  function handle_select(index: number) {
    const items = flat_items();
    const item = items[index];
    if (!item) return;

    if (item.type === "file") {
      props.store.set_current_file((item as any).name);
      close();
    } else if (item.type === "command") {
      close();
      execute_command((item as any).cmd.id);
    }
  }

  function handle_goto_submit() {
    const val = palette_filter().slice(2).trim();
    const line_num = parseInt(val, 10);
    if (!isNaN(line_num) && line_num > 0) {
      close();
      const file = props.store.current_file();
      worker_client.request_goto(file, line_num);
    }
  }

  function handle_keydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const total = total_items();
      if (total > 0) set_selected((s) => (s + 1) % total);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const total = total_items();
      if (total > 0) set_selected((s) => (s - 1 + total) % total);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (is_goto_mode()) {
        handle_goto_submit();
      } else {
        handle_select(selected());
      }
      return;
    }
  }

  // format keybinding for display: Cmd -> platform symbol
  function format_keybinding(kb: string): string {
    const is_mac = navigator.platform.includes("Mac");
    if (is_mac) {
      return kb
        .replace(/Cmd\+/g, "\u2318")
        .replace(/Shift\+/g, "\u21E7")
        .replace(/Alt\+/g, "\u2325")
        .replace(/Ctrl\+/g, "\u2303")
        .replace("Enter", "\u23CE");
    }
    return kb
      .replace(/Cmd\+/g, "Ctrl+")
      .replace("Enter", "Enter");
  }

  // scroll selected item into view
  let list_ref: HTMLDivElement | undefined;
  createEffect(() => {
    const idx = selected();
    if (!list_ref) return;
    const el = list_ref.querySelector(`[data-index="${idx}"]`) as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  });

  return (
    <Show when={palette_open()}>
      <div class="palette-backdrop" onClick={close}>
        <div class="palette" onClick={(e) => e.stopPropagation()} onKeyDown={handle_keydown}>
          <input
            ref={input_ref}
            class="palette-input"
            type="text"
            placeholder={is_goto_mode() ? "Go to line number..." : is_file_mode() ? "Type to filter files..." : "Type a command..."}
            value={palette_filter()}
            onInput={(e) => set_palette_filter(e.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
          <Show when={!is_goto_mode()}>
            <div class="palette-list" ref={list_ref}>
              <Show when={is_file_mode()}>
                <For each={file_list()}>
                  {(name: string, i) => {
                    const idx = i();
                    return (
                      <button
                        class={`palette-item ${selected() === idx ? "selected" : ""}`}
                        data-index={idx}
                        onClick={() => handle_select(idx)}
                        onMouseEnter={() => set_selected(idx)}
                      >
                        <span class="palette-item-label">{name}</span>
                      </button>
                    );
                  }}
                </For>
              </Show>
              <Show when={!is_file_mode()}>
                {(() => {
                  let global_idx = 0;
                  return (
                    <For each={grouped_commands()}>
                      {(group) => (
                        <div class="palette-group">
                          <div class="palette-group-label">{group.category}</div>
                          <For each={group.commands}>
                            {(cmd) => {
                              const idx = global_idx++;
                              return (
                                <button
                                  class={`palette-item ${selected() === idx ? "selected" : ""}`}
                                  data-index={idx}
                                  onClick={() => { close(); execute_command(cmd.id); }}
                                  onMouseEnter={() => set_selected(idx)}
                                >
                                  <div class="palette-item-left">
                                    <span class="palette-item-label">{cmd.label}</span>
                                    <Show when={cmd.description}>
                                      <span class="palette-item-desc">{cmd.description}</span>
                                    </Show>
                                  </div>
                                  <Show when={cmd.keybinding}>
                                    <kbd class="palette-kbd">{format_keybinding(cmd.keybinding!)}</kbd>
                                  </Show>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      )}
                    </For>
                  );
                })()}
              </Show>
              <Show when={total_items() === 0 && palette_filter().length > 0}>
                <div class="palette-empty">No matching commands</div>
              </Show>
            </div>
          </Show>
          <Show when={is_goto_mode()}>
            <div class="palette-hint">Type a line number and press Enter</div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default CommandPalette;
