# UI Layout & Toolbar State Fixes - Analysis + Plan

## Summary

Three interconnected fixes: (1) narrow-screen warning overlay at <=600px, (2) allow horizontal (stacked) split in 600-900px range, (3) fix toolbar icon semantics for split/preview toggles. The core problem is that `is_narrow` (< 900px) is used as a single gate for ALL narrow behavior, but the 600-900px range should allow horizontal stacking. The toolbar icons don't reflect context-dependent behavior.

---

## Fix 1: Narrow Screen Warning Overlay

**What**: Fullscreen overlay at <= 600px warning the user the screen is too small.

### App.tsx Changes

Add new signal and resize handler update:

```
// Line 14, add new constant:
const TOO_NARROW_BREAKPOINT = 600;

// Line 37, after is_narrow signal, add:
const [is_too_narrow, set_is_too_narrow] = createSignal(window.innerWidth <= TOO_NARROW_BREAKPOINT);

// Line 100-106, update on_resize handler to also set is_too_narrow:
const on_resize = () => {
  const w = window.innerWidth;
  const narrow = w < NARROW_BREAKPOINT;
  set_is_narrow(narrow);
  set_is_too_narrow(w <= TOO_NARROW_BREAKPOINT);
  if (!narrow) {
    set_show_preview_in_narrow(false);
  }
};
```

Add overlay JSX before closing `</div>` of `.app` (after StatusPill, before line 224):

```tsx
<Show when={is_too_narrow()}>
  <div class="too-narrow-overlay">
    <div class="too-narrow-content">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <line x1="12" y1="18" x2="12" y2="18" stroke-linecap="round" />
      </svg>
      <p>Screen too narrow</p>
      <p class="too-narrow-hint">Please resize your window or rotate your device.</p>
    </div>
  </div>
</Show>
```

### index.css Changes

Add at the end of the responsive section (after line 1091, before context menu):

```css
/* too-narrow overlay */
.too-narrow-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: var(--bg-dark);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.too-narrow-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--fg-muted);
  padding: 24px;
}

.too-narrow-content p {
  font-size: 16px;
  font-weight: 500;
  color: var(--fg-dim);
}

.too-narrow-content .too-narrow-hint {
  font-size: 13px;
  color: var(--fg-muted);
  font-weight: 400;
}
```

**Effort**: Quick

---

## Fix 2: Horizontal Split in 600-900px Range

**What**: When `is_narrow()` (600-900px) AND `split_dir='horizontal'`, show both editor and preview stacked vertically instead of swap mode. Vertical split (side-by-side) stays as swap in this range.

### Core Insight

The layout decision is not just `is_narrow()` but `is_narrow() && split_dir`. We need a derived signal: "should we use swap mode?" which is true ONLY when narrow AND vertical split.

### App.tsx Changes

**Add derived signal** (after line 44):

```ts
// swap mode: narrow + vertical split = can't fit side-by-side, swap instead
// narrow + horizontal split = stacked layout fits fine, show both
const use_swap_mode = () => is_narrow() && split_dir() === "vertical";
```

**Update toggle_preview** (lines 50-56): Replace the entire function:

```ts
function toggle_preview() {
  if (use_swap_mode()) {
    set_show_preview_in_narrow((v) => !v);
  } else {
    set_preview_visible((v) => !v);
  }
}
```

**Update workspace_class** (lines 150-156): Add `swap-mode` class instead of relying purely on `narrow-mode`:

```ts
const workspace_class = () => {
  let cls = "workspace";
  if (is_narrow()) cls += " narrow-mode";
  if (use_swap_mode() && show_preview_in_narrow()) cls += " show-preview";
  cls += ` split-${split_dir()}`;
  return cls;
};
```

**Update layout conditionals** (lines 189-210):

The Show conditions for preview rendering need updating. Currently there are two blocks:
1. `!is_narrow() && preview_visible()` -- wide mode with resize handle
2. `is_narrow() && show_preview_in_narrow()` -- narrow swap mode

Change to three blocks:

