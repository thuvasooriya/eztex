// project file store -- manages the in-memory file tree for multi-file projects

import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";

export type FileContent = string | Uint8Array;
export type ProjectFiles = Record<string, FileContent>;

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp",
  "ttf", "otf", "woff", "woff2",
  "pdf", "eps", "ps",
]);

export function is_binary(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTS.has(ext);
}

export function is_text_ext(name: string): boolean {
  return !is_binary(name);
}

export function create_project_store() {
  const [files, set_files] = createStore<ProjectFiles>({
    "main.tex": "",
  });

  const [current_file, set_current_file] = createSignal("main.tex");
  const [main_file, set_main_file] = createSignal("main.tex");
  const [revision, set_revision] = createSignal(0);

  // imperative change callbacks -- supports multiple subscribers
  const _on_change_cbs: Array<() => void> = [];
  function on_change(cb: () => void): () => void {
    _on_change_cbs.push(cb);
    return () => { const i = _on_change_cbs.indexOf(cb); if (i >= 0) _on_change_cbs.splice(i, 1); };
  }
  function _notify() { for (const cb of _on_change_cbs) cb(); }

  function file_names(): string[] {
    return Object.keys(files).sort((a, b) => {
      // main file first, then alphabetical
      if (a === main_file()) return -1;
      if (b === main_file()) return 1;
      return a.localeCompare(b);
    });
  }

  function add_file(name: string, content: FileContent = "") {
    set_files(produce((f) => { f[name] = content; }));
    set_current_file(name);
    _notify();
  }

  function remove_file(name: string) {
    if (name === main_file()) return;
    const names = Object.keys(files);
    if (names.length <= 1) return;
    set_files(produce((f) => { delete f[name]; }));
    if (current_file() === name) {
      set_current_file(main_file());
    }
    _notify();
  }

  function rename_file(old_name: string, new_name: string) {
    if (old_name === new_name) return;
    if (files[new_name] !== undefined) return;
    const content = files[old_name];
    set_files(produce((f) => {
      f[new_name] = content;
      delete f[old_name];
    }));
    if (current_file() === old_name) set_current_file(new_name);
    if (main_file() === old_name) set_main_file(new_name);
    _notify();
  }

  function update_content(name: string, content: FileContent) {
    set_files(produce((f) => { f[name] = content; }));
    _notify();
  }

  function get_content(name: string): FileContent {
    return files[name] ?? "";
  }

  function get_text_content(name: string): string {
    const c = files[name];
    if (c instanceof Uint8Array) return "";
    return c ?? "";
  }

  function clear_all() {
    const default_content = "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n";
    set_files(reconcile({ "main.tex": default_content }));
    set_current_file("main.tex");
    set_main_file("main.tex");
    set_revision(r => r + 1);
    _notify();
  }

  function load_files(new_files: ProjectFiles) {
    set_files(reconcile(new_files));
    const names = Object.keys(new_files);
    const main_candidates = ["main.tex", "paper.tex", "thesis.tex", "document.tex"];
    let detected = names.find((n) => main_candidates.includes(n));
    if (!detected) {
      detected = names.find((n) => {
        const c = new_files[n];
        return typeof c === "string" && c.includes("\\documentclass");
      });
    }
    if (!detected) detected = names[0];
    set_main_file(detected);
    set_revision(r => r + 1);
    set_current_file(detected);
    _notify();
  }

  // merge files into the existing project without replacing (for uploads into existing projects)
  function merge_files(new_files: ProjectFiles) {
    set_files(produce((f) => {
      for (const [name, content] of Object.entries(new_files)) {
        f[name] = content;
      }
    }));
    set_revision(r => r + 1);
    _notify();
  }

  // load initial project template from public/init/
  async function init_from_template(): Promise<void> {
    try {
      const manifest_resp = await fetch("/init/manifest.json");
      if (!manifest_resp.ok) return;
      const manifest: { files: string[] } = await manifest_resp.json();
      const template: ProjectFiles = {};
      await Promise.all(manifest.files.map(async (name) => {
        const resp = await fetch(`/init/${name}`);
        if (!resp.ok) return;
        if (is_binary(name)) {
          template[name] = new Uint8Array(await resp.arrayBuffer());
        } else {
          template[name] = await resp.text();
        }
      }));
      if (Object.keys(template).length > 0) {
        load_files(template);
      }
    } catch {
      // silently fall back to empty project
    }
  }

  return {
    files,
    current_file,
    set_current_file,
    main_file,
    set_main_file,
    revision,
    file_names,
    add_file,
    remove_file,
    rename_file,
    update_content,
    get_content,
    get_text_content,
    clear_all,
    load_files,
    merge_files,
    on_change,
    init_from_template,
  };
}

export type ProjectStore = ReturnType<typeof create_project_store>;
