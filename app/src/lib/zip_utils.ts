// zip utilities -- import/export project as zip

import JSZip from "jszip";
import type { ProjectFiles } from "./project_store";
import { is_binary } from "./project_store";

export async function read_zip(file: File): Promise<ProjectFiles> {
  const zip = await JSZip.loadAsync(file);
  const result: ProjectFiles = {};

  // find common prefix (if all files share a directory prefix, strip it)
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const prefix = find_common_prefix(paths);

  for (const path of paths) {
    const entry = zip.files[path];
    const name = prefix ? path.slice(prefix.length) : path;
    if (name.startsWith(".") || name.startsWith("__MACOSX") || !name) continue;
    if (!is_known_file(name)) continue;
    if (is_binary(name)) {
      const data = await entry.async("uint8array");
      result[name] = data;
    } else {
      const content = await entry.async("string");
      result[name] = content;
    }
  }
  return result;
}

export async function write_zip(files: ProjectFiles): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    if (content instanceof Uint8Array) {
      zip.file(name, content);
    } else {
      zip.file(name, content);
    }
  }
  return zip.generateAsync({ type: "blob" });
}

function find_common_prefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const first_slash = paths[0].indexOf("/");
  if (first_slash < 0) return "";
  const candidate = paths[0].slice(0, first_slash + 1);
  if (paths.every((p) => p.startsWith(candidate))) return candidate;
  return "";
}

const KNOWN_EXTS = new Set([
  // text
  "tex", "sty", "cls", "bib", "bst", "def", "cfg", "clo",
  "dtx", "fd", "txt", "md", "log", "aux", "toc", "lof",
  "lot", "idx", "ind", "gls", "glo", "ist", "bbl", "blg",
  // binary assets
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp",
  "ttf", "otf", "woff", "woff2",
  "pdf", "eps", "ps",
]);

function is_known_file(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return KNOWN_EXTS.has(ext);
}