```tsx
{/* Wide mode OR narrow+horizontal: show preview with resize handle */}
<Show when={!use_swap_mode() && preview_visible()}>
  <ResizeHandle
    direction={split_dir() === "vertical" ? "vertical" : "horizontal"}
    on_resize={handle_preview_resize}
  />
  <div
    class="preview-wrapper panel-wrapper panel-box"
    style={split_dir() === "vertical"
      ? { height: `${preview_height()}px`, "flex-shrink": 0 }
      : is_narrow()
        ? { flex: 1 }  // in narrow+horizontal, let it flex equally
        : { width: `${preview_width()}px`, "flex-shrink": 0 }
    }
  >
    <Preview />
  </div>
</Show>

{/* Narrow swap mode (vertical split): full-width preview replaces editor */}
<Show when={use_swap_mode() && show_preview_in_narrow()}>
  <div class="preview-wrapper panel-wrapper panel-box" style={{ flex: 1 }}>
    <Preview />
  </div>
</Show>
```

Wait -- there's a subtlety. In narrow+horizontal, the split-container flex-direction is `column` (horizontal split = `flex-direction: row` per `.split-container.split-horizontal`). That's wrong for stacking. "Horizontal split" means the divider is horizontal, which means content stacks vertically = `flex-direction: column`. But the CSS says `.split-container.split-horizontal { flex-direction: row }`.

Let me re-read the semantics. Looking at the code:
- `split_dir='horizontal'` = side-by-side (row), divider is vertical line
- `split_dir='vertical'` = stacked (column), divider is horizontal line

So actually "horizontal" means side-by-side. In narrow mode, we want stacking. So `split_dir='vertical'` is the one that stacks. This means the user's request is inverted from what I initially read.

Re-reading the issue description: "horizontal split (stacked vertically = column flex)". The user uses "horizontal split" to mean the split line is horizontal = content stacks = flex-column. But the CSS says `.split-horizontal { flex-direction: row }`.

Let me verify: line 296-302 in CSS:
- `.split-container.split-horizontal { flex-direction: row }` -- side by side
- `.split-container.split-vertical { flex-direction: column }` -- stacked

And the toolbar (line 323): `split_dir === "horizontal"` shows "Switch to vertical split" title.

So in the codebase:
- **horizontal** = side-by-side (row)
- **vertical** = stacked (column)

The user's description says "horizontal split (stacked vertically = column flex)" -- they're using the term loosely. What they actually want: **vertical split** (stacked, column) should work in narrow mode 600-900px. **Horizontal split** (side-by-side, row) should use swap mode in narrow because panels would be too thin.

This aligns with the CSS: vertical = column, and that's the one that should work in narrow mode because height is usually sufficient.

**CORRECTED understanding:**

```
600-900px narrow:
  split_dir='horizontal' (side-by-side row) -> swap mode (too narrow for side-by-side)
  split_dir='vertical' (stacked column) -> ALLOW both panels stacked
```

So the derived signal is:

```ts
const use_swap_mode = () => is_narrow() && split_dir() === "horizontal";
```

Everything else from the plan above stays the same but with this corrected condition.

**Update preview_visible prop passed to Toolbar** (line 166):

```tsx
preview_visible={use_swap_mode() ? show_preview_in_narrow() : preview_visible()}
```

**Update on_resize handler** -- when transitioning from narrow to wide, reset swap state:

```ts
const on_resize = () => {
  const w = window.innerWidth;
  const narrow = w < NARROW_BREAKPOINT;
  set_is_narrow(narrow);
  set_is_too_narrow(w <= TOO_NARROW_BREAKPOINT);
  if (!narrow) {
    set_show_preview_in_narrow(false);
  }
};
```

No change needed here -- existing logic already handles this.

**For narrow+vertical stacked preview sizing**: In narrow mode with vertical split showing both panels, we should NOT use the persisted `preview_height` as a fixed size because resizing with a handle in a small viewport is awkward. Instead, give both editor and preview `flex: 1` for an even 50/50 split, but still allow the resize handle to adjust.

Actually, keeping the resize handle is fine. The `preview_height` signal already exists and works. Just make sure the Show condition includes it. The style can stay as `{ height: preview_height()px, flex-shrink: 0 }` -- that's fine for a stacked layout.

### index.css Changes

**Replace the narrow swap CSS** (lines 1043-1056):

Current:
```css
.workspace.narrow-mode .split-container .preview-wrapper,
.workspace.narrow-mode .split-container .resize-handle {
  display: none;
}
.workspace.narrow-mode.show-preview .split-container .editor-wrapper {
  display: none;
}
.workspace.narrow-mode.show-preview .split-container .preview-wrapper {
  display: flex;
  flex: 1;
  width: auto !important;
  height: auto !important;
}
```

