// reusable list navigation hook for filtered lists with keyboard nav
// used by command palette (command list + file picker)

import { createSignal, createEffect } from "solid-js";

export type ListNavigation = {
  index: () => number;
  set_index: (i: number) => void;
  move_up: () => void;
  move_down: () => void;
  reset: () => void;
};

export function create_list_navigation(count: () => number): ListNavigation {
  const [index, set_index] = createSignal(0);

  // clamp index when list shrinks
  createEffect(() => {
    const n = count();
    if (n === 0) { set_index(0); return; }
    if (index() >= n) set_index(n - 1);
  });

  function move_up() {
    const n = count();
    if (n === 0) return;
    set_index((i) => (i - 1 + n) % n);
  }

  function move_down() {
    const n = count();
    if (n === 0) return;
    set_index((i) => (i + 1) % n);
  }

  function reset() {
    set_index(0);
  }

  return { index, set_index, move_up, move_down, reset };
}
