// local folder sync -- one-way outbound persistence from ProjectStore to a user-selected directory
// uses File System Access API (Chrome/Edge only)

import { createSignal } from "solid-js";
import type { ProjectStore, FileContent, ProjectFiles } from "./project_store";
import { is_binary } from "./project_store";

// --- constants ---

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const IGNORED_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "__pycache__",
  ".DS_Store", "Thumbs.db",
  "__MACOSX",
]);

const IGNORED_PREFIXES = [".", "_minted-"];

const SYNC_EXTS = new Set([
  "tex", "sty", "cls", "bib", "bst", "def", "cfg", "clo", "dtx", "fd",
  "txt", "md",
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico", "webp",
  "ttf", "otf", "woff", "woff2",
  "pdf", "eps", "ps",
]);

const DB_NAME = "eztex-folder-sync";
const STORE_NAME = "handles";
const IDLE_TIMEOUT_MS = 30_000;

// --- types ---

export interface LocalSyncState {
  dir_handle: FileSystemDirectoryHandle | null;
  folder_name: string;
  active: boolean;
  baseline_hashes: Map<string, string>;
  last_sync: number;
  syncing: boolean;
  dirty_files: Set<string>;
  error: string | null;
}

export type SyncResult =
  | { status: "ok"; files_written: number }
  | { status: "conflict"; conflicts: ConflictInfo[] }
  | { status: "error"; message: string };

export interface ConflictInfo {
  path: string;
  eztex_content: FileContent;
  disk_content: FileContent;
  eztex_hash: string;
  disk_hash: string;
}

export interface LocalFolderSync {
  state: () => LocalSyncState;
  open_folder: () => Promise<boolean>;
  reconnect: () => Promise<boolean>;
  disconnect: () => void;
  sync_now: () => Promise<SyncResult>;
  sync_file: (path: string) => Promise<SyncResult>;
  resolve_conflict: (path: string, resolution: "eztex" | "disk") => Promise<void>;
  write_pdf: (bytes: Uint8Array) => Promise<void>;
  is_supported: () => boolean;
  has_stored_handle: () => Promise<boolean>;
  get_stored_folder_name: () => Promise<string | null>;
}

// --- helpers ---

function is_ignored_dir(name: string): boolean {
  return IGNORED_DIRS.has(name) || IGNORED_PREFIXES.some(p => name.startsWith(p));
}

function is_sync_ext(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return SYNC_EXTS.has(ext);
}

async function hash_content(content: FileContent): Promise<string> {
  const data = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(content);
  const ab = new Uint8Array(data).buffer as ArrayBuffer;
  const buf = await crypto.subtle.digest("SHA-1", ab);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function* walk_directory(
  dir: FileSystemDirectoryHandle,
  prefix: string = "",
): AsyncGenerator<[string, FileContent]> {
  for await (const [name, handle] of (dir as any).entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      if (is_ignored_dir(name)) continue;
      yield* walk_directory(handle as FileSystemDirectoryHandle, path);
    } else {
      if (!is_sync_ext(name)) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size > MAX_FILE_SIZE) continue;
      if (is_binary(name)) {
        yield [path, new Uint8Array(await file.arrayBuffer())];
      } else {
        yield [path, await file.text()];
      }
    }
  }
}

async function write_file(dir: FileSystemDirectoryHandle, path: string, content: FileContent): Promise<void> {
  const parts = path.split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  const file_handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file_handle.createWritable();
  if (content instanceof Uint8Array) {
    await writable.write(content as unknown as ArrayBuffer);
  } else {
    await writable.write(content);
  }
  await writable.close();
}

async function delete_file(dir: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    try {
      current = await current.getDirectoryHandle(part);
    } catch {
      return;
    }
  }
  try {
    await current.removeEntry(parts[parts.length - 1]);
  } catch {
    // already gone
  }
}

async function read_file(dir: FileSystemDirectoryHandle, path: string): Promise<FileContent> {
  const parts = path.split("/");
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part);
  }
  const file_handle = await current.getFileHandle(parts[parts.length - 1]);
  const file = await file_handle.getFile();
  if (is_binary(path)) {
    return new Uint8Array(await file.arrayBuffer());
  }
  return await file.text();
}

// --- IndexedDB handle persistence ---

function open_db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx_complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function store_handle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(handle, "project-dir");
  await tx_complete(tx);
  db.close();
}

