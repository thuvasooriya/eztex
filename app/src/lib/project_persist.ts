import type { ProjectFiles } from "./project_store";
import {
  create_project_id,
  create_y_project_doc,
  get_or_create_text_file,
  create_binary_file_ref,
  get_project_metadata,
  set_project_metadata,
  encode_snapshot,
} from "./y_project_doc";
import type { ProjectId } from "./y_project_doc";
export type { ProjectId };

const ROOT_DIR = "eztex-projects";
const DEFAULT_SLOT = "default";

export type ProjectCatalogEntry = {
  id: ProjectId;
  name: string;
  main_file: string;
  created_at: number;
  updated_at: number;
  room_id?: string;
};

export type ProjectCatalogFile = {
  version: 2;
  current_project_id: ProjectId | null;
  projects: ProjectCatalogEntry[];
};

export type ProjectManifestV2 = {
  version: 2;
  id: ProjectId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
  room_id?: string;
  ydoc_file: "ydoc.bin";
  blobs_dir: "blobs";
  outputs_dir: "outputs";
};

export type SavedManifest = {
  files: { name: string; binary: boolean; safe_name: string }[];
  main_file?: string;
};

async function get_root_dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function get_projects_dir(): Promise<FileSystemDirectoryHandle> {
  const root = await get_root_dir();
  return await root.getDirectoryHandle("projects", { create: true });
}

async function get_project_v2_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
  const projects = await get_projects_dir();
  return await projects.getDirectoryHandle(project_id, { create: true });
}

async function get_outputs_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
  const dir = await get_project_v2_dir(project_id);
  return await dir.getDirectoryHandle("outputs", { create: true });
}

