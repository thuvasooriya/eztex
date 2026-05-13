import { type Component, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { ProjectStore } from "../lib/project_store";
import {
  compression_summary,
  is_optimizable_image,
  optimize_image_file,
  output_mime_for_path,
  strip_icc_profile,
} from "../lib/image_tools";
import { get_setting } from "../lib/settings_store";
import { show_alert_modal } from "../lib/modal_store";

type Props = {
  store: ProjectStore;
  file: string;
  read_only?: boolean;
};

type Crop = { x: number; y: number; w: number; h: number };
type CropHandle = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const MIN_CROP = 5;
const icon_attrs = { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

const Icons = {
  crop: () => <svg {...icon_attrs}><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>,
  rotateLeft: () => <svg {...icon_attrs}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>,
  rotateRight: () => <svg {...icon_attrs}><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>,
  flipHorizontal: () => <svg {...icon_attrs}><path d="m3 7 5 5-5 5V7Z"/><path d="m21 7-5 5 5 5V7Z"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/></svg>,
  flipVertical: () => <svg {...icon_attrs}><path d="m7 3 5 5 5-5H7Z"/><path d="m7 21 5-5 5 5H7Z"/><path d="M20 12h2"/><path d="M14 12h2"/><path d="M8 12h2"/><path d="M2 12h2"/></svg>,
  sun: () => <svg {...icon_attrs}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>,
  contrast: () => <svg {...icon_attrs}><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20V2Z"/></svg>,
  reset: () => <svg {...icon_attrs}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>,
  check: () => <svg {...icon_attrs}><path d="M20 6 9 17l-5-5"/></svg>,
  x: () => <svg {...icon_attrs}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>,
  edit: () => <svg {...icon_attrs}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>,
  image: () => <svg {...icon_attrs}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const ImageEditor: Component<Props> = (props) => {
  let image: ImageBitmap | null = null;
  let image_url: string | null = null;
  let image_ref: HTMLImageElement | undefined;
  let saved_timer: number | undefined;
  let crop_drag: { handle: CropHandle; crop: Crop; start_x: number; start_y: number; rect: DOMRect } | null = null;
  let loaded_file = "";

  const [url, set_url] = createSignal<string | null>(null);
  const [error, set_error] = createSignal<string | null>(null);
  const [loaded, set_loaded] = createSignal(false);
  const [edit_mode, set_edit_mode] = createSignal(false);
  const [active_adjustment, set_active_adjustment] = createSignal<"brightness" | "contrast" | null>(null);
  const [rotation, set_rotation] = createSignal(0);
  const [flip_x, set_flip_x] = createSignal(false);
  const [flip_y, set_flip_y] = createSignal(false);
  const [brightness, set_brightness] = createSignal(100);
  const [contrast, set_contrast] = createSignal(100);
  const [crop, set_crop] = createSignal<Crop>({ x: 0, y: 0, w: 100, h: 100 });
  const [crop_enabled, set_crop_enabled] = createSignal(false);
  const [saving, set_saving] = createSignal(false);
  const [saved, set_saved] = createSignal(false);
  const [optimizing, set_optimizing] = createSignal(false);

  const can_optimize = createMemo(() => is_optimizable_image(props.file));
  const transform_style = createMemo(() => `rotate(${rotation()}deg) scale(${flip_x() ? -1 : 1}, ${flip_y() ? -1 : 1})`);
  const filter_style = createMemo(() => `brightness(${brightness()}%) contrast(${contrast()}%)`);
  const crop_dimensions = createMemo(() => {
    if (!image) return "";
    const c = crop();
    return `${Math.round((c.w / 100) * image.width)} x ${Math.round((c.h / 100) * image.height)}`;
  });

  function reset_editor() {
    set_rotation(0);
    set_flip_x(false);
    set_flip_y(false);
    set_brightness(100);
    set_contrast(100);
    set_crop({ x: 0, y: 0, w: 100, h: 100 });
    set_crop_enabled(false);
    set_active_adjustment(null);
  }

  function cleanup_image() {
    image?.close();
    image = null;
    if (image_url) URL.revokeObjectURL(image_url);
    image_url = null;
    set_url(null);
  }

  async function load_image() {
    cleanup_image();
    set_error(null);
    set_loaded(false);
    set_saved(false);
    if (loaded_file !== props.file) {
      loaded_file = props.file;
      set_edit_mode(false);
      reset_editor();
    }

    const content = props.store.get_content(props.file);
    if (!(content instanceof Uint8Array) || content.byteLength === 0) {
      set_error("Image bytes are not available yet.");
      return;
    }
    try {
      const bytes = new Uint8Array(content);
      const blob = new Blob([bytes], { type: output_mime_for_path(props.file) });
      image = await createImageBitmap(blob);
      image_url = URL.createObjectURL(blob);
      set_url(image_url);
      set_loaded(true);
    } catch (err) {
      set_error(err instanceof Error ? err.message : "Failed to decode image.");
    }
  }

  createEffect(on(() => [props.file, props.store.revision()] as const, () => { void load_image(); }));

  createEffect(() => {
    if (!active_adjustment()) return;
    const handle_pointer_down = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".image-adjust-popover") || target?.closest(".image-adjust-btn")) return;
      set_active_adjustment(null);
    };
    document.addEventListener("pointerdown", handle_pointer_down);
    onCleanup(() => document.removeEventListener("pointerdown", handle_pointer_down));
  });

  onCleanup(() => {
    if (saved_timer !== undefined) clearTimeout(saved_timer);
    cleanup_image();
    end_crop_drag();
  });

  function update_crop(next: Crop) {
    const w = clamp(next.w, MIN_CROP, 100);
    const h = clamp(next.h, MIN_CROP, 100);
    set_crop({
      x: clamp(next.x, 0, 100 - w),
      y: clamp(next.y, 0, 100 - h),
      w,
      h,
    });
  }

  function apply_crop_drag(client_x: number, client_y: number) {
    if (!crop_drag) return;
    const dx = ((client_x - crop_drag.start_x) / crop_drag.rect.width) * 100;
    const dy = ((client_y - crop_drag.start_y) / crop_drag.rect.height) * 100;
    const start = crop_drag.crop;
    let next = { ...start };

    if (crop_drag.handle === "move") {
      next.x = start.x + dx;
      next.y = start.y + dy;
    } else {
      if (crop_drag.handle.includes("w")) {
        const right = start.x + start.w;
        next.x = clamp(start.x + dx, 0, right - MIN_CROP);
        next.w = right - next.x;
      }
      if (crop_drag.handle.includes("e")) {
        next.w = clamp(start.w + dx, MIN_CROP, 100 - start.x);
      }
      if (crop_drag.handle.includes("n")) {
        const bottom = start.y + start.h;
        next.y = clamp(start.y + dy, 0, bottom - MIN_CROP);
        next.h = bottom - next.y;
      }
      if (crop_drag.handle.includes("s")) {
        next.h = clamp(start.h + dy, MIN_CROP, 100 - start.y);
      }
    }

    update_crop(next);
  }

  function handle_crop_pointer_move(e: PointerEvent) {
    apply_crop_drag(e.clientX, e.clientY);
  }

  function end_crop_drag() {
    if (!crop_drag) return;
    window.removeEventListener("pointermove", handle_crop_pointer_move);
    window.removeEventListener("pointerup", end_crop_drag);
    crop_drag = null;
  }

  function begin_crop_drag(e: PointerEvent, handle: CropHandle) {
    if (!image_ref) return;
    e.preventDefault();
    e.stopPropagation();
    crop_drag = { handle, crop: crop(), start_x: e.clientX, start_y: e.clientY, rect: image_ref.getBoundingClientRect() };
    window.addEventListener("pointermove", handle_crop_pointer_move);
    window.addEventListener("pointerup", end_crop_drag);
  }

  function start_editing() {
    reset_editor();
    set_edit_mode(true);
  }

  function cancel_editing() {
    set_edit_mode(false);
    reset_editor();
  }

  async function optimize_current() {
    if (optimizing() || !can_optimize()) return;
    set_optimizing(true);
    try {
      const result = await optimize_image_file(props.store, props.file, get_setting("optimization_quality"));
      await show_alert_modal({ title: "Image Optimized", message: compression_summary(result) });
    } catch (err) {
      await show_alert_modal({ title: "Optimize Failed", message: err instanceof Error ? err.message : String(err) });
    } finally {
      set_optimizing(false);
    }
  }

  async function apply_edits() {
    if (!image || saving() || props.read_only) return;
    set_saving(true);
    try {
      const c = crop();
      const sx = Math.round((c.x / 100) * image.width);
      const sy = Math.round((c.y / 100) * image.height);
      const sw = Math.max(1, Math.round((c.w / 100) * image.width));
      const sh = Math.max(1, Math.round((c.h / 100) * image.height));

      const cropped = document.createElement("canvas");
      cropped.width = sw;
      cropped.height = sh;
      const crop_ctx = cropped.getContext("2d");
      if (!crop_ctx) throw new Error("Canvas is not available");
      crop_ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      const rotated = Math.abs(rotation() % 180) === 90;
      const output = document.createElement("canvas");
      output.width = rotated ? sh : sw;
      output.height = rotated ? sw : sh;
      const ctx = output.getContext("2d");
      if (!ctx) throw new Error("Canvas is not available");
      ctx.filter = filter_style();
      ctx.translate(output.width / 2, output.height / 2);
      ctx.rotate((rotation() * Math.PI) / 180);
      ctx.scale(flip_x() ? -1 : 1, flip_y() ? -1 : 1);
      ctx.drawImage(cropped, -sw / 2, -sh / 2);

      const blob = await new Promise<Blob>((resolve, reject) => {
        output.toBlob((result) => result ? resolve(result) : reject(new Error("Failed to encode image")), output_mime_for_path(props.file), 0.9);
      });
      props.store.update_content(props.file, strip_icc_profile(new Uint8Array(await blob.arrayBuffer()), output_mime_for_path(props.file)));
      set_edit_mode(false);
      reset_editor();
      set_saved(true);
      if (saved_timer !== undefined) clearTimeout(saved_timer);
      saved_timer = window.setTimeout(() => set_saved(false), 1600);
    } finally {
      set_saving(false);
    }
  }

  return (
    <div class="image-preview-panel" aria-label={`Image preview ${props.file}`}>
      <Show when={!error()} fallback={<div class="image-preview-error">{error()}</div>}>
        <Show when={url() && loaded()} fallback={<div class="image-preview-error">Loading image...</div>}>
          <Show
            when={edit_mode()}
            fallback={
              <div class="image-preview-normal">
                <img src={url()!} class="image-preview-main" alt={props.file} />
                <div class="image-preview-meta">
                  <span>{props.file}</span>
                  <Show when={image}>{image!.width} x {image!.height}</Show>
                  <Show when={saved()}><span class="image-preview-saved">Saved</span></Show>
                </div>
                <div class="image-preview-floating-actions">
                  <Show when={can_optimize()}>
                    <button disabled={optimizing() || props.read_only} onClick={() => { void optimize_current(); }} title="Optimize image in place" aria-label="Optimize image in place">{Icons.image()}</button>
                  </Show>
                  <button disabled={props.read_only} onClick={start_editing} title="Edit image" aria-label="Edit image">{Icons.edit()}</button>
                </div>
              </div>
            }
          >
            <div class="image-edit-panel">
              <div class="image-edit-body">
                <div class="image-edit-stage">
                  <div class="image-edit-frame">
                    <img
                      ref={image_ref}
                      src={url()!}
                      class="image-edit-image"
                      alt={props.file}
                      style={{ transform: transform_style(), filter: filter_style() }}
                    />
                    <Show when={crop_enabled()}>
                      <div
                        class="image-crop-box"
                        style={{ left: `${crop().x}%`, top: `${crop().y}%`, width: `${crop().w}%`, height: `${crop().h}%` }}
                        onPointerDown={(e) => begin_crop_drag(e, "move")}
                      >
                        <span class="image-crop-size">{crop_dimensions()}</span>
                        <span class="image-crop-handle nw" onPointerDown={(e) => begin_crop_drag(e, "nw")} />
                        <span class="image-crop-handle n" onPointerDown={(e) => begin_crop_drag(e, "n")} />
                        <span class="image-crop-handle ne" onPointerDown={(e) => begin_crop_drag(e, "ne")} />
                        <span class="image-crop-handle e" onPointerDown={(e) => begin_crop_drag(e, "e")} />
                        <span class="image-crop-handle se" onPointerDown={(e) => begin_crop_drag(e, "se")} />
                        <span class="image-crop-handle s" onPointerDown={(e) => begin_crop_drag(e, "s")} />
                        <span class="image-crop-handle sw" onPointerDown={(e) => begin_crop_drag(e, "sw")} />
                        <span class="image-crop-handle w" onPointerDown={(e) => begin_crop_drag(e, "w")} />
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
              <div class="image-edit-toolbar" role="toolbar" aria-label="Image editing tools">
                <button class={crop_enabled() ? "active" : ""} onClick={() => set_crop_enabled((v) => !v)} title="Crop" aria-label="Crop">{Icons.crop()}</button>
                <button onClick={() => set_rotation((v) => (v + 270) % 360)} title="Rotate left" aria-label="Rotate left">{Icons.rotateLeft()}</button>
                <button onClick={() => set_rotation((v) => (v + 90) % 360)} title="Rotate right" aria-label="Rotate right">{Icons.rotateRight()}</button>
                <button onClick={() => set_flip_x((v) => !v)} title="Flip horizontal" aria-label="Flip horizontal">{Icons.flipHorizontal()}</button>
                <button onClick={() => set_flip_y((v) => !v)} title="Flip vertical" aria-label="Flip vertical">{Icons.flipVertical()}</button>
                <span class="image-adjust-control">
                  <button class={`image-adjust-btn ${active_adjustment() === "brightness" ? "active" : ""}`} onClick={() => set_active_adjustment((v) => v === "brightness" ? null : "brightness")} title="Brightness" aria-label="Brightness">{Icons.sun()}</button>
                  <Show when={active_adjustment() === "brightness"}>
                    <div class="image-adjust-popover" role="dialog" aria-label="Brightness adjustment">
                      <div class="image-adjust-title">Brightness <span>{brightness()}%</span></div>
                      <input type="range" min="50" max="150" value={brightness()} onInput={(e) => set_brightness(Number(e.currentTarget.value))} />
                      <button onClick={() => set_brightness(100)}>Reset</button>
                    </div>
                  </Show>
                </span>
                <span class="image-adjust-control">
                  <button class={`image-adjust-btn ${active_adjustment() === "contrast" ? "active" : ""}`} onClick={() => set_active_adjustment((v) => v === "contrast" ? null : "contrast")} title="Contrast" aria-label="Contrast">{Icons.contrast()}</button>
                  <Show when={active_adjustment() === "contrast"}>
                    <div class="image-adjust-popover" role="dialog" aria-label="Contrast adjustment">
                      <div class="image-adjust-title">Contrast <span>{contrast()}%</span></div>
                      <input type="range" min="50" max="150" value={contrast()} onInput={(e) => set_contrast(Number(e.currentTarget.value))} />
                      <button onClick={() => set_contrast(100)}>Reset</button>
                    </div>
                  </Show>
                </span>
                <button onClick={reset_editor} title="Reset edits" aria-label="Reset edits">{Icons.reset()}</button>
                <span class="image-edit-toolbar-spacer" />
                <button onClick={cancel_editing} title="Cancel editing" aria-label="Cancel editing">{Icons.x()}</button>
                <button class="primary" disabled={saving() || props.read_only} onClick={() => { void apply_edits().catch(async (err) => show_alert_modal({ title: "Image Save Failed", message: err instanceof Error ? err.message : String(err) })); }} title="Apply image edits" aria-label="Apply image edits">{Icons.check()}</button>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default ImageEditor;
