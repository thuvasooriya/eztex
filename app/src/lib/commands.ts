// command registry -- module-level singleton for keyboard-first command palette
// all actions (toolbar, shortcuts, palette) route through here

import { createSignal } from "solid-js";

// platform detection -- shared across keybinding system
export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export type Command = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  category: string;
  keybinding?: string;
  when?: () => boolean;
  action: () => void;
};

const commands: Command[] = [];

// palette open state -- shared between App keydown handler and palette component
const [palette_open, set_palette_open] = createSignal(false);
const [palette_filter, set_palette_filter] = createSignal("");

export { palette_open, set_palette_open, palette_filter, set_palette_filter };

export function register_command(cmd: Command): void {
  const idx = commands.findIndex((c) => c.id === cmd.id);
  if (idx >= 0) commands[idx] = cmd;
  else commands.push(cmd);
}

export function execute_command(id: string): void {
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return;
  if (cmd.when && !cmd.when()) return;
  cmd.action();
}

export function get_visible_commands(): Command[] {
  return commands.filter((c) => !c.when || c.when());
}

export function get_all_commands(): Command[] {
  return commands;
}

export function find_command(id: string): Command | undefined {
  return commands.find((c) => c.id === id);
}

// fuzzy match: returns score (higher = better) or null (no match)
// matches against label + description + keywords
export function fuzzy_match(query: string, cmd: Command): number | null {
  if (!query) return 100;
  const q = query.toLowerCase();

  // build searchable text
  const parts = [cmd.label];
  if (cmd.description) parts.push(cmd.description);
  if (cmd.keywords) parts.push(...cmd.keywords);
  const text = parts.join(" ").toLowerCase();

  // exact substring in label
  const label_lower = cmd.label.toLowerCase();
  const label_idx = label_lower.indexOf(q);
  if (label_idx === 0) return 200; // prefix match on label
  if (label_idx > 0) return 150; // substring match on label

  // substring in full text
  const text_idx = text.indexOf(q);
  if (text_idx >= 0) return 100;

  // character-by-character fuzzy on full text
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      const prev = text[ti - 1];
      score += prev === " " || prev === "." || ti === 0 ? 10 : 1;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}