async function store_folder_name(name: string): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(name, "folder-name");
  await tx_complete(tx);
  db.close();
}

async function load_handle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await open_db();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return await new Promise((resolve) => {
      const req = store.get("project-dir");
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function load_folder_name(): Promise<string | null> {
  try {
    const db = await open_db();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return await new Promise((resolve) => {
      const req = store.get("folder-name");
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function clear_stored_handle(): Promise<void> {
  try {
    const db = await open_db();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete("project-dir");
    tx.objectStore(STORE_NAME).delete("folder-name");
    await tx_complete(tx);
    db.close();
  } catch {
    // ignore
  }
}

// --- main factory ---

const EMPTY_STATE: LocalSyncState = {
  dir_handle: null,
  folder_name: "",
  active: false,
  baseline_hashes: new Map(),
  last_sync: 0,
  syncing: false,
  dirty_files: new Set(),
  error: null,
};

export function create_local_folder_sync(store: ProjectStore): LocalFolderSync {
  const [state, set_state] = createSignal<LocalSyncState>({ ...EMPTY_STATE });

  let unsub_store: (() => void) | null = null;
  let idle_timer: ReturnType<typeof setTimeout> | null = null;
  let unload_handler: ((e: BeforeUnloadEvent) => void) | null = null;
  let visibility_handler: (() => void) | null = null;

  function track_dirty_files() {
    const s = state();
    if (!s.active) return;
    const file_names = store.file_names();
    const new_dirty = new Set(s.dirty_files);

    for (const path of file_names) {
      // mark all files dirty optimistically -- sync_now will verify via hash
      new_dirty.add(path);
    }

    // detect deletions
    for (const path of s.baseline_hashes.keys()) {
      if (!file_names.includes(path)) {
        new_dirty.add(path);
      }
    }

    set_state(prev => ({
      ...prev,
      dirty_files: new_dirty,
    }));
  }

  function reset_idle_timer() {
    if (idle_timer) clearTimeout(idle_timer);
    idle_timer = setTimeout(() => {
      const s = state();
      if (s.active && s.dirty_files.size > 0) {
        sync_now();
      }
    }, IDLE_TIMEOUT_MS);
  }

  function setup_event_listeners() {
    // unload: warn about unsaved changes
    unload_handler = (e: BeforeUnloadEvent) => {
      const s = state();
      if (s.active && s.dirty_files.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload_handler);

    // visibility: best-effort sync on tab hide
    visibility_handler = () => {
      if (document.visibilityState === "hidden") {
        const s = state();
        if (s.active && s.dirty_files.size > 0) {
          sync_now();
        }
      }
    };
    document.addEventListener("visibilitychange", visibility_handler);
  }

  function teardown_event_listeners() {
    if (unload_handler) {
      window.removeEventListener("beforeunload", unload_handler);
      unload_handler = null;
    }
    if (visibility_handler) {
      document.removeEventListener("visibilitychange", visibility_handler);
      visibility_handler = null;
    }
  }

  async function check_conflict(
    path: string,
    baseline_hash: string | undefined,
    dir_handle: FileSystemDirectoryHandle,
  ): Promise<{ disk_content: FileContent; disk_hash: string } | null> {
    if (!baseline_hash) return null; // new file, no conflict
    try {
      const disk_content = await read_file(dir_handle, path);
      const disk_hash = await hash_content(disk_content);
      if (disk_hash === baseline_hash) return null; // disk unchanged
      return { disk_content, disk_hash };
    } catch {
      return null; // file gone from disk, no conflict
    }
  }

  async function open_folder(): Promise<boolean> {
    if (!supports_folder_sync()) return false;
    try {
      const handle = await window.showDirectoryPicker!({
        mode: "readwrite",
        id: "eztex-project",
      });

      const files: ProjectFiles = {};
      const hashes = new Map<string, string>();
      for await (const [path, content] of walk_directory(handle)) {
        files[path] = content;
        hashes.set(path, await hash_content(content));
      }

      if (Object.keys(files).length === 0) {
        set_state(prev => ({ ...prev, error: "No supported files found in folder." }));
        return false;
      }

      store.load_files(files);

      set_state({
        dir_handle: handle,
        folder_name: handle.name,
        active: true,
        baseline_hashes: hashes,
        last_sync: Date.now(),
        syncing: false,
        dirty_files: new Set(),
        error: null,
      });

      await store_handle(handle);
      await store_folder_name(handle.name);

      // subscribe to store changes
      if (unsub_store) unsub_store();
      unsub_store = store.on_change(() => {
        track_dirty_files();
        reset_idle_timer();
      });

      setup_event_listeners();
      return true;
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return false;
      set_state(prev => ({ ...prev, error: `Failed to open folder: ${err}` }));
      return false;
    }
  }

  async function reconnect(): Promise<boolean> {
    const handle = await load_handle();
    if (!handle) return false;

    try {
      // request permission
      const perm = await (handle as any).requestPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        await clear_stored_handle();
        return false;
      }

      const files: ProjectFiles = {};
      const hashes = new Map<string, string>();
      for await (const [path, content] of walk_directory(handle)) {
        files[path] = content;
        hashes.set(path, await hash_content(content));
      }

      if (Object.keys(files).length === 0) {
        set_state(prev => ({ ...prev, error: "No supported files found in folder." }));
        return false;
      }

      store.load_files(files);

      set_state({
        dir_handle: handle,
        folder_name: handle.name,
        active: true,
        baseline_hashes: hashes,
        last_sync: Date.now(),
        syncing: false,
        dirty_files: new Set(),
        error: null,
      });

      if (unsub_store) unsub_store();
      unsub_store = store.on_change(() => {
        track_dirty_files();
        reset_idle_timer();
      });

      setup_event_listeners();
      return true;
    } catch (err) {
      await clear_stored_handle();
      set_state(prev => ({ ...prev, error: `Reconnect failed: ${err}` }));
      return false;
    }
  }

  function disconnect() {
    if (idle_timer) { clearTimeout(idle_timer); idle_timer = null; }
    if (unsub_store) { unsub_store(); unsub_store = null; }
    teardown_event_listeners();
    clear_stored_handle();
    set_state({ ...EMPTY_STATE });
  }

  async function sync_now(): Promise<SyncResult> {
    const s = state();
    if (s.syncing || s.dirty_files.size === 0 || !s.dir_handle) {
      return { status: "ok", files_written: 0 };
    }

    set_state(prev => ({ ...prev, syncing: true, error: null }));

    try {
      const dirty = [...s.dirty_files];
      const conflicts: ConflictInfo[] = [];
      let files_written = 0;
      const file_names = store.file_names();
      const new_baseline = new Map(s.baseline_hashes);
      const remaining_dirty = new Set(s.dirty_files);

      for (const path of dirty) {
        const store_deleted = !file_names.includes(path);
        const store_content = store_deleted ? "" : store.get_content(path);

        // skip if content matches baseline (not actually dirty)
        if (!store_deleted) {
          const current_hash = await hash_content(store_content);
          if (current_hash === s.baseline_hashes.get(path)) {
            remaining_dirty.delete(path);
            continue;
          }
        }

        // conflict check
        const conflict = await check_conflict(path, s.baseline_hashes.get(path), s.dir_handle!);
        if (conflict) {
          conflicts.push({
            path,
            eztex_content: store_content,
            disk_content: conflict.disk_content,
            eztex_hash: await hash_content(store_content),
            disk_hash: conflict.disk_hash,
          });
          continue; // skip writing conflicted files
        }

        if (store_deleted) {
          await delete_file(s.dir_handle!, path);
          new_baseline.delete(path);
        } else {
          await write_file(s.dir_handle!, path, store_content);
          new_baseline.set(path, await hash_content(store_content));
        }

        remaining_dirty.delete(path);
        files_written++;
      }

      set_state(prev => ({
        ...prev,
        baseline_hashes: new_baseline,
        dirty_files: remaining_dirty,
        last_sync: Date.now(),
        syncing: false,
      }));

      if (conflicts.length > 0) {
        return { status: "conflict", conflicts };
      }
      return { status: "ok", files_written };
    } catch (err) {
      const message = String(err);
      set_state(prev => ({
        ...prev,
        syncing: false,
        error: `Sync failed: ${message}`,
      }));

      // handle permission loss
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        set_state(prev => ({ ...prev, error: "Permission lost. Click reconnect to restore access." }));
      }

      return { status: "error", message };
    }
  }

  async function sync_file(path: string): Promise<SyncResult> {
    const s = state();
    if (!s.active || !s.dir_handle) {
      return { status: "ok", files_written: 0 };
    }
    if (s.syncing) {
      return { status: "ok", files_written: 0 };
    }

    set_state(prev => ({ ...prev, syncing: true, error: null }));

    try {
      const file_names = store.file_names();
      const store_deleted = !file_names.includes(path);
      const store_content = store_deleted ? "" : store.get_content(path);

      // skip if content matches baseline
      if (!store_deleted) {
        const current_hash = await hash_content(store_content);
        if (current_hash === s.baseline_hashes.get(path)) {
          set_state(prev => {
            const new_dirty = new Set(prev.dirty_files);
            new_dirty.delete(path);
            return { ...prev, syncing: false, dirty_files: new_dirty };
          });
          return { status: "ok", files_written: 0 };
        }
      }

      const conflict = await check_conflict(path, s.baseline_hashes.get(path), s.dir_handle!);
      if (conflict) {
        set_state(prev => ({ ...prev, syncing: false }));
        return {
          status: "conflict",
          conflicts: [{
            path,
            eztex_content: store_content,
            disk_content: conflict.disk_content,
            eztex_hash: await hash_content(store_content),
            disk_hash: conflict.disk_hash,
          }],
        };
      }

      if (store_deleted) {
        await delete_file(s.dir_handle!, path);
        set_state(prev => {
          const new_baseline = new Map(prev.baseline_hashes);
          new_baseline.delete(path);
          const new_dirty = new Set(prev.dirty_files);
          new_dirty.delete(path);
          return { ...prev, baseline_hashes: new_baseline, dirty_files: new_dirty, syncing: false, last_sync: Date.now() };
        });
      } else {
        await write_file(s.dir_handle!, path, store_content);
        const new_hash = await hash_content(store_content);
        set_state(prev => {
          const new_baseline = new Map(prev.baseline_hashes);
          new_baseline.set(path, new_hash);
          const new_dirty = new Set(prev.dirty_files);
          new_dirty.delete(path);
          return { ...prev, baseline_hashes: new_baseline, dirty_files: new_dirty, syncing: false, last_sync: Date.now() };
        });
      }

      return { status: "ok", files_written: 1 };
    } catch (err) {
      set_state(prev => ({ ...prev, syncing: false, error: `Sync failed: ${err}` }));
      return { status: "error", message: String(err) };
    }
  }

  async function resolve_conflict(path: string, resolution: "eztex" | "disk"): Promise<void> {
    const s = state();
    if (!s.dir_handle) return;

    if (resolution === "disk") {
      const disk_content = await read_file(s.dir_handle, path);
      store.update_content(path, disk_content);
      const h = await hash_content(disk_content);
      set_state(prev => {
        const new_baseline = new Map(prev.baseline_hashes);
        new_baseline.set(path, h);
        const new_dirty = new Set(prev.dirty_files);
        new_dirty.delete(path);
        return { ...prev, baseline_hashes: new_baseline, dirty_files: new_dirty };
      });
    } else {
      const content = store.get_content(path);
      await write_file(s.dir_handle, path, content);
      const h = await hash_content(content);
      set_state(prev => {
        const new_baseline = new Map(prev.baseline_hashes);
        new_baseline.set(path, h);
        const new_dirty = new Set(prev.dirty_files);
        new_dirty.delete(path);
        return { ...prev, baseline_hashes: new_baseline, dirty_files: new_dirty };
      });
    }
  }

  function is_supported(): boolean {
    return supports_folder_sync();
  }

  async function has_stored_handle(): Promise<boolean> {
    const h = await load_handle();
    return h !== null;
  }

  async function get_stored_folder_name(): Promise<string | null> {
    return load_folder_name();
  }

  // write compiled PDF to synced folder (derived from main file name)
  async function write_pdf(bytes: Uint8Array): Promise<void> {
    const s = state();
    if (!s.active || !s.dir_handle) return;
    const pdf_name = store.main_file().replace(/\.tex$/, ".pdf");
    try {
      await write_file(s.dir_handle, pdf_name, bytes);
    } catch {
      // silently ignore -- folder may have been revoked
    }
  }

  return {
    state,
    open_folder,
    reconnect,
    disconnect,
    sync_now,
    sync_file,
    resolve_conflict,
    write_pdf,
    is_supported,
    has_stored_handle,
    get_stored_folder_name,
  };
}

function supports_folder_sync(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

