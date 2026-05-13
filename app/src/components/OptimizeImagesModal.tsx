import { type Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ProjectStore } from "../lib/project_store";
import {
  compression_summary,
  format_image_bytes,
  image_reference_count,
  is_optimizable_image,
  optimize_image_file,
  type ImageOptimizeResult,
  type OptimizationQuality,
} from "../lib/image_tools";
import { get_setting } from "../lib/settings_store";
import { is_modal_open, show_alert_modal, show_choice_modal } from "../lib/modal_store";
import { current_focus_target, focus_first_element, restore_focus, trap_tab_key } from "../lib/focus_utils";

type ImageRow = {
  path: string;
  size: number;
  refs: number;
};

type Props = {
  store: ProjectStore;
  show: boolean;
  on_close: () => void;
};

const OptimizeImagesModal: Component<Props> = (props) => {
  const [selected, set_selected] = createSignal<Set<string>>(new Set());
  const [quality, set_quality] = createSignal<OptimizationQuality>(get_setting("optimization_quality"));
  const [running, set_running] = createSignal(false);
  const [confirming, set_confirming] = createSignal(false);
  const [progress, set_progress] = createSignal("");
  const [results, set_results] = createSignal<ImageOptimizeResult[]>([]);
  const [initialized_key, set_initialized_key] = createSignal("");
  let modal_ref: HTMLElement | undefined;
  let optimize_button_ref: HTMLButtonElement | undefined;
  let restore_target: HTMLElement | null = null;

  const rows = createMemo<ImageRow[]>(() => {
    props.store.revision();
    return props.store.file_names().filter(is_optimizable_image).map((path) => {
      const content = props.store.get_content(path);
      return {
        path,
        size: content instanceof Uint8Array ? content.byteLength : 0,
        refs: image_reference_count(props.store, path),
      };
    });
  });

  createEffect(() => {
    if (!props.show) {
      set_initialized_key("");
      set_results([]);
      set_progress("");
      return;
    }
    if (running() || results().length > 0) return;
    const key = rows().map((row) => `${row.path}:${row.size}`).join("|");
    if (initialized_key() === key) return;
    set_initialized_key(key);
    set_selected(new Set(rows().map((row) => row.path)));
    set_quality(get_setting("optimization_quality"));
    set_results([]);
    set_progress("");
  });

  const selected_count = createMemo(() => rows().filter((row) => selected().has(row.path)).length);
  const selected_rows = createMemo(() => rows().filter((row) => selected().has(row.path)));
  const selected_ref_count = createMemo(() => selected_rows().reduce((sum, row) => sum + row.refs, 0));
  const busy = createMemo(() => running() || confirming());

  createEffect(() => {
    if (!props.show) return;
    restore_target = current_focus_target();
    requestAnimationFrame(() => { if (modal_ref) focus_first_element(modal_ref); });

    const on_key = (e: KeyboardEvent) => {
      if (is_modal_open()) return;
      handle_keydown(e);
    };
    document.addEventListener("keydown", on_key);
    onCleanup(() => {
      document.removeEventListener("keydown", on_key);
      const target = restore_target;
      restore_target = null;
      restore_focus(target);
    });
  });

  function set_path_checked(path: string, checked: boolean) {
    set_selected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function select_all() {
    set_selected(new Set(rows().map((row) => row.path)));
  }

  function deselect_all() {
    set_selected(new Set<string>());
  }

  function yield_to_ui(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function optimize_selected() {
    if (busy() || selected_count() === 0) return;
    const targets = rows().filter((row) => selected().has(row.path));
    set_confirming(true);
    const choice = await show_choice_modal({
      title: "Overwrite Images?",
      message: `This will optimize ${targets.length} image${targets.length === 1 ? "" : "s"} in place. Smaller optimized files replace the originals; images that do not get smaller are kept unchanged.`,
      options: [
        { label: "Optimize in place", value: "optimize", variant: "primary" },
        { label: "Cancel", value: "cancel", variant: "default" },
      ],
    });
    set_confirming(false);
    if (choice !== "optimize") {
      requestAnimationFrame(() => optimize_button_ref?.focus({ preventScroll: true }));
      return;
    }
    set_running(true);
    set_results([]);
    try {
      const next_results: ImageOptimizeResult[] = [];
      for (let i = 0; i < targets.length; i++) {
        const row = targets[i];
        set_progress(`Optimizing ${i + 1}/${targets.length}: ${row.path}`);
        await yield_to_ui();
        const result = await optimize_image_file(props.store, row.path, quality());
        next_results.push(result);
        set_results([...next_results]);
      }
      set_selected(new Set<string>());
      const changed = next_results.filter((result) => result.changed).length;
      set_progress(`Optimized ${changed}/${next_results.length} image${next_results.length === 1 ? "" : "s"}.`);
    } catch (err) {
      await show_alert_modal({ title: "Optimize Failed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      set_running(false);
    }
  }

  function handle_keydown(e: KeyboardEvent) {
    if (e.key === "Tab" && modal_ref) {
      trap_tab_key(e, modal_ref);
      return;
    }
    if (e.key === "Escape" && !busy()) {
      e.preventDefault();
      props.on_close();
    }
  }

  return (
    <Show when={props.show}>
      <div class="optimize-modal-backdrop" onClick={() => { if (!busy()) props.on_close(); }}>
        <section ref={modal_ref} class="optimize-modal" role="dialog" aria-modal="true" aria-label="Optimize project images" tabindex="-1" onClick={(e) => e.stopPropagation()} onKeyDown={handle_keydown}>
          <div class="optimize-modal-header">
            <div>
              <div class="optimize-modal-title">Optimize Images</div>
              <div class="optimize-modal-subtitle">Re-encode selected PNG/JPEG files in place.</div>
            </div>
            <button class="optimize-modal-close" disabled={busy()} onClick={props.on_close} aria-label="Close optimize images">x</button>
          </div>
          <div class="optimize-modal-actions">
            <button onClick={select_all} disabled={busy()}>Select All</button>
            <button onClick={deselect_all} disabled={busy()}>Deselect All</button>
            <label class="optimize-modal-check">
              Quality
              <select class="optimize-quality-select" value={quality()} disabled={busy()} onChange={(e) => set_quality(Number(e.currentTarget.value) as OptimizationQuality)}>
                <option value="70">70%</option>
                <option value="80">80%</option>
                <option value="90">90%</option>
              </select>
            </label>
          </div>
          <div class="optimize-plan">
            {selected_count() === 0
              ? "Select images to optimize. Filenames stay unchanged, so LaTeX references do not need updates."
              : `${selected_count()} selected - ${selected_ref_count()} includegraphics ref${selected_ref_count() === 1 ? "" : "s"}. Smaller outputs overwrite originals.`}
          </div>
          <div class="optimize-list" role="list" aria-label="Optimizable images">
            <For each={rows()}>
              {(row) => (
                <article class="optimize-card" classList={{ selected: selected().has(row.path) }} role="listitem">
                  <label class="optimize-card-main">
                    <input type="checkbox" aria-label={`Select ${row.path}`} checked={selected().has(row.path)} disabled={busy()} onChange={(e) => set_path_checked(row.path, e.currentTarget.checked)} />
                    <span class="optimize-card-text">
                      <span class="optimize-file-name">{row.path}</span>
                      <span class="optimize-card-meta">
                        {format_image_bytes(row.size)} - {row.refs > 0 ? `${row.refs} ref${row.refs === 1 ? "" : "s"}` : "not referenced"}
                      </span>
                    </span>
                  </label>
                  <div class="optimize-card-side">
                    <span class="optimize-status">Ready</span>
                  </div>
                </article>
              )}
            </For>
            <Show when={rows().length === 0}>
              <div class="optimize-empty">No PNG or JPEG images found.</div>
            </Show>
          </div>
          <Show when={progress()}>
            <div class="optimize-progress">{progress()}</div>
          </Show>
          <Show when={results().length > 0}>
            <div class="optimize-results">
              <For each={results()}>
                {(result) => <pre>{compression_summary(result)}</pre>}
              </For>
            </div>
          </Show>
          <div class="optimize-modal-footer">
            <span class="optimize-footer-note">Filenames and LaTeX references stay unchanged.</span>
            <button ref={optimize_button_ref} class="optimize-primary" disabled={busy() || selected_count() === 0} onClick={() => { void optimize_selected(); }}>
              {running() ? "Optimizing..." : confirming() ? "Confirming..." : `Optimize Selected (${selected_count()})`}
            </button>
          </div>
        </section>
      </div>
    </Show>
  );
};

export default OptimizeImagesModal;
