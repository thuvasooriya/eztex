import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as Y from "yjs";
import {
  bind_y_project_doc,
  create_file_id,
  delete_file_entry,
  encode_snapshot,
  get_file_id,
  get_or_create_text_file,
  list_paths,
  rename_file_path,
  set_project_metadata,
  apply_snapshot,
  create_binary_file_ref,
} from "./y_project_doc";
import type { ProjectId, FileId } from "./y_project_doc";
import { compute_hash, save_blob as persist_blob, load_blob as load_persisted_blob } from "./project_persist";

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

const ORIGIN_LOCAL = "eztex:local";
const ORIGIN_REMOTE_BC = "eztex:remote-broadcast";
const ORIGIN_LOAD = "eztex:load";

export function create_project_store() {
  let pid: ProjectId = "";
  const ydoc = new Y.Doc();
  let yp = bind_y_project_doc(ydoc);
  const binary_cache = new Map<string, Uint8Array>();
  const _dirty_blob_paths = new Set<string>();

  const [files, set_files] = createStore<ProjectFiles>({ "main.tex": "" });
  const [current_file, set_current_file] = createSignal("main.tex");
  const [main_file, _set_main_file_raw] = createSignal("main.tex");
  function set_main_file(name: string) {
    if (name === main_file()) return;
    _set_main_file_raw(name);
    set_project_metadata(yp, { main_file: name });
  }
  const [revision, set_revision] = createSignal(0);

  const _on_change_cbs: Array<() => void> = [];
  function on_change(cb: () => void): () => void {
    _on_change_cbs.push(cb);
    return () => { const i = _on_change_cbs.indexOf(cb); if (i >= 0) _on_change_cbs.splice(i, 1); };
  }
  function _notify() { for (const cb of _on_change_cbs) cb(); }

  // BroadcastChannel state
  let bc: BroadcastChannel | null = null;
  const sender_id = crypto.randomUUID();

  function refresh_facade() {
    const new_files: ProjectFiles = {};
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
      const kind = meta?.get("kind") as string | undefined;
      if (kind === "binary") {
        new_files[path] = binary_cache.get(path) ?? new Uint8Array(0);
      } else {
        const ytext = yp.texts.get(fid);
        new_files[path] = ytext?.toString() ?? "";
      }
    }
    if (Object.keys(new_files).length === 0) {
      new_files["main.tex"] = "";
    }
    set_files(reconcile(new_files));
    set_revision(r => r + 1);
    _notify();
  }

  function broadcast_update(update: Uint8Array) {
    if (!bc || !pid) return;
    bc.postMessage({ type: "sync", sender_id, project_id: pid, update });
  }

  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN_LOAD && !bc) {
      // skip facade refresh during initial load before init
      return;
    }
    refresh_facade();
    if (origin !== ORIGIN_REMOTE_BC && origin !== ORIGIN_LOAD) {
      broadcast_update(update);
    }
  });

  function init(id: ProjectId) {
    pid = id;
    const channel_name = `eztex:yjs:${pid}`;
    bc = new BroadcastChannel(channel_name);

    bc.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || msg.sender_id === sender_id) return;
      if (msg.project_id !== pid) return;

      if (msg.type === "sync") {
        Y.applyUpdate(ydoc, msg.update, ORIGIN_REMOTE_BC);
      } else if (msg.type === "hello") {
        const state = Y.encodeStateAsUpdate(ydoc);
        bc!.postMessage({ type: "state-response", sender_id, project_id: pid, update: state });
      } else if (msg.type === "state-request") {
        const state = Y.encodeStateAsUpdate(ydoc);
        bc!.postMessage({ type: "state-response", sender_id, project_id: pid, update: state });
      } else if (msg.type === "state-response") {
        Y.applyUpdate(ydoc, msg.update, ORIGIN_REMOTE_BC);
      }
    };

    bc.postMessage({ type: "hello", sender_id, project_id: pid });
    bc.postMessage({ type: "state-request", sender_id, project_id: pid });
  }

  function file_names(): string[] {
    const mf = main_file();
    return list_paths(yp).sort((a, b) => {
      if (a === mf) return -1;
      if (b === mf) return 1;
      return a.localeCompare(b);
    });
  }

  function add_file(name: string, content: FileContent = "") {
    if (content instanceof Uint8Array) {
      binary_cache.set(name, content);
      _dirty_blob_paths.add(name);
      const fid = get_file_id(yp, name);
      if (!fid) {
        const now = Date.now();
        const new_fid = create_file_id();
        yp.doc.transact(() => {
          yp.paths.set(name, new_fid);
          const meta_map = new Y.Map<unknown>();
          meta_map.set("id", new_fid);
          meta_map.set("path", name);
          meta_map.set("kind", "binary");
          meta_map.set("created_at", now);
          meta_map.set("updated_at", now);
          meta_map.set("size", content.length);
          yp.file_meta.set(new_fid, meta_map);
        }, ORIGIN_LOCAL);
      }
    } else {
      get_or_create_text_file(yp, name, content);
    }
    set_current_file(name);
    if (!bc) {
      // before init, manually refresh since update handler skips
      refresh_facade();
    }
  }

  function remove_file(name: string) {
    if (name === main_file()) return;
    const paths = list_paths(yp);
    if (paths.length <= 1) return;
    binary_cache.delete(name);
    delete_file_entry(yp, name);
    if (current_file() === name) {
      set_current_file(main_file());
    }
    if (!bc) refresh_facade();
  }

  function rename_file(old_name: string, new_name: string) {
    if (old_name === new_name) return;
    const fid = get_file_id(yp, old_name);
    if (!fid) return;
    if (get_file_id(yp, new_name) !== undefined) return;

    const bin = binary_cache.get(old_name);
    rename_file_path(yp, old_name, new_name);
    if (bin) {
      binary_cache.delete(old_name);
      binary_cache.set(new_name, bin);
    }
    if (current_file() === old_name) set_current_file(new_name);
    if (main_file() === old_name) {
      _set_main_file_raw(new_name);
    }
    if (!bc) refresh_facade();
  }

  function update_content(name: string, content: FileContent) {
    if (content instanceof Uint8Array) {
      binary_cache.set(name, content);
      _dirty_blob_paths.add(name);
      const fid = get_file_id(yp, name);
      if (fid) {
        const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
        if (meta) {
          meta.set("updated_at", Date.now());
          meta.set("size", content.length);
        }
      } else {
        const now = Date.now();
        const new_fid = create_file_id();
        yp.doc.transact(() => {
          yp.paths.set(name, new_fid);
          const meta_map = new Y.Map<unknown>();
          meta_map.set("id", new_fid);
          meta_map.set("path", name);
          meta_map.set("kind", "binary");
          meta_map.set("created_at", now);
          meta_map.set("updated_at", now);
          meta_map.set("size", content.length);
          yp.file_meta.set(new_fid, meta_map);
        }, ORIGIN_LOCAL);
      }
      if (!bc) refresh_facade();
    } else {
      const fid = get_file_id(yp, name);
      if (fid) {
        const ytext = yp.texts.get(fid);
        if (ytext) {
          yp.doc.transact(() => {
            ytext.delete(0, ytext.length);
            ytext.insert(0, content);
          }, ORIGIN_LOCAL);
        }
      } else {
        get_or_create_text_file(yp, name, content);
      }
      if (!bc) refresh_facade();
    }
  }

  function get_content(name: string): FileContent {
    const fid = get_file_id(yp, name);
    if (!fid) return binary_cache.get(name) ?? files[name] ?? "";
    const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
    const kind = meta?.get("kind") as string | undefined;
    if (kind === "binary") {
      return binary_cache.get(name) ?? new Uint8Array(0);
    }
    const ytext = yp.texts.get(fid);
    return ytext?.toString() ?? "";
  }

  function get_text_content(name: string): string {
    const fid = get_file_id(yp, name);
    if (!fid) return "";
    const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
    const kind = meta?.get("kind") as string | undefined;
    if (kind === "binary") return "";
    const ytext = yp.texts.get(fid);
    return ytext?.toString() ?? "";
  }

  function clear_all() {
    const default_content = "\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n";
    binary_cache.clear();
    yp.doc.transact(() => {
      for (const path of Array.from(yp.paths.keys())) {
        const fid = yp.paths.get(path) as FileId;
        yp.paths.delete(path);
        yp.file_meta.delete(fid);
      }
      get_or_create_text_file(yp, "main.tex", default_content);
    }, ORIGIN_LOCAL);
    _set_main_file_raw("main.tex");
    set_current_file("main.tex");
    if (!bc) refresh_facade();
  }

  function load_files(new_files: ProjectFiles) {
    binary_cache.clear();
    yp.doc.transact(() => {
      for (const path of Array.from(yp.paths.keys())) {
        const fid = yp.paths.get(path) as FileId;
        yp.paths.delete(path);
        yp.file_meta.delete(fid);
      }
      for (const [path, content] of Object.entries(new_files)) {
        const fid = create_file_id();
        if (content instanceof Uint8Array) {
          binary_cache.set(path, content);
          const meta_map = new Y.Map<unknown>();
          meta_map.set("id", fid);
          meta_map.set("path", path);
          meta_map.set("kind", "binary");
          meta_map.set("created_at", Date.now());
          meta_map.set("updated_at", Date.now());
          meta_map.set("size", content.length);
          yp.file_meta.set(fid, meta_map);
          yp.paths.set(path, fid);
        } else {
          const meta_map = new Y.Map<unknown>();
          meta_map.set("id", fid);
          meta_map.set("path", path);
          meta_map.set("kind", "text");
          meta_map.set("created_at", Date.now());
          meta_map.set("updated_at", Date.now());
          yp.file_meta.set(fid, meta_map);
          yp.paths.set(path, fid);
          const ytext = new Y.Text();
          ytext.insert(0, content);
          yp.texts.set(fid, ytext);
        }
      }
    }, ORIGIN_LOAD);

    const names = Object.keys(new_files);
    const main_candidates = ["main.tex", "paper.tex", "thesis.tex", "document.tex"];
    let detected = names.find(n => main_candidates.includes(n));
    if (!detected) {
      detected = names.find(n => {
        const c = new_files[n];
        return typeof c === "string" && c.includes("\\documentclass");
      });
    }
    if (!detected) detected = names[0];
    _set_main_file_raw(detected);
    set_project_metadata(yp, { main_file: detected });
    set_current_file(detected);
    if (!bc) refresh_facade();
  }

  function merge_files(new_files: ProjectFiles) {
    yp.doc.transact(() => {
      for (const [path, content] of Object.entries(new_files)) {
        if (content instanceof Uint8Array) {
          binary_cache.set(path, content);
          _dirty_blob_paths.add(path);
          const fid = get_file_id(yp, path);
          if (fid) {
            const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
            if (meta) {
              meta.set("updated_at", Date.now());
              meta.set("size", content.length);
            }
          } else {
            const new_fid = create_file_id();
            const now = Date.now();
            const meta_map = new Y.Map<unknown>();
            meta_map.set("id", new_fid);
            meta_map.set("path", path);
            meta_map.set("kind", "binary");
            meta_map.set("created_at", now);
            meta_map.set("updated_at", now);
            meta_map.set("size", content.length);
            yp.file_meta.set(new_fid, meta_map);
            yp.paths.set(path, new_fid);
          }
        } else {
          const fid = get_file_id(yp, path);
          if (fid) {
            const ytext = yp.texts.get(fid);
            if (ytext) {
              ytext.delete(0, ytext.length);
              ytext.insert(0, content);
            }
          } else {
            get_or_create_text_file(yp, path, content);
          }
        }
      }
    }, ORIGIN_LOCAL);
    if (!bc) refresh_facade();
  }

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

  function get_ytext(path: string): Y.Text {
    const fid = get_file_id(yp, path);
    if (fid) {
      const ytext = yp.texts.get(fid);
      if (ytext) return ytext;
    }
    return get_or_create_text_file(yp, path, "");
  }

  async function snapshot_files(): Promise<ProjectFiles> {
    const result: ProjectFiles = {};
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
      const kind = meta?.get("kind") as string | undefined;
      if (kind === "binary") {
        const cached = binary_cache.get(path);
        if (cached) result[path] = cached;
      } else {
        const ytext = yp.texts.get(fid);
        result[path] = ytext?.toString() ?? "";
      }
    }
    return result;
  }

  function encode_ydoc_snapshot(): Uint8Array {
    return encode_snapshot(ydoc);
  }

  function apply_ydoc_snapshot(bytes: Uint8Array) {
    apply_snapshot(ydoc, bytes, ORIGIN_LOAD);
  }

  async function flush_dirty_blobs(): Promise<void> {
    if (!pid || _dirty_blob_paths.size === 0) return;
    const paths = Array.from(_dirty_blob_paths);
    _dirty_blob_paths.clear();
    for (const path of paths) {
      const bytes = binary_cache.get(path);
      if (!bytes) continue;
      const hash = await compute_hash(bytes);
      create_binary_file_ref(yp, path, hash, bytes.length);
      await persist_blob(pid, hash, bytes);
    }
  }

  async function load_persisted_blobs(): Promise<void> {
    if (!pid) return;
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const hash = yp.blob_refs.get(fid) as string | undefined;
      if (hash && !binary_cache.has(path)) {
        const bytes = await load_persisted_blob(pid, hash);
        if (bytes) binary_cache.set(path, bytes);
      }
    }
  }

  function destroy() {
    if (bc) {
      bc.close();
      bc = null;
    }
    ydoc.destroy();
  }

  return {
    // compatibility facade -- not source of truth for text content
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
    // new Yjs API
    project_id: () => pid,
    ydoc: () => ydoc,
    get_ytext,
    snapshot_files,
    encode_ydoc_snapshot,
    apply_ydoc_snapshot,
    flush_dirty_blobs,
    load_persisted_blobs,
    init,
    destroy,
  };
}

export type ProjectStore = ReturnType<typeof create_project_store>;