Replace with:
```css
/* narrow + horizontal (side-by-side): swap mode */
.workspace.narrow-mode.split-horizontal .split-container .preview-wrapper,
.workspace.narrow-mode.split-horizontal .split-container .resize-handle {
  display: none;
}
.workspace.narrow-mode.split-horizontal.show-preview .split-container .editor-wrapper {
  display: none;
}
.workspace.narrow-mode.split-horizontal.show-preview .split-container .preview-wrapper {
  display: flex;
  flex: 1;
  width: auto !important;
  height: auto !important;
}

/* narrow + vertical (stacked): both panels visible, resize handle works */
/* No hiding needed -- the Show conditionals in JSX handle rendering */
```

That's it for CSS. The JSX Show conditions already gate what renders. We just need to remove the blanket CSS hiding that was blocking narrow-mode preview in ALL cases.

**Effort**: Short (mostly logic rewiring, small CSS change)

---

## Fix 3: Toolbar Icon Semantics

### A. Preview Toggle Icon

Three contexts, three behaviors:

| Context | Action | Icon |
|---------|--------|------|
| Wide + horizontal (side-by-side) | toggle side panel | panel-right (current) |
| Wide + vertical (stacked) | toggle bottom panel | panel-bottom icon |
| Narrow + horizontal (swap mode) | swap editor/pdf | swap icon |
| Narrow + vertical (stacked) | toggle bottom panel | panel-bottom icon |

Simplified: if `use_swap_mode()`, show swap icon. If `split_dir() === 'vertical'`, show panel-bottom. Else show panel-right.

### Toolbar.tsx Changes

**Props**: Add `is_narrow` prop to Toolbar (needed for icon logic):

```tsx
// Props type (line 11-19), add:
is_narrow?: boolean;
```

And pass from App.tsx line 160-168:
```tsx
is_narrow={is_narrow()}
```

Actually, we can derive swap mode from existing props: `props.is_narrow && props.split_dir === 'horizontal'`. But cleaner to just pass `use_swap_mode` as a prop.

Better: pass a single `swap_mode` boolean prop:

```tsx
// Props type, add:
swap_mode?: boolean;

// App.tsx Toolbar usage:
swap_mode={use_swap_mode()}
```

**Preview toggle icon** (lines 341-353): Replace with context-aware icons:

```tsx
<Show when={props.on_toggle_preview}>
  <button
    class={`toolbar-toggle ${props.preview_visible ? "active" : ""}`}
    onClick={props.on_toggle_preview}
    title={props.swap_mode
      ? (props.preview_visible ? "Show editor" : "Show PDF")
      : "Toggle preview"
    }
  >
    <Show
      when={props.swap_mode}
      fallback={
        <Show
          when={props.split_dir === "vertical"}
          fallback={
            {/* panel-right icon (horizontal/side-by-side) */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          }
        >
          {/* panel-bottom icon (vertical/stacked) */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="15" x2="21" y2="15" />
          </svg>
        </Show>
      }
    >
      {/* swap icon (two overlapping rectangles with arrow) */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    </Show>
  </button>
</Show>
```

### B. Split Toggle Icon

**Decision: Show CURRENT state.** This matches the files toggle pattern (panel-left icon is highlighted when files panel is visible). The title describes what clicking will DO.

