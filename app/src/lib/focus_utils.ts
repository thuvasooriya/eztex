const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function current_focus_target(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement ? el : null;
}

export function focusable_elements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return el.getClientRects().length > 0 || el === document.activeElement;
  });
}

export function focus_first_element(root: HTMLElement): void {
  const target = focusable_elements(root)[0] ?? root;
  target.focus({ preventScroll: true });
}

export function restore_focus(target: HTMLElement | null): void {
  if (!target) return;
  requestAnimationFrame(() => {
    if (!target.isConnected) return;
    target.focus({ preventScroll: true });
  });
}

export function trap_tab_key(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== "Tab") return;
  const items = focusable_elements(root);
  if (items.length === 0) {
    e.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus({ preventScroll: true });
  }
}
