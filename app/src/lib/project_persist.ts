// project persistence -- save/restore user projects to OPFS
// uses eztex-projects/default/ (completely separate from eztex-cache/)

import type { ProjectFiles } from "./project_store";

const ROOT_DIR = "eztex-projects";
const DEFAULT_SLOT = "default";

async function get_project_dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    return await projects.getDirectoryHandle(DEFAULT_SLOT, { create: true });
  } catch {
    return null;
  }
}

export async function save_project(files: ProjectFiles): Promise<boolean> {
  const dir = await get_project_dir();
  if (!dir) return false;

  try {
    // clear existing files
    const to_remove: string[] = [];
    for await (const [name] of (dir as any).entries()) {
      to_remove.push(name);
    }
    for (const name of to_remove) {
      await dir.removeEntry(name).catch(() => {});
    }

    // write files (encode names as safe filenames using base64url for paths with /)
    const encoder = new TextEncoder();
    const manifest: { name: string; binary: boolean; safe_name: string }[] = [];

    for (const [name, content] of Object.entries(files)) {
      const safe_name = encode_filename(name);
      const handle = await dir.getFileHandle(safe_name, { create: true });
      const writable = await handle.createWritable();
      if (content instanceof Uint8Array) {
        await writable.write(content as unknown as ArrayBuffer);
        manifest.push({ name, binary: true, safe_name });
      } else {
        await writable.write(encoder.encode(content));
        manifest.push({ name, binary: false, safe_name });
      }
      await writable.close();
    }

    // write manifest
    const mh = await dir.getFileHandle("__manifest.json", { create: true });
    const mw = await mh.createWritable();
    await mw.write(encoder.encode(JSON.stringify(manifest)));
    await mw.close();

    return true;
  } catch {
    return false;
  }
}

export async function load_project(): Promise<ProjectFiles | null> {
  const dir = await get_project_dir();
  if (!dir) return null;

  try {
    const mh = await dir.getFileHandle("__manifest.json");
    const mf = await mh.getFile();
    const manifest: { name: string; binary: boolean; safe_name: string }[] = JSON.parse(await mf.text());

    const files: ProjectFiles = {};
    for (const entry of manifest) {
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
    return files;
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

// encode filenames: replace / with _SLASH_ to flatten into a single directory
function encode_filename(name: string): string {
  return name.replace(/\//g, "_SLASH_").replace(/[^a-zA-Z0-9._\-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

export async function clear_bundle_cache(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await (root as any).removeEntry("eztex-cache", { recursive: true }).catch(() => {});
  } catch {
    // graceful degradation
  }
}

export async function clear_project(): Promise<void> {
  const dir = await get_project_dir();
  if (!dir) return;
  try {
    const to_remove: string[] = [];
    for await (const [name] of (dir as any).entries()) {
      to_remove.push(name);
    }
    for (const name of to_remove) {
      await dir.removeEntry(name).catch(() => {});
    }
  } catch {
    // graceful degradation
  }
}

const PDF_FILENAME = "_output.pdf";

export async function save_pdf(bytes: Uint8Array): Promise<void> {
  try {
    const dir = await get_project_dir();
    if (!dir) return;
    const handle = await dir.getFileHandle(PDF_FILENAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as ArrayBuffer);
    await writable.close();
  } catch {
    // graceful degradation
  }
}

export async function load_pdf(): Promise<Uint8Array | null> {
  try {
    const dir = await get_project_dir();
    if (!dir) return null;
    const handle = await dir.getFileHandle(PDF_FILENAME);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

// nuke all persistence: localStorage, OPFS (project + cache), IndexedDB (folder sync handles)
export async function reset_all_persistence(): Promise<void> {
  localStorage.clear();
  await clear_project();
  await clear_bundle_cache();
  // clear folder sync IndexedDB
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("eztex-folder-sync");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  } catch { /* graceful degradation */ }
}
