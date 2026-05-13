import type { ProjectFiles } from "./project_store";

export type GraphicsRewrite = {
  tex_file: string;
  old_path: string;
  new_path: string;
};

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "pdf", "eps", "ps"];
const INCLUDEGRAPHICS_RE = /(\\includegraphics(?:\s*\[[^\]]*\])?\s*\{)([^}]+)(\})/g;

export function normalize_tex_path(path: string): string {
  let next = path.trim().replace(/\\/g, "/");
  while (next.startsWith("./")) next = next.slice(2);
  return next.replace(/\/+/g, "/");
}

export function basename(path: string): string {
  return normalize_tex_path(path).split("/").pop() ?? path;
}

export function jobname_for_main_file(main_file: string | undefined): string {
  if (!main_file) return "";
  const base = basename(main_file);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(0, dot) : base;
}

function find_tex_comment_index(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

function split_code_and_comment(line: string): { code: string; comment: string } {
  const comment_index = find_tex_comment_index(line);
  if (comment_index < 0) return { code: line, comment: "" };
  return { code: line.slice(0, comment_index), comment: line.slice(comment_index) };
}

export function strip_tex_comments(text: string): string {
  return text.split(/\r?\n/).map((line) => split_code_and_comment(line).code).join("\n");
}

export function visit_includegraphics(text: string, visit: (path: string) => void): void {
  const without_comments = strip_tex_comments(text);
  let match: RegExpExecArray | null;
  while ((match = INCLUDEGRAPHICS_RE.exec(without_comments)) !== null) {
    visit(normalize_tex_path(match[2]));
  }
}

export function rewrite_includegraphics(text: string, rewrite: (path: string) => string | null): string {
  return text.split(/(\r?\n)/).map((part) => {
    if (part === "\n" || part === "\r\n") return part;
    const { code, comment } = split_code_and_comment(part);
    const next = code.replace(INCLUDEGRAPHICS_RE, (_full, prefix: string, arg: string, suffix: string) => {
      const normalized = normalize_tex_path(arg);
      const replacement = rewrite(normalized);
      if (!replacement) return _full;
      const leading = arg.match(/^\s*/)?.[0] ?? "";
      const trailing = arg.match(/\s*$/)?.[0] ?? "";
      return `${prefix}${leading}${replacement}${trailing}${suffix}`;
    });
    return `${next}${comment}`;
  }).join("");
}

function with_known_exts(path: string): string[] {
  if (/\.[^/.]+$/.test(path)) return [path];
  return [path, ...IMAGE_EXTS.map((ext) => `${path}.${ext}`)];
}

export function resolve_graphics_path(path: string, file_names: Iterable<string>, main_file?: string): string | null {
  const files = new Set(Array.from(file_names, normalize_tex_path));
  const normalized = normalize_tex_path(path);
  for (const candidate of with_known_exts(normalized)) {
    if (files.has(candidate)) return candidate;
  }

  const jobname = jobname_for_main_file(main_file);
  if (jobname && normalized.startsWith(`${jobname}/`)) {
    const stripped = normalized.slice(jobname.length + 1);
    for (const candidate of with_known_exts(stripped)) {
      if (files.has(candidate)) return candidate;
    }
  }

  return null;
}

export function find_import_graphics_repairs(files: ProjectFiles, main_file?: string): GraphicsRewrite[] {
  const names = Object.keys(files);
  const repairs: GraphicsRewrite[] = [];
  const seen = new Set<string>();
  for (const [tex_file, content] of Object.entries(files)) {
    if (!tex_file.endsWith(".tex") || typeof content !== "string") continue;
    visit_includegraphics(content, (path) => {
      if (resolve_graphics_path(path, names, undefined)) return;
      const resolved = resolve_graphics_path(path, names, main_file);
      if (!resolved || resolved === path) return;
      const key = `${tex_file}\0${path}\0${resolved}`;
      if (seen.has(key)) return;
      seen.add(key);
      repairs.push({ tex_file, old_path: path, new_path: resolved });
    });
  }
  return repairs;
}

export function apply_graphics_rewrites_to_files(files: ProjectFiles, rewrites: GraphicsRewrite[]): ProjectFiles {
  if (rewrites.length === 0) return files;
  const by_file = new Map<string, Map<string, string>>();
  for (const rewrite of rewrites) {
    let map = by_file.get(rewrite.tex_file);
    if (!map) {
      map = new Map();
      by_file.set(rewrite.tex_file, map);
    }
    map.set(normalize_tex_path(rewrite.old_path), normalize_tex_path(rewrite.new_path));
  }
  const next: ProjectFiles = { ...files };
  for (const [tex_file, replacements] of by_file) {
    const content = next[tex_file];
    if (typeof content !== "string") continue;
    next[tex_file] = rewrite_includegraphics(content, (path) => replacements.get(path) ?? null);
  }
  return next;
}
