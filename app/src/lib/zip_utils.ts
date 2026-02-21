// zip utilities -- import/export project as zip

import JSZip from "jszip";

export async function read_zip(file: File): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(file);
  const result: Record<string, string> = {};

  // find common prefix (if all files share a directory prefix, strip it)
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const prefix = find_common_prefix(paths);

  for (const path of paths) {
    const entry = zip.files[path];
    // skip hidden/system files
    const name = prefix ? path.slice(prefix.length) : path;
    if (name.startsWith(".") || name.startsWith("__MACOSX") || !name) continue;
    // only include text-like files
    if (is_text_file(name)) {
      const content = await entry.async("string");
      result[name] = content;
    }
  }
  return result;
}

export async function write_zip(files: Record<string, string>): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "blob" });
}

function find_common_prefix(paths: string[]): string {
  if (paths.length === 0) return "";
  // check if all paths start with the same directory
  const first_slash = paths[0].indexOf("/");
  if (first_slash < 0) return "";
  const candidate = paths[0].slice(0, first_slash + 1);
  if (paths.every((p) => p.startsWith(candidate))) return candidate;
  return "";
}

function is_text_file(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const text_exts = new Set([
    "tex", "sty", "cls", "bib", "bst", "def", "cfg", "clo",
    "dtx", "fd", "txt", "md", "log", "aux", "toc", "lof",
    "lot", "idx", "ind", "gls", "glo", "ist", "bbl", "blg",
  ]);
  return text_exts.has(ext);
}