Current code (lines 319-339) shows the OPPOSITE icon (what you'll switch to). Change to show CURRENT state:

```tsx
<Show when={props.on_toggle_split}>
  <button
    class={`toolbar-toggle ${props.split_dir === "horizontal" ? "" : "active"}`}
    onClick={props.on_toggle_split}
    title={props.split_dir === "horizontal"
      ? "Switch to stacked layout"
      : "Switch to side-by-side layout"
    }
  >
    <Show
      when={props.split_dir === "horizontal"}
      fallback={
        {/* current = vertical/stacked: horizontal line divider */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      }
    >
      {/* current = horizontal/side-by-side: vertical line divider */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="12" y1="3" x2="12" y2="21" />
      </svg>
    </Show>
  </button>
</Show>
```

Wait -- active state semantics. For files toggle: active = panel visible. For split: there's no "on/off" -- it's a mode switch between two states. Having `.active` on one but not the other is odd.

**Better approach**: No `.active` class on split button. Just show the current layout icon. The icon itself communicates state. Remove active class entirely:

```tsx
class="toolbar-toggle"
```

**Dimmed state when split direction is suboptimal for screen width**:

When narrow (600-900px) and `split_dir='horizontal'` (side-by-side), that mode causes swap behavior, so it's "not ideal". Add a `muted` class:

```tsx
class={`toolbar-toggle${props.swap_mode ? " muted" : ""}`}
```

CSS for muted:
```css
.toolbar-toggle.muted {
  color: var(--fg-dark);
  opacity: 0.5;
}
.toolbar-toggle.muted:hover {
  opacity: 0.8;
}
```

### C. Files Toggle

No changes needed -- already correct.

**Effort**: Short

---

## Implementation Checklist

### App.tsx
1. [ ] Add `TOO_NARROW_BREAKPOINT = 600` constant (line 14)
2. [ ] Add `is_too_narrow` signal (after line 37)
3. [ ] Add `use_swap_mode` derived signal (after line 44)
4. [ ] Update `toggle_preview()` to use `use_swap_mode()` (lines 50-56)
5. [ ] Update `on_resize` to set `is_too_narrow` (lines 100-106)
6. [ ] Update `workspace_class` to use `use_swap_mode()` for `show-preview` (lines 150-156)
7. [ ] Update `preview_visible` prop to Toolbar: `use_swap_mode() ? show_preview_in_narrow() : preview_visible()` (line 166)
8. [ ] Add `swap_mode={use_swap_mode()}` prop to Toolbar (line 168)
9. [ ] Update Show condition for main preview block: `!use_swap_mode() && preview_visible()` (line 189)
10. [ ] Update Show condition for swap preview block: `use_swap_mode() && show_preview_in_narrow()` (line 206)
11. [ ] In narrow+vertical stacked mode, preview style should use flex:1 or preview_height -- keep current height-based sizing since resize handle is shown
12. [ ] Add too-narrow overlay JSX before closing `</div>` of `.app`

### components/Toolbar.tsx
13. [ ] Add `swap_mode?: boolean` to Props type (line 11-19)
14. [ ] Replace split toggle (lines 319-339): show CURRENT state icon, no active class, add muted class when `swap_mode`
15. [ ] Replace preview toggle (lines 341-353): context-aware icon (panel-right / panel-bottom / swap), context-aware title

### index.css
16. [ ] Add `.too-narrow-overlay` styles (after responsive section)
17. [ ] Replace blanket `.workspace.narrow-mode .split-container .preview-wrapper { display:none }` with `.workspace.narrow-mode.split-horizontal` scoped version (lines 1043-1056)
18. [ ] Add `.toolbar-toggle.muted` style

---

## Edge Cases to Watch

- **Resize from <600 to 600-900**: overlay disappears, narrow mode kicks in. If split_dir was vertical, stacked layout shows immediately -- good.
- **Resize from 600-900 to >900**: `is_narrow` goes false, `use_swap_mode` goes false, `show_preview_in_narrow` resets. Preview visibility falls back to `preview_visible` signal. If user had hidden preview via swap toggle, `preview_visible` might still be true (it was never toggled in swap mode). This is correct behavior.
- **Switching split_dir while narrow**: Going from horizontal (swap) to vertical (stacked) while narrow should immediately show stacked layout if `preview_visible` is true. Since `use_swap_mode` is reactive, the Show conditions will update. `preview_visible` defaults true, so switching to vertical in narrow mode will show both panels stacked. Good.
- **Keyboard shortcuts**: `Ctrl+Shift+P` calls `toggle_preview()` which already uses `use_swap_mode()`. Works.
- **ResizeHandle in narrow+vertical**: The handle renders because `!use_swap_mode()` is true. The direction is "vertical" (row resize). The handle CSS for `.resize-handle.vertical` should NOT be hidden. Current CSS hides `.workspace.narrow-mode .split-container .resize-handle` -- but with the fix, this only applies to `.narrow-mode.split-horizontal`. So vertical split resize handle in narrow mode will be visible. Correct.

**Total Effort**: Short (2-3 hours implementation + testing)
