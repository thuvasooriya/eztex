# CSS Architecture & Animation Strategy

## Part 1: CSS Framework Assessment (UnoCSS / Tailwind)

### Current State

The app has a single `index.css` file (~1710 lines) with a well-structured architecture:

- **Design tokens via CSS custom properties**: 25+ variables covering colors (tokyo night palette), fonts, radii, and a single transition speed (`--transition: 150ms ease`)
- **BEM-ish flat class naming**: `.toolbar-btn`, `.file-item`, `.diag-pill-badge` -- consistent, readable, no nesting nightmares
- **Component locality**: styles are grouped by component in comments (`/* === toolbar === */`, `/* === file panel === */`, etc.)
- **Responsive breakpoints**: three media queries (900px, 700px, 480px) plus an overlay mode system
- **Theme colors are already centralized**: all color usage goes through `var(--*)` -- nothing is hardcoded outside of the editor highlight styles (which use CodeMirror's own theme API with hex values)

### Recommendation: Do NOT bring in UnoCSS or Tailwind

**Bottom line**: The current CSS is already well-architected for theming. Adding a utility framework would create a large migration cost for marginal benefit in a codebase this size.

#### Why not

1. **Bundle size regression**: Current CSS is ~1710 lines of hand-written CSS, roughly 25-30KB uncompressed. Tailwind's reset + base alone adds overhead, and the JIT output would likely be comparable or larger. UnoCSS is lighter but still adds a build step, config file, and presets.

2. **Migration cost is high for no payoff**: Every component uses `class=""` strings already. Converting ~150 class usages to utility classes means touching every JSX file and losing the readable naming. The CSS is already co-located by component -- moving to utilities scatters the intent across template strings.

3. **Theming is already solved**: The `--var()` system means adding a dark/light theme or a new palette is just swapping the `:root` block. Example:
   ```css
   [data-theme="light"] {
     --bg-dark: #f5f5f5;
     --bg: #ffffff;
     --fg: #1a1b26;
     /* ... */
   }
   ```
   Neither Tailwind nor UnoCSS makes this simpler. They both ultimately use CSS variables for theming too.

4. **DX is already good**: With a single file and clear naming, any developer can cmd+F for a component name and find all its styles. No jumping between config files, no memorizing utility class shorthands.

5. **SolidJS ecosystem**: SolidJS's reactivity model works fine with plain CSS classes. There's no React-style className composition problem to solve.

#### What to do instead for future theming

1. **Extract theme tokens to a separate file** (`theme.css` or `tokens.css`) that only contains `:root` and theme-switched variable blocks. Keep component styles in `index.css`.

2. **Add a `[data-theme]` attribute system**: Toggle themes by setting `document.documentElement.dataset.theme = "light"`. Add override blocks per theme.

3. **Fix the 6 hardcoded hex colors in `index.css`**: These are the only values that don't go through variables:
   - `#b0dc82` (compile-group-watch active:hover)
   - `#e8be7e` (compile-group-watch dirty:hover)
   - Editor background gradient (`#16171f`, `#13141c`, `#151620`)
   - `white` in `.pdf-frame`

   Replace with computed variables (e.g., `--green-hover`, `--editor-gradient-*`).

4. **Fix the hardcoded editor highlight hex colors in `Editor.tsx`**: The `tokyo_night_highlight` HighlightStyle uses 15 raw hex values. Extract these into CSS variables so themes can override syntax highlighting too.

**Effort: Quick** -- Theme infrastructure can be added in 1-2 hours without any framework.

---

## Part 2: Animation & Interaction System

### Current State Inventory

**Existing keyframe animations (4):**
| Name | Duration | Easing | Used by |
|------|----------|--------|---------|
| `spin` | 0.6s | linear | compile spinner, folder sync syncing icon, cache clearing icon |
| `popover-in` | 150ms | ease | compile logs popover, diagnostic pill popover, toolbar center pill |
| `progress-shimmer` | 1.8s | ease-in-out | indeterminate progress bar |
| `slide-in-left` | 0.2s | ease | file panel overlay (narrow) |
| `fade-in` | 150ms | ease | conflict overlay |

**Existing transitions:**
- Global `--transition: 150ms ease` used by ~30 elements (good)
- Progress bar uses `200ms ease` (slightly different, fine)
- Folder chevron uses inline `transition: transform 150ms` (should use the variable)

**Existing interaction feedback:**
- `.toolbar-btn:active { transform: scale(0.97) }` -- press-down effect
- Hover color shifts on most interactive elements
- `.hunk-dimmed { opacity: 0.35 }` -- deselection dimming
- Drag-drop visual states (`.dragging`, `.drop-target`, `.drag-over`)

**What's missing:**
- No entrance/exit animations for `<Show>` conditional elements (file panel, preview panel, popovers disappear instantly)
- No feedback on successful compile (status text just changes)
- No skeleton/loading states
- No micro-interactions on file selection, tab switching
- The resize handle has no "grabbed" visual state
- Context menu has no entrance animation
- Dropdown menus pop in without animation

### Recommended Animation System

#### Principle: Physical, not decorative

Every animation should feel like it has weight and responds to user input. No gratuitous motion. Three categories:

1. **Feedback** (0-100ms): Immediate response to user action -- press, toggle, select
2. **Transition** (100-200ms): State changes -- panel show/hide, popover open/close, status change
3. **Ambient** (500ms+): Background activity indicators -- spinner, shimmer, pulse

#### Step 1: Define timing tokens in CSS variables

Add to `:root`:

```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in: cubic-bezier(0.55, 0.06, 0.68, 0.19);
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

--duration-instant: 80ms;
--duration-fast: 150ms;
--duration-normal: 200ms;
--duration-slow: 300ms;
```

The existing `--transition: 150ms ease` should stay as the default, but specific interactions can reference more specific tokens.

**Why custom cubic-beziers?** The `ease` keyword is fine for most things but feels mushy for entrances. `--ease-out` (fast start, gentle stop) is the universal "feel good" curve for elements appearing. `--ease-spring` gives a subtle overshoot for toggles and selections.

#### Step 2: Define reusable keyframes

Keep what exists. Add these:

```css
@keyframes scale-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes slide-down {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Replace the current `popover-in` usages: compile-logs-popover (drops down from button) should use `slide-down`, diagnostic-pill-popover (rises up from pill) should use `slide-up`. Both currently use the same `popover-in` which moves 4px -- this is correct directionally for the diag pill but wrong for the compile logs.

#### Step 3: Concrete improvements (priority order)

**High impact, low effort:**

1. **Dropdown/popover entrance**: Replace `animation: popover-in 150ms ease` with directional variants. Compile logs drops down (`slide-down`), diag pill rises up (keep current `popover-in` renamed to `slide-up`). Context menu uses `scale-in`.

2. **Active press feedback on all buttons**: The `.toolbar-btn:active` scale is good. Extend it to `.toolbar-toggle`, `.compile-group-play`, `.compile-group-watch`, `.compile-group-status`, `.icon-btn`, `.ctx-menu-item`, `.upload-dropdown-item`:
   ```css
   .toolbar-toggle:active,
   .icon-btn:active { transform: scale(0.92); }
   ```

3. **Resize handle grabbed state**: Add a visual indicator when dragging:
   ```css
   .resize-handle:active::after,
   .resize-handle.dragging::after {
     opacity: 1;
     height: 40px; /* or width for vertical */
   }
   ```

4. **Compile success flash**: A subtle green flash on the status text when compile succeeds:
   ```css
   @keyframes success-flash {
     0% { background: rgba(158, 206, 106, 0.2); }
     100% { background: transparent; }
   }
   .compile-group-status.flash-success {
     animation: success-flash 600ms var(--ease-out);
   }
   ```
   Apply via a short-lived class in the Toolbar component when status changes to "success".

5. **File item selection**: Add a subtle scale or background slide when clicking a file:
   ```css
   .file-item.active {
     background: var(--bg-lighter);
     transition: background var(--duration-fast) var(--ease-out);
   }
   ```
   (Already partially there, just ensure the transition property covers it.)

**Medium impact, medium effort:**

6. **Panel show/hide transitions**: Currently panels appear/disappear instantly via `<Show>`. SolidJS `<Show>` does not support exit animations natively. Two options:
   - **Option A (recommended)**: Use CSS `width`/`height` transitions instead of conditional rendering. Keep the element in DOM, collapse to 0:
     ```css
     .panel-wrapper { transition: width var(--duration-normal) var(--ease-out); overflow: hidden; }
     .panel-wrapper.collapsed { width: 0 !important; }
     ```
   - **Option B**: Use solid-transition-group for enter/exit animations (adds a dependency).

   Option A is simpler and works with the existing resize system.

7. **Diagnostic pill count badge**: When error count changes, pulse the badge:
   ```css
   @keyframes badge-bump {
     0% { transform: scale(1); }
     50% { transform: scale(1.2); }
     100% { transform: scale(1); }
   }
   ```
   Apply when the count signal changes.

**Low priority / nice-to-have:**

8. **Progress bar completion**: When progress reaches 100%, briefly flash brighter before fading out, rather than just opacity: 0.

9. **Conflict dialog entrance**: Already has `fade-in` on overlay. Add `scale-in` on the dialog box itself for a more polished feel.

10. **Scroll shadows**: Add CSS-only scroll shadows to `.file-list`, `.compile-logs-scroll`, `.diag-pill-list` using `background-attachment: local` gradient trick. Not an animation but improves interaction feedback.

#### Step 4: Conventions to follow

| Rule | Rationale |
|------|-----------|
| All durations through CSS variables | Consistency, easy to tune globally |
| `ease-out` for entrances, `ease-in` for exits | Matches physical expectation: things slow down as they arrive |
| Never animate `width`/`height` on large elements | Use `transform: scaleX/Y` or `max-height` for performance (panels are the exception since they need layout reflow) |
| No animation on initial page load | Elements should just be there. Only animate state changes. |
| `prefers-reduced-motion` media query | Respect OS settings. Wrap all keyframe animations: |
| | `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }` |
| Transform-based animations only for performance-critical paths | `opacity` and `transform` are GPU-composited. Avoid animating `box-shadow`, `border-color`, `background-color` on frequently-updating elements. |
| Keep press feedback under 100ms | Active states should feel instant. The current 150ms transition on `:active` is slightly too slow -- the scale should be instant (`transition: none` on the transform for `:active`). |

#### What to avoid

- **Bouncy/elastic animations**: Overshoot springs are fun but age poorly and feel gimmicky in a productivity tool. Keep `--ease-spring` subtle (the defined curve has only 1.56 overshoot, which is ~5% past target).
- **Staggered list animations**: Don't animate file list items appearing one by one. It slows down perception of readiness.
- **Color transitions on text**: Transitioning `color` on text elements causes rendering jitter on some browsers. Prefer `opacity` changes or background color transitions.
- **Animation on scroll**: No parallax, no scroll-triggered animations. This is a tool, not a landing page.

### Action Plan

1. Add timing tokens (`--ease-out`, `--duration-*`) to `:root` -- **Quick**
2. Add `@keyframes scale-in, slide-down, slide-up` and `prefers-reduced-motion` query -- **Quick**
3. Fix existing hardcoded hex colors to use variables -- **Quick**
4. Apply press feedback to all interactive elements -- **Quick**
5. Fix popover animation directions (compile logs down, diag pill up) -- **Quick**
6. Add compile success flash -- **Short** (CSS + small JS change in Toolbar)
7. Add panel collapse transitions (replace Show with CSS width:0) -- **Medium** (needs refactoring Show blocks in App.tsx)
8. Add resize handle grabbed state -- **Quick**
9. Add `prefers-reduced-motion` respect -- **Quick**

**Total effort for items 1-6, 8-9: Short (2-3 hours)**
**Item 7 (panel transitions): Medium (additional 2-3 hours)**

### Summary

- **Do not add Tailwind/UnoCSS.** The current architecture is clean, themeable, and small. Add a `[data-theme]` system and fix the ~6 hardcoded colors.
- **Animation system**: Add 4 CSS variables for timing, 3 new keyframes, extend press feedback to all interactive elements, fix popover directions, add compile success flash, and add `prefers-reduced-motion`. This creates a coherent, minimal animation vocabulary that covers all current interaction gaps.
