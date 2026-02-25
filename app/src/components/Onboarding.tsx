import { type Component, Show, createSignal, createEffect, onCleanup } from "solid-js";
import logo_svg from "/logo.svg?raw";

const ONBOARDED_KEY = "eztex_onboarded";

type TourStep = {
  target_selector: string;
  title: string;
  description: string;
  position_hint: "bottom" | "top" | "left" | "right";
};

const tour_steps: TourStep[] = [
  {
    target_selector: ".compile-group",
    title: "Compile toolbar",
    description: "This is your compile toolbar. The play button compiles your LaTeX document manually",
    position_hint: "bottom",
  },
  {
    target_selector: ".compile-group-watch",
    title: "Watch mode",
    description: "Watch mode auto-compiles if it detects a change. The icon turns green when active and turns yellow when it detects the code to be dirty and schedules a compilation",
    position_hint: "bottom",
  },
  {
    target_selector: ".compile-group-status",
    title: "Status & logs",
    description: "This shows compile status and elapsed time. Click it to open the log. The first compile downloads and generates the required files (~30MB) and will take a few minutes based on your system -- this only happens once unless you reset or clear the cache",
    position_hint: "bottom",
  },
  {
    target_selector: ".toolbar-file-actions",
    title: "Upload & download",
    description: "Upload files or open a local folder. Download your PDF or export the whole project as a zip",
    position_hint: "bottom",
  },
  {
    target_selector: ".file-panel-wrapper:not(.overlay-mode)",
    title: "File panel",
    description: "Your project files live here. Click to open, right-click for rename, delete, or to create new files and folders",
    position_hint: "right",
  },
  {
    target_selector: ".set-main-btn",
    title: "Entry file",
    description: "Click the dot next to a file to set it as the entry point for compilation",
    position_hint: "right",
  },
  {
    target_selector: ".diag-pill-container",
    title: "Diagnostics",
    description: "Errors and warnings from your LaTeX document appear here. Click to jump to the problem",
    position_hint: "top",
  },
  {
    target_selector: ".logo-btn",
    title: "Settings & info",
    description: "Click the eztex logo anytime to access settings, clear cache, or restart this tutorial",
    position_hint: "bottom",
  },
];

type Props = {
  visible: boolean;
  on_close: () => void;
};

type TooltipPos = {
  top: number;
  left: number;
  actual_side: "bottom" | "top" | "left" | "right";
};

function compute_tooltip_pos(rect: DOMRect, hint: TourStep["position_hint"], tw: number, th: number): TooltipPos {
  const gap = 12;
  const margin = 8;

  // try preferred side, fall back if off-screen
  const sides: Array<"bottom" | "top" | "left" | "right"> = [hint, "bottom", "top", "right", "left"];
  for (const side of sides) {
    let top = 0, left = 0;
    if (side === "bottom") {
      top = rect.bottom + gap;
      left = rect.left + rect.width / 2 - tw / 2;
    } else if (side === "top") {
      top = rect.top - gap - th;
      left = rect.left + rect.width / 2 - tw / 2;
    } else if (side === "right") {
      top = rect.top + rect.height / 2 - th / 2;
      left = rect.right + gap;
    } else {
      top = rect.top + rect.height / 2 - th / 2;
      left = rect.left - gap - tw;
    }
    // clamp
    left = Math.max(margin, Math.min(window.innerWidth - tw - margin, left));
    top = Math.max(margin, Math.min(window.innerHeight - th - margin, top));

    if (top >= margin && top + th <= window.innerHeight - margin &&
        left >= margin && left + tw <= window.innerWidth - margin) {
      return { top, left, actual_side: side };
    }
  }
  // fallback: center
  return {
    top: Math.max(margin, (window.innerHeight - th) / 2),
    left: Math.max(margin, (window.innerWidth - tw) / 2),
    actual_side: "bottom",
  };
}

