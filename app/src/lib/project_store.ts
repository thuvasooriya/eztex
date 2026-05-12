import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
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
import { compute_hash, base64url_encode, base64url_decode } from "./crypto_utils";
import type { BlobStore } from "./blob_store";
import type { ProjectBroadcast } from "./project_broadcast";

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
  let _pid: ProjectId = "";
  let snapshot_expected = false;
  const [project_id_signal, set_project_id_signal] = createSignal<ProjectId>("");
  let ydoc = new Y.Doc();
  let yp = bind_y_project_doc(ydoc);
  let awareness = new Awareness(ydoc);
  const binary_cache = new Map<string, Uint8Array>();
  const _dirty_blob_paths = new Set<string>();
  let _blob_store: BlobStore | null = null;
  let _broadcast: ProjectBroadcast | null = null;
  let _owns_doc = true;

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

  let _update_handler: ((update: Uint8Array, origin: unknown) => void) | null = null;

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
    if (Object.keys(new_files).length === 0 && !_pid && !snapshot_expected) {
      new_files["main.tex"] = "";
    }
    set_files(reconcile(new_files));
    set_revision(r => r + 1);
    _notify();
  }

  function broadcast_update(update: Uint8Array) {
    if (_broadcast) {
      _broadcast.send_yjs_update(update);
    }
  }

  function setup_update_handler() {
    if (_update_handler) {
      ydoc.off("update", _update_handler);
    }
    _update_handler = (update: Uint8Array, origin: unknown) => {
      if (origin === ORIGIN_LOAD && !_broadcast) {
        return;
      }
      refresh_facade();
      if (origin !== ORIGIN_REMOTE_BC && origin !== ORIGIN_LOAD) {
        broadcast_update(update);
      }
    };
    ydoc.on("update", _update_handler);
  }

  setup_update_handler();

  function broadcast_blob_available(hash: string) {
    if (_broadcast) {
      _broadcast.send_blob_available(hash);
    }
  }

  function broadcast_blob_request(hash: string) {
    if (_broadcast) {
      _broadcast.send_blob_request(hash);
    }
  }

  function broadcast_blob_response(hash: string, bytes: Uint8Array) {
    if (_broadcast) {
      _broadcast.send_blob_response(hash, bytes);
    }
  }

  async function handle_blob_available(hash: string | undefined) {
    if (!hash) return;
    const found = binary_cache.has(hash) || await (_blob_store?.has(hash) ?? Promise.resolve(false));
    if (!found) {
      broadcast_blob_request(hash);
    }
  }

  async function handle_blob_request(hash: string | undefined) {
    if (!hash) return;
    let bytes: Uint8Array | null = null;
    if (_blob_store) {
      bytes = await _blob_store.get(hash);
    }
    if (!bytes) {
      for (const [, cached] of binary_cache) {
        if (cached instanceof Uint8Array) {
          try {
            const h = await compute_hash(cached);
            if (h === hash) { bytes = cached; break; }
          } catch { /* skip */ }
        }
      }
    }
    if (bytes) {
      broadcast_blob_response(hash, bytes);
    }
  }

  async function handle_blob_response(hash: string | undefined, bytes: Uint8Array | undefined) {
    if (!hash || !bytes) return;
    if (_blob_store) {
      await _blob_store.put(bytes);
    }
    let updated = false;
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const ref_hash = yp.blob_refs.get(fid) as string | undefined;
      if (ref_hash === hash) {
        binary_cache.set(path, bytes);
        updated = true;
      }
    }
    if (updated) refresh_facade();
  }

  function init_with_doc(
    id: ProjectId,
    external_doc: Y.Doc,
    blob_store: BlobStore,
    broadcast: ProjectBroadcast,
  ) {
    if (_update_handler) {
      ydoc.off("update", _update_handler);
    }

    if (_owns_doc) {
      awareness.destroy();
    }

    _pid = id;
    snapshot_expected = false;
    set_project_id_signal(id);
    ydoc = external_doc;
    yp = bind_y_project_doc(ydoc);
    awareness = new Awareness(ydoc);
    _blob_store = blob_store;
    _broadcast = broadcast;
    _owns_doc = false;

    setup_update_handler();
    refresh_facade();
  }

  function file_names(): string[] {
    revision();
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
      compute_hash(content).then((hash) => {
        broadcast_blob_available(hash);
      }).catch(() => {});
    } else {
      get_or_create_text_file(yp, name, content);
    }
    set_current_file(name);
    if (!_broadcast) {
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
    if (!_broadcast) refresh_facade();
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
      if (_dirty_blob_paths.has(old_name)) {
        _dirty_blob_paths.delete(old_name);
        _dirty_blob_paths.add(new_name);
      }
    }
    if (current_file() === old_name) set_current_file(new_name);
    if (main_file() === old_name) {
      set_main_file(new_name);
    }
    if (!_broadcast) refresh_facade();
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
      compute_hash(content).then((hash) => {
        broadcast_blob_available(hash);
      }).catch(() => {});
      if (!_broadcast) refresh_facade();
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
      if (!_broadcast) refresh_facade();
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
        yp.texts.delete(fid);
        yp.blob_refs.delete(fid);
      }
      get_or_create_text_file(yp, "main.tex", default_content);
    }, ORIGIN_LOCAL);
    _set_main_file_raw("main.tex");
    set_current_file("main.tex");
    if (!_broadcast) refresh_facade();
  }

  function load_files(new_files: ProjectFiles) {
    binary_cache.clear();
    yp.doc.transact(() => {
      for (const path of Array.from(yp.paths.keys())) {
        const fid = yp.paths.get(path) as FileId;
        yp.paths.delete(path);
        yp.file_meta.delete(fid);
        yp.texts.delete(fid);
        yp.blob_refs.delete(fid);
      }
      for (const [path, content] of Object.entries(new_files)) {
        const fid = create_file_id();
        if (content instanceof Uint8Array) {
          binary_cache.set(path, content);
          _dirty_blob_paths.add(path);
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
    if (!_broadcast) refresh_facade();
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
    if (!_broadcast) refresh_facade();
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
    snapshot_expected = false;
  }

  function clear_snapshot_expected() {
    snapshot_expected = false;
  }

  async function flush_dirty_blobs(): Promise<void> {
    if (!_pid || _dirty_blob_paths.size === 0) return;
    const paths = Array.from(_dirty_blob_paths);
    for (const path of paths) {
      const bytes = binary_cache.get(path);
      if (!bytes) {
        continue;
      }
      try {
        const hash = await compute_hash(bytes);
        create_binary_file_ref(yp, path, hash, bytes.length);
        if (_blob_store) {
          await _blob_store.put(bytes);
        }
        broadcast_blob_available(hash);
        _dirty_blob_paths.delete(path);
      } catch {
        // Leave path in _dirty_blob_paths so retry can pick it up
      }
    }
  }

  async function load_persisted_blobs(): Promise<void> {
    if (!_pid) return;
    let loaded_any = false;
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const hash = yp.blob_refs.get(fid) as string | undefined;
      if (hash && !binary_cache.has(path)) {
        let bytes: Uint8Array | null = null;
        if (_blob_store) {
          bytes = await _blob_store.get(hash);
        }
        if (bytes) {
          binary_cache.set(path, bytes);
          loaded_any = true;
        }
      }
    }
    if (loaded_any) refresh_facade();
  }

  async function export_blobs(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const path of list_paths(yp)) {
      const fid = get_file_id(yp, path);
      if (!fid) continue;
      const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
      const kind = meta?.get("kind") as string | undefined;
      if (kind !== "binary") continue;
      const hash = yp.blob_refs.get(fid) as string | undefined;
      if (!hash) continue;

      let bytes = binary_cache.get(path);
      if (!bytes && _blob_store) {
        bytes = (await _blob_store.get(hash)) ?? undefined;
        if (bytes) binary_cache.set(path, bytes);
      }
      if (bytes) {
        result[hash] = base64url_encode(bytes);
      }
    }
    return result;
  }

  async function import_blobs(blobs: Record<string, string>): Promise<void> {
    for (const [hash, b64] of Object.entries(blobs)) {
      try {
        const bytes = base64url_decode(b64);
        if (_blob_store) {
          await _blob_store.put(bytes);
        }
        for (const path of list_paths(yp)) {
          const fid = get_file_id(yp, path);
          if (!fid) continue;
          const blob_hash = yp.blob_refs.get(fid) as string | undefined;
          if (blob_hash === hash) {
            binary_cache.set(path, bytes);
          }
        }
      } catch {
        // skip invalid blobs
      }
    }
    refresh_facade();
  }

  function destroy() {
    if (_update_handler && ydoc) {
      ydoc.off("update", _update_handler);
      _update_handler = null;
    }
    if (_broadcast) {
      _broadcast.close();
    }
    _broadcast = null;
    _blob_store = null;
    awareness.destroy();
    if (_owns_doc) {
      ydoc.destroy();
    }
  }

  const [room_id_signal, set_room_id_signal] = createSignal<string | undefined>(undefined);

  function room_id(): string | undefined {
    return room_id_signal();
  }

  function dirty_blob_count(): number {
    return _dirty_blob_paths.size;
  }

  function set_room_id(rid: string | undefined) {
    set_room_id_signal(rid);
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
    project_id: project_id_signal,
    ydoc: () => ydoc,
    awareness: () => awareness,
    room_id,
    set_room_id,
    dirty_blob_count,
    get_ytext,
    snapshot_files,
    encode_ydoc_snapshot,
    apply_ydoc_snapshot,
    clear_snapshot_expected,
    flush_dirty_blobs,
    load_persisted_blobs,
    export_blobs,
    import_blobs,
    init_with_doc,
    destroy,
    handle_blob_available,
    handle_blob_request,
    handle_blob_response,
  };
}

export type ProjectStore = ReturnType<typeof create_project_store>;
