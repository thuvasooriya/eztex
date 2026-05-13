import type { ProjectStore } from "./project_store";
import { resolve_graphics_path, visit_includegraphics } from "./latex_graphics";

export type OptimizationQuality = 70 | 80 | 90;
export type ImageOptimizeResult = { path: string; old_bytes: number; new_bytes: number; changed: boolean };

const OPTIMIZABLE_EXTS = new Set(["png", "jpg", "jpeg"]);
const EDITABLE_EXTS = new Set(["png", "jpg", "jpeg"]);

function ext_of(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

async function bytes_to_image(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
  return await createImageBitmap(blob);
}

async function canvas_to_bytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error(`Failed to encode ${type}`)), type, quality);
  });
  return strip_icc_profile(new Uint8Array(await blob.arrayBuffer()), type);
}

function read_u32_be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function strip_png_metadata(bytes: Uint8Array): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < signature.length || !signature.every((value, index) => bytes[index] === value)) return bytes;
  const drop_chunks = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "pHYs"]);
  const chunks: Uint8Array[] = [bytes.slice(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = read_u32_be(bytes, offset);
    const chunk_end = offset + 12 + length;
    if (chunk_end > bytes.byteLength) return bytes;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (!drop_chunks.has(type)) chunks.push(bytes.slice(offset, chunk_end));
    offset = chunk_end;
    if (type === "IEND") break;
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let out_offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, out_offset);
    out_offset += chunk.byteLength;
  }
  return out;
}

function strip_jpeg_icc(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      parts.push(bytes.slice(offset));
      break;
    }
    let marker_offset = offset;
    while (marker_offset < bytes.byteLength && bytes[marker_offset] === 0xff) marker_offset++;
    if (marker_offset >= bytes.byteLength) break;
    const marker = bytes[marker_offset];
    offset = marker_offset + 1;
    if (marker === 0xda) {
      parts.push(bytes.slice(marker_offset - 1));
      break;
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.slice(marker_offset - 1, offset));
      continue;
    }
    if (offset + 2 > bytes.byteLength) return bytes;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const segment_end = offset + length;
    if (length < 2 || segment_end > bytes.byteLength) return bytes;
    if (marker !== 0xe2) parts.push(bytes.slice(marker_offset - 1, segment_end));
    offset = segment_end;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let out_offset = 0;
  for (const part of parts) {
    out.set(part, out_offset);
    out_offset += part.byteLength;
  }
  return out;
}

export function strip_icc_profile(bytes: Uint8Array, mime_type: string): Uint8Array {
  if (mime_type === "image/png") return strip_png_metadata(bytes);
  if (mime_type === "image/jpeg") return strip_jpeg_icc(bytes);
  return bytes;
}

export function is_optimizable_image(path: string): boolean {
  return OPTIMIZABLE_EXTS.has(ext_of(path));
}

export function is_editable_image(path: string): boolean {
  return EDITABLE_EXTS.has(ext_of(path));
}

export function image_reference_count(store: ProjectStore, path: string): number {
  const names = store.file_names();
  let count = 0;
  for (const tex of store.file_names().filter((name) => name.endsWith(".tex"))) {
    visit_includegraphics(store.get_text_content(tex), (ref) => {
      if (resolve_graphics_path(ref, names, store.main_file()) === path) count++;
    });
  }
  return count;
}

function yield_to_ui(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function encode_image_bytes(
  bytes: Uint8Array,
  type: string,
  quality?: number,
): Promise<Uint8Array> {
  const image = await bytes_to_image(bytes);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.drawImage(image, 0, 0);
    return await canvas_to_bytes(canvas, type, quality);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    image.close();
  }
}

export async function optimize_image_file(
  store: ProjectStore,
  path: string,
  quality: OptimizationQuality,
): Promise<ImageOptimizeResult> {
  if (!is_optimizable_image(path)) throw new Error(`${path} is not a PNG or JPEG image`);
  const content = store.get_content(path);
  if (!(content instanceof Uint8Array)) throw new Error(`${path} is not a binary file`);

  const converted = await encode_image_bytes(content, output_mime_for_path(path), quality / 100);
  if (converted.byteLength < content.byteLength) {
    store.update_content(path, converted);
    return { path, old_bytes: content.byteLength, new_bytes: converted.byteLength, changed: true };
  }
  return { path, old_bytes: content.byteLength, new_bytes: content.byteLength, changed: false };
}

export async function optimize_all_images(
  store: ProjectStore,
  quality: OptimizationQuality,
): Promise<ImageOptimizeResult[]> {
  const current = store.current_file();
  const targets = store.file_names().filter(is_optimizable_image);
  const results = [];
  for (const path of targets) {
    await yield_to_ui();
    results.push(await optimize_image_file(store, path, quality));
  }
  if (current && store.file_names().includes(current)) store.set_current_file(current);
  return results;
}

export function output_mime_for_path(path: string): string {
  const ext = ext_of(path);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/png";
}

export function format_image_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function compression_summary(result: ImageOptimizeResult): string {
  if (!result.changed) {
    return `${result.path} - ${format_image_bytes(result.old_bytes)}\nKept original because re-encoding was not smaller.`;
  }
  const smaller = result.old_bytes > 0
    ? Math.max(0, Math.round((1 - result.new_bytes / result.old_bytes) * 100))
    : 0;
  return `${result.path} - ${format_image_bytes(result.old_bytes)} -> ${format_image_bytes(result.new_bytes)}\n${smaller}% smaller`;
}
