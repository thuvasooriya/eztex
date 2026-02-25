// command palette -- modal overlay for keyboard-first command execution
// reads from command registry, owns no business logic

import { type Component, Show, For, createEffect, createMemo, type JSX } from "solid-js";
import { palette_open, set_palette_open, palette_filter, set_palette_filter, get_visible_commands, fuzzy_match, execute_command, IS_MAC } from "../lib/commands";
import type { Command } from "../lib/commands";
import { worker_client } from "../lib/worker_client";
import { create_list_navigation } from "../lib/list_nav";
import AnimatedShow from "./AnimatedShow";

// SVG icon components for modifier/special keys (lucide paths, 24x24 viewBox)
// rendered at 1em via CSS so they scale with the pill font-size
const svg_attrs = { xmlns: "http://www.w3.org/2000/svg", width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

const KEY_ICONS: Record<string, () => JSX.Element> = {
  "\u2303": () => <svg {...svg_attrs}><path d="m18 15-6-6-6 6"/></svg>, // ctrl
  "\u2318": () => <svg {...svg_attrs}><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>, // cmd
  "\u21E7": () => <svg {...svg_attrs}><path d="M9 13a1 1 0 0 0-1-1H5.061a1 1 0 0 1-.75-1.811l6.836-6.835a1.207 1.207 0 0 1 1.707 0l6.835 6.835a1 1 0 0 1-.75 1.811H16a1 1 0 0 0-1 1v6a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/></svg>, // shift
  "\u2325": () => <svg {...svg_attrs}><path d="M3 3h6l6 18h6"/><path d="M14 3h7"/></svg>, // option/alt
  "\u23CE": () => <svg {...svg_attrs}><path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/></svg>, // enter/return
  "\u232B": () => <svg {...svg_attrs}><path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/></svg>, // backspace
};

// key token map: internal name -> display string per platform
const MAC_KEYS: Record<string, string> = {
  Cmd: "\u2318", Shift: "\u21E7", Alt: "\u2325", Ctrl: "\u2303",
  Enter: "\u23CE", Backspace: "\u232B", Escape: "\u238B",
  ArrowUp: "\u2191", ArrowDown: "\u2193", ArrowLeft: "\u2190", ArrowRight: "\u2192",
};
const PC_KEYS: Record<string, string> = {
  Cmd: "Ctrl", Shift: "Shift", Alt: "Alt", Enter: "Enter", Backspace: "Backspace", Escape: "Esc",
};

// split "Cmd+Shift+E" into individual display tokens
function keybinding_tokens(kb: string): string[] {
  return kb.split("+").map((part) => {
    const table = IS_MAC ? MAC_KEYS : PC_KEYS;
    return table[part] ?? part;
  });
}

// file picker mode: palette_filter starts with "> "
// goto line mode: palette_filter starts with ": "

const CommandPalette: Component<{ store: any }> = (props) => {
  let input_ref: HTMLInputElement | undefined;
  let list_ref: HTMLDivElement | undefined;

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

  // flat list for navigation
  type FlatItem = { type: "command"; cmd: Command } | { type: "file"; name: string };
  const flat_items = createMemo((): FlatItem[] => {
    if (is_file_mode()) {
      return file_list().map((name: string) => ({ type: "file" as const, name }));
    }
    if (is_goto_mode()) return [];
    return filtered_commands()
      .filter((c) => c.id !== "palette.open")
      .map((cmd) => ({ type: "command" as const, cmd }));
  });

  const nav = create_list_navigation(() => flat_items().length);

  // reset navigation when filter changes
  createEffect(() => {
    void palette_filter();
    nav.reset();
  });

  // auto-focus input when palette opens
  createEffect(() => {
    if (palette_open()) {
      requestAnimationFrame(() => input_ref?.focus());
    }
  });

  // scroll selected item into view
  createEffect(() => {
    const idx = nav.index();
    if (!list_ref) return;
    const el = list_ref.querySelector(`[data-index="${idx}"]`) as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  });

  function close() {
    set_palette_open(false);
    set_palette_filter("");
  }

  function handle_select(index: number) {
    const item = flat_items()[index];
    if (!item) return;
    if (item.type === "file") {
      props.store.set_current_file(item.name);
      close();
    } else {
      close();
      execute_command(item.cmd.id);
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

    // Cmd+K (Mac) or Ctrl+Shift+K (non-Mac) toggles palette closed when already open
    if (e.key === "k" && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey)) {
      e.preventDefault();
      close();
      return;
    }

    // navigation: ArrowDown / Ctrl+J
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      nav.move_down();
      return;
    }

    // navigation: ArrowUp / Ctrl+K
    if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      nav.move_up();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (is_goto_mode()) {
        handle_goto_submit();
      } else {
        handle_select(nav.index());
      }
      return;
    }
  }

  // render keybinding as individual <kbd> pill tokens
  // SVG icons for modifiers (Mac), plain text for letters/numbers/PC keys
  function render_keybinding(kb: string): JSX.Element {
    const tokens = keybinding_tokens(kb);
    return (
      <span class="palette-kbd-group">
        <For each={tokens}>
          {(token) => {
            const icon = KEY_ICONS[token];
            if (icon) return <kbd class="palette-kbd">{icon()}</kbd>;
            return <kbd class="palette-kbd">{token}</kbd>;
          }}
        </For>
      </span>
    );
  }

  return (
    <AnimatedShow when={palette_open()}>
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
                        class={`palette-item ${nav.index() === idx ? "selected" : ""}`}
                        data-index={idx}
                        onClick={() => handle_select(idx)}
                        onMouseEnter={() => nav.set_index(idx)}
                      >
                        <span class="palette-item-label">{name}</span>
                      </button>
                    );
                  }}
                </For>
              </Show>
              <Show when={!is_file_mode()}>
                <For each={grouped_commands()}>
                  {(group) => (
                    <div class="palette-group">
                      <div class="palette-group-label">{group.category}</div>
                      <For each={group.commands}>
                        {(cmd) => {
                          // reactive index: recomputes when flat_items changes
                          const idx = () => flat_items().findIndex((fi) => fi.type === "command" && fi.cmd === cmd);
                          return (
                            <button
                              class={`palette-item ${nav.index() === idx() ? "selected" : ""}`}
                              data-index={idx()}
                              onClick={() => { close(); execute_command(cmd.id); }}
                              onMouseEnter={() => nav.set_index(idx())}
                            >
                              <div class="palette-item-left">
                                <span class="palette-item-label">{cmd.label}</span>
                                <Show when={cmd.description}>
                                  <span class="palette-item-desc">{cmd.description}</span>
                                </Show>
                              </div>
                              <Show when={cmd.keybinding}>
                                {render_keybinding(cmd.keybinding!)}
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={flat_items().length === 0 && palette_filter().length > 0}>
                <div class="palette-empty">No matching commands</div>
              </Show>
            </div>
          </Show>
          <Show when={is_goto_mode()}>
            <div class="palette-hint">Type a line number and press Enter</div>
          </Show>
        </div>
      </div>
    </AnimatedShow>
  );
};

export default CommandPalette;