const Onboarding: Component<Props> = (props) => {
  const [phase, set_phase] = createSignal<"welcome" | "tour" | "hidden">("welcome");
  const [step_index, set_step_index] = createSignal(0);
  const [target_rect, set_target_rect] = createSignal<DOMRect | null>(null);
  let tooltip_ref: HTMLDivElement | undefined;

  // reset phase when visibility changes
  createEffect(() => {
    if (props.visible) {
      set_phase("welcome");
      set_step_index(0);
    }
  });

  // update target rect on step change and on resize
  createEffect(() => {
    if (phase() !== "tour") return;
    const idx = step_index();
    const step = tour_steps[idx];
    if (!step) return;

    function update_rect() {
      const el = document.querySelector(step.target_selector);
      if (el) {
        set_target_rect(el.getBoundingClientRect());
      } else {
        set_target_rect(null);
      }
    }

    update_rect();
    // re-measure on resize/scroll
    window.addEventListener("resize", update_rect);
    const raf_id = requestAnimationFrame(update_rect);
    onCleanup(() => {
      window.removeEventListener("resize", update_rect);
      cancelAnimationFrame(raf_id);
    });
  });

  function current_step(): TourStep | undefined {
    return tour_steps[step_index()];
  }

  function active_steps(): TourStep[] {
    // filter to only steps whose target exists in the DOM
    return tour_steps.filter(s => document.querySelector(s.target_selector));
  }

  function active_index(): number {
    const steps = active_steps();
    const cs = current_step();
    return cs ? steps.indexOf(cs) : 0;
  }

  function active_count(): number {
    return active_steps().length;
  }

  function next() {
    // find next step that has a target in the DOM
    let idx = step_index() + 1;
    while (idx < tour_steps.length) {
      if (document.querySelector(tour_steps[idx].target_selector)) break;
      idx++;
    }
    if (idx >= tour_steps.length) {
      finish();
    } else {
      set_step_index(idx);
    }
  }

  function prev() {
    let idx = step_index() - 1;
    while (idx >= 0) {
      if (document.querySelector(tour_steps[idx].target_selector)) break;
      idx--;
    }
    if (idx >= 0) set_step_index(idx);
  }

  function start_tour() {
    set_phase("tour");
    // jump to first available step
    let idx = 0;
    while (idx < tour_steps.length && !document.querySelector(tour_steps[idx].target_selector)) idx++;
    set_step_index(idx < tour_steps.length ? idx : 0);
  }

  function skip_to_last() {
    set_phase("tour");
    // jump to last step (info panel)
    let idx = tour_steps.length - 1;
    while (idx >= 0 && !document.querySelector(tour_steps[idx].target_selector)) idx--;
    set_step_index(idx >= 0 ? idx : tour_steps.length - 1);
  }

  function finish() {
    localStorage.setItem(ONBOARDED_KEY, "true");
    set_phase("hidden");
    props.on_close();
  }

  // escape key handler
  createEffect(() => {
    if (!props.visible || phase() === "hidden") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  const is_last_step = () => {
    // check if current step is the last available
    let idx = step_index() + 1;
    while (idx < tour_steps.length) {
      if (document.querySelector(tour_steps[idx].target_selector)) return false;
      idx++;
    }
    return true;
  };

  const is_first_step = () => {
    let idx = step_index() - 1;
    while (idx >= 0) {
      if (document.querySelector(tour_steps[idx].target_selector)) return false;
      idx--;
    }
    return true;
  };

  // tooltip dimensions estimate (used for positioning)
  const TOOLTIP_W = 300;
  const TOOLTIP_H = 160;

  function tooltip_style(): Record<string, string> {
    const rect = target_rect();
    const step = current_step();
    if (!rect || !step) return { display: "none" };
    const pos = compute_tooltip_pos(rect, step.position_hint, TOOLTIP_W, TOOLTIP_H);
    return {
      position: "fixed",
      top: `${pos.top}px`,
      left: `${pos.left}px`,
      "z-index": "602",
    };
  }

  function highlight_style(): Record<string, string> {
    const rect = target_rect();
    if (!rect) return { display: "none" };
    const pad = 4;
    return {
      position: "fixed",
      top: `${rect.top - pad}px`,
      left: `${rect.left - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`,
      "z-index": "601",
    };
  }

  return (
    <Show when={props.visible && phase() !== "hidden"}>
      {/* welcome modal */}
      <Show when={phase() === "welcome"}>
        <div class="onboard-overlay" onClick={(e) => { if (e.target === e.currentTarget) finish(); }}>
          <div class="onboard-welcome">
            <div class="onboard-welcome-logo" innerHTML={logo_svg} />
            <div class="onboard-welcome-name">eztex</div>
            <p class="onboard-welcome-tagline">Eazy LaTeX in browser. </p>
            <div class="onboard-welcome-buttons">
              <button class="onboard-btn primary" onClick={start_tour}>Start tutorial</button>
              <button class="onboard-btn" onClick={skip_to_last}>Skip</button>
            </div>
          </div>
        </div>
      </Show>

      {/* tour overlay */}
      <Show when={phase() === "tour" && current_step()}>
        <div class={`onboard-tour-backdrop ${target_rect() ? "" : "dimmed"}`} onClick={finish} />
        <Show when={target_rect()}>
          <div class="onboard-highlight" style={highlight_style()} />
        </Show>
        <div class="onboard-tooltip" ref={tooltip_ref} style={tooltip_style()}>
          <div class="onboard-tooltip-header">
            <span class="onboard-tooltip-title">{current_step()!.title}</span>
            <span class="onboard-tooltip-progress">{active_index() + 1} / {active_count()}</span>
          </div>
          <p class="onboard-tooltip-desc">{current_step()!.description}</p>
          <div class="onboard-tooltip-nav">
            <Show when={!is_first_step()}>
              <button class="onboard-btn small" onClick={prev}>Prev</button>
            </Show>
            <div style={{ flex: "1" }} />
            <Show when={is_last_step()} fallback={
              <button class="onboard-btn small primary" onClick={next}>Next</button>
            }>
              <button class="onboard-btn small primary" onClick={finish}>Done</button>
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
};

export function is_onboarded(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) === "true";
}

export function clear_onboarded(): void {
  localStorage.removeItem(ONBOARDED_KEY);
}

export default Onboarding;