function encode_filename(name: string): string {
  return name.replace(/\//g, "_SLASH_").replace(/[^a-zA-Z0-9._\-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

async function compute_hash(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --- v2 catalog ---

export async function load_catalog(): Promise<ProjectCatalogFile> {
  try {
    const root = await get_root_dir();
    const handle = await root.getFileHandle("catalog.json");
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return { version: 2, current_project_id: null, projects: [] };
  }
}

export async function save_catalog(catalog: ProjectCatalogFile): Promise<void> {
  const root = await get_root_dir();
  const handle = await root.getFileHandle("catalog.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(catalog));
  await writable.close();
}

// --- v2 project manifest ---

export async function save_project_manifest(project_id: ProjectId, manifest: ProjectManifestV2): Promise<void> {
  const dir = await get_project_v2_dir(project_id);
  const handle = await dir.getFileHandle("project.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(manifest));
  await writable.close();
}

export async function load_project_manifest(project_id: ProjectId): Promise<ProjectManifestV2 | null> {
  try {
    const dir = await get_project_v2_dir(project_id);
    const handle = await dir.getFileHandle("project.json");
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

// --- v2 ydoc snapshot ---

export async function save_ydoc_snapshot(project_id: ProjectId, bytes: Uint8Array): Promise<void> {
  const dir = await get_project_v2_dir(project_id);
  const handle = await dir.getFileHandle("ydoc.bin", { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function load_ydoc_snapshot(project_id: ProjectId): Promise<Uint8Array | null> {
  try {
    const dir = await get_project_v2_dir(project_id);
    const handle = await dir.getFileHandle("ydoc.bin");
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

// --- v2 blobs ---

export async function save_blob(project_id: ProjectId, hash: string, bytes: Uint8Array): Promise<void> {
  const dir = await get_project_v2_dir(project_id);
  const blobs_dir = await dir.getDirectoryHandle("blobs", { create: true });
  const handle = await blobs_dir.getFileHandle(hash, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function load_blob(project_id: ProjectId, hash: string): Promise<Uint8Array | null> {
  try {
    const dir = await get_project_v2_dir(project_id);
    const blobs_dir = await dir.getDirectoryHandle("blobs");
    const handle = await blobs_dir.getFileHandle(hash);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export { compute_hash };

// --- fresh project creation ---

export async function create_fresh_project(name?: string): Promise<ProjectId> {
  const project_id = create_project_id();
  const catalog = await load_catalog();
  const now = Date.now();
  const is_first = catalog.projects.length === 0;
  const project_name = name?.trim() || (is_first ? "Demo Project" : "Untitled Project");
  catalog.current_project_id = project_id;
  catalog.projects.push({
    id: project_id,
    name: project_name,
    main_file: "main.tex",
    created_at: now,
    updated_at: now,
  });
  await save_catalog(catalog);
  await save_project_manifest(project_id, {
    version: 2,
    id: project_id,
    name: project_name,
    created_at: now,
    updated_at: now,
    main_file: "main.tex",
    ydoc_file: "ydoc.bin",
    blobs_dir: "blobs",
    outputs_dir: "outputs",
  });
  const yp = create_y_project_doc(project_id, project_name);
  await save_ydoc_snapshot(project_id, encode_snapshot(yp.doc));
  yp.doc.destroy();
  return project_id;
}

// --- v1 backward-compatible exports ---

async function get_project_dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    return await projects.getDirectoryHandle(DEFAULT_SLOT, { create: true });
  } catch {
    return null;
  }
}

export async function save_project(files: ProjectFiles, main_file?: string): Promise<boolean> {
  const dir = await get_project_dir();
  if (!dir) return false;

  try {
    const sidecar = new Set(["_output.pdf", "_output.synctex"]);
    const to_remove: string[] = [];
    for await (const [name] of (dir as any).entries()) {
      if (!sidecar.has(name)) to_remove.push(name);
    }
    for (const name of to_remove) {
      await dir.removeEntry(name).catch(() => {});
    }

    const encoder = new TextEncoder();
    const file_entries: SavedManifest["files"] = [];

    for (const [name, content] of Object.entries(files)) {
      const safe_name = encode_filename(name);
      const handle = await dir.getFileHandle(safe_name, { create: true });
      const writable = await handle.createWritable();
      if (content instanceof Uint8Array) {
        await writable.write(content as unknown as ArrayBuffer);
        file_entries.push({ name, binary: true, safe_name });
      } else {
        await writable.write(encoder.encode(content));
        file_entries.push({ name, binary: false, safe_name });
      }
      await writable.close();
    }

    const manifest: SavedManifest = { files: file_entries, main_file };
    const mh = await dir.getFileHandle("__manifest.json", { create: true });
    const mw = await mh.createWritable();
    await mw.write(encoder.encode(JSON.stringify(manifest)));
    await mw.close();

    return true;
  } catch {
    return false;
  }
}

export async function load_project(): Promise<{ files: ProjectFiles; main_file?: string } | null> {
  const dir = await get_project_dir();
  if (!dir) return null;

  try {
    const mh = await dir.getFileHandle("__manifest.json");
    const mf = await mh.getFile();
    const raw = JSON.parse(await mf.text());
    const manifest: SavedManifest = Array.isArray(raw) ? { files: raw } : raw;

    const files: ProjectFiles = {};
    for (const entry of manifest.files) {
      try {
        const fh = await dir.getFileHandle(entry.safe_name);
        const file = await fh.getFile();
        if (entry.binary) {
          files[entry.name] = new Uint8Array(await file.arrayBuffer());
        } else {
          files[entry.name] = await file.text();
        }
      } catch {
        // skip missing files
      }
    }

    if (Object.keys(files).length === 0) return null;
    return { files, main_file: manifest.main_file };
  } catch {
    return null;
  }
}

export async function has_saved_project(): Promise<boolean> {
  const dir = await get_project_dir();
  if (!dir) return false;
  try {
    await dir.getFileHandle("__manifest.json");
    return true;
  } catch {
    return false;
  }
}

// --- v1 migration ---

export async function migrate_v1_default_project(): Promise<ProjectId | null> {
  const catalog = await load_catalog();
  if (catalog.projects.length > 0) return null;

  const v1 = await load_project();
  if (!v1 || Object.keys(v1.files).length === 0) return null;

  const project_id = create_project_id();
  const yp = create_y_project_doc(project_id);

  for (const [path, content] of Object.entries(v1.files)) {
    if (content instanceof Uint8Array) {
      const hash = await compute_hash(content);
      await save_blob(project_id, hash, content);
      create_binary_file_ref(yp, path, hash, content.length);
    } else {
      get_or_create_text_file(yp, path, content);
    }
  }

  const detected_main = v1.main_file ?? get_project_metadata(yp).main_file;
  set_project_metadata(yp, { main_file: detected_main });
  const meta = get_project_metadata(yp);
  const manifest: ProjectManifestV2 = {
    version: 2,
    id: project_id,
    name: meta.name,
    created_at: meta.created_at,
    updated_at: Date.now(),
    main_file: detected_main,
    ydoc_file: "ydoc.bin",
    blobs_dir: "blobs",
    outputs_dir: "outputs",
  };

  await save_ydoc_snapshot(project_id, encode_snapshot(yp.doc));
  await save_project_manifest(project_id, manifest);

  // copy v1 outputs if present
  try {
    const v1_dir = await get_project_dir();
    if (v1_dir) {
      try {
        const pdf_h = await v1_dir.getFileHandle("_output.pdf");
        const pdf_f = await pdf_h.getFile();
        const pdf_bytes = new Uint8Array(await pdf_f.arrayBuffer());
        if (pdf_bytes.length > 0) {
          const outputs = await get_outputs_dir(project_id);
          const wh = await outputs.getFileHandle("output.pdf", { create: true });
          const w = await wh.createWritable();
          await w.write(pdf_bytes);
          await w.close();
        }
      } catch { /* no pdf */ }
      try {
        const syn_h = await v1_dir.getFileHandle("_output.synctex");
        const syn_f = await syn_h.getFile();
        const syn_text = await syn_f.text();
        if (syn_text) {
          const outputs = await get_outputs_dir(project_id);
          const wh = await outputs.getFileHandle("output.synctex", { create: true });
          const w = await wh.createWritable();
          await w.write(new TextEncoder().encode(syn_text));
          await w.close();
        }
      } catch { /* no synctex */ }
    }
  } catch { /* v1 dir missing */ }

  catalog.current_project_id = project_id;
  catalog.projects.push({
    id: project_id,
    name: manifest.name,
    main_file: detected_main,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
  });
  await save_catalog(catalog);

  yp.doc.destroy();
  return project_id;
}

// --- v2-aware save (called from App auto-save) ---

export async function save_ydoc_project(project_id: ProjectId, snapshot: Uint8Array, main_file: string): Promise<void> {
  await save_ydoc_snapshot(project_id, snapshot);
  const existing = await load_project_manifest(project_id);
  if (existing) {
    existing.updated_at = Date.now();
    existing.main_file = main_file;
    await save_project_manifest(project_id, existing);
  }
}

// --- outputs ---

export async function save_pdf(bytes: Uint8Array, project_id?: ProjectId): Promise<void> {
  try {
    if (project_id) {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.pdf", { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as ArrayBuffer);
      await writable.close();
    }
    // also save to v1 path for backward compat
    const dir = await get_project_dir();
    if (dir) {
      const handle = await dir.getFileHandle("_output.pdf", { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes as unknown as ArrayBuffer);
      await writable.close();
    }
  } catch {
    // graceful degradation
  }
}

export async function load_pdf(project_id?: ProjectId): Promise<Uint8Array | null> {
  // try v2 first
  if (project_id) {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.pdf");
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > 0) return bytes;
    } catch { /* fallthrough */ }
  }
  // fallback to v1
  try {
    const dir = await get_project_dir();
    if (!dir) return null;
    const handle = await dir.getFileHandle("_output.pdf");
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function save_synctex(text: string, project_id?: ProjectId): Promise<void> {
  try {
    if (project_id) {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.synctex", { create: true });
      const writable = await handle.createWritable();
      await writable.write(new TextEncoder().encode(text));
      await writable.close();
    }
    const dir = await get_project_dir();
    if (dir) {
      const handle = await dir.getFileHandle("_output.synctex", { create: true });
      const writable = await handle.createWritable();
      await writable.write(new TextEncoder().encode(text));
      await writable.close();
    }
  } catch {
    // graceful degradation
  }
}

export async function load_synctex(project_id?: ProjectId): Promise<string | null> {
  if (project_id) {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.synctex");
      const file = await handle.getFile();
      const text = await file.text();
      if (text) return text;
    } catch { /* fallthrough */ }
  }
  try {
    const dir = await get_project_dir();
    if (!dir) return null;
    const handle = await dir.getFileHandle("_output.synctex");
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function clear_bundle_cache(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await (root as any).removeEntry("eztex-cache", { recursive: true }).catch(() => {});
  } catch {
    // graceful degradation
  }
}

export async function clear_project(project_id?: ProjectId): Promise<void> {
  const dir = await get_project_dir();
  if (dir) {
    try {
      const to_remove: string[] = [];
      for await (const [name] of (dir as any).entries()) {
        to_remove.push(name);
      }
      for (const name of to_remove) {
        await dir.removeEntry(name).catch(() => {});
      }
    } catch {}
  }
  if (project_id) {
    try {
      const projects = await get_projects_dir();
      await (projects as any).removeEntry(project_id, { recursive: true }).catch(() => {});
    } catch {}
  }
}

export async function reset_all_persistence(): Promise<void> {
  localStorage.clear();
  try {
    const root = await navigator.storage.getDirectory();
    await (root as any).removeEntry(ROOT_DIR, { recursive: true }).catch(() => {});
  } catch {}
  await clear_bundle_cache();
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("eztex-folder-sync");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  } catch {}
}
