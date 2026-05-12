import { get, put, remove, get_all, delete_database } from "./storage_db";
import {
  create_project_id,
  create_y_project_doc,
  encode_snapshot,
} from "./y_project_doc";
import type { ProjectId } from "./y_project_doc";

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  main_file: string;
  created_at: number;
  updated_at: number;
  origin: "local" | "folder" | "guest-room" | "owned-room";
}

export type ProjectCatalogEntry = ProjectRecord;

export interface LoadedProject {
  record: ProjectRecord;
  snapshot: Uint8Array | null;
  blobs_dir: FileSystemDirectoryHandle | null;
}

const ROOT_DIR = "eztex-projects";
const CACHE_DIR = "eztex-cache";

async function write_file_bytes(handle: FileSystemFileHandle, bytes: Uint8Array | FileSystemWriteChunkType): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as FileSystemWriteChunkType);
  } finally {
    try {
      await writable.close();
    } catch {
      // ignore close errors after a failed write
    }
  }
}

async function get_root_dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function get_projects_dir(): Promise<FileSystemDirectoryHandle> {
  const root = await get_root_dir();
  return await root.getDirectoryHandle("projects", { create: true });
}

async function get_outputs_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
  const dir = await get_project_v2_dir(project_id);
  return await dir.getDirectoryHandle("outputs", { create: true });
}

async function get_project_v2_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
  const projects = await get_projects_dir();
  return await projects.getDirectoryHandle(project_id, { create: true });
}

export class ProjectRepository {
  async create_project(name?: string, origin: ProjectRecord["origin"] = "local"): Promise<ProjectRecord> {
    const project_id = create_project_id();
    const all = await this.list_projects();
    const project_name = name?.trim() || (all.length === 0 ? "Demo Project" : "Untitled Project");
    const now = Date.now();

    const record: ProjectRecord = {
      id: project_id,
      name: project_name,
      main_file: "main.tex",
      created_at: now,
      updated_at: now,
      origin,
    };

    await put("projects", record, project_id);
    await this.set_current_project(project_id);

    const yp = create_y_project_doc(project_id, project_name);
    await this.save_snapshot(project_id, encode_snapshot(yp.doc));
    yp.doc.destroy();

    return record;
  }

  async load_project(project_id: ProjectId): Promise<LoadedProject> {
    const record = await this.get_project(project_id);
    if (!record) throw new Error(`Project ${project_id} not found`);

    let snapshot: Uint8Array | null = null;
    try {
      const dir = await this.get_project_dir(project_id);
      const handle = await dir.getFileHandle("ydoc.bin");
      const file = await handle.getFile();
      snapshot = new Uint8Array(await file.arrayBuffer());
    } catch {
      // no snapshot yet
    }

    let blobs_dir: FileSystemDirectoryHandle | null = null;
    try {
      blobs_dir = await this.get_blobs_dir(project_id);
    } catch {
      // no blobs dir
    }

    return { record, snapshot, blobs_dir };
  }

  async save_snapshot(project_id: ProjectId, snapshot: Uint8Array): Promise<void> {
    const dir = await this.get_project_dir(project_id);
    const handle = await dir.getFileHandle("ydoc.bin", { create: true });
    await write_file_bytes(handle, snapshot);
  }

  async delete_project(project_id: ProjectId): Promise<void> {
    const pending = {
      project_id,
      enqueued_at: Date.now(),
    };
    await put("pending_deletes", pending, project_id);
    await remove("projects", project_id);

    const current = await this.get_current_project();
    if (current === project_id) {
      const all = await this.list_projects();
      await this.set_current_project(all[0]?.id ?? "");
    }

    try {
      const projects = await get_projects_dir();
      await (projects as any).removeEntry(project_id, { recursive: true });
      await remove("pending_deletes", project_id);
    } catch {
      // will be cleaned up on next recovery
    }
  }

  async list_projects(): Promise<ProjectRecord[]> {
    return await get_all<ProjectRecord>("projects");
  }

  async get_project(project_id: ProjectId): Promise<ProjectRecord | null> {
    return (await get<ProjectRecord>("projects", project_id)) ?? null;
  }

  async set_current_project(project_id: ProjectId): Promise<void> {
    await put("ui_prefs", project_id, "current_project_id");
  }

  async get_current_project(): Promise<ProjectId | null> {
    return (await get<string>("ui_prefs", "current_project_id")) ?? null;
  }

  async rename_project(project_id: ProjectId, name: string): Promise<void> {
    const record = await this.get_project(project_id);
    if (!record) return;
    record.name = name;
    record.updated_at = Date.now();
    await put("projects", record, project_id);
  }

  async update_main_file(project_id: ProjectId, main_file: string): Promise<void> {
    const record = await this.get_project(project_id);
    if (!record) return;
    record.main_file = main_file;
    record.updated_at = Date.now();
    await put("projects", record, project_id);
  }

  async get_project_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
    const projects = await get_projects_dir();
    return await projects.getDirectoryHandle(project_id, { create: true });
  }

  async get_blobs_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
    const dir = await this.get_project_dir(project_id);
    return await dir.getDirectoryHandle("blobs", { create: true });
  }

  async get_outputs_dir(project_id: ProjectId): Promise<FileSystemDirectoryHandle> {
    return await get_outputs_dir(project_id);
  }

  async save_blob(project_id: ProjectId, hash: string, bytes: Uint8Array): Promise<void> {
    const dir = await this.get_project_dir(project_id);
    const blobs_dir = await dir.getDirectoryHandle("blobs", { create: true });
    const handle = await blobs_dir.getFileHandle(hash, { create: true });
    await write_file_bytes(handle, bytes);
  }

  async load_blob(project_id: ProjectId, hash: string): Promise<Uint8Array | null> {
    try {
      const dir = await this.get_project_dir(project_id);
      const blobs_dir = await dir.getDirectoryHandle("blobs");
      const handle = await blobs_dir.getFileHandle(hash);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async save_pdf(bytes: Uint8Array, project_id: ProjectId): Promise<void> {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.pdf", { create: true });
      await write_file_bytes(handle, bytes);
    } catch {
      // graceful degradation
    }
  }

  async load_pdf(project_id: ProjectId): Promise<Uint8Array | null> {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.pdf");
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > 0) return bytes;
    } catch {}
    return null;
  }

  async save_synctex(text: string, project_id: ProjectId): Promise<void> {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.synctex", { create: true });
      await write_file_bytes(handle, new TextEncoder().encode(text));
    } catch {}
  }

  async load_synctex(project_id: ProjectId): Promise<string | null> {
    try {
      const outputs = await get_outputs_dir(project_id);
      const handle = await outputs.getFileHandle("output.synctex");
      const file = await handle.getFile();
      const text = await file.text();
      if (text) return text;
    } catch {}
    return null;
  }

  async clear_all_outputs(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const eztex_root = await root.getDirectoryHandle(ROOT_DIR);
      const projects = await eztex_root.getDirectoryHandle("projects");
      for await (const [, handle] of (projects as any).entries()) {
        if ((handle as FileSystemHandle).kind !== "directory") continue;
        try {
          await (handle as FileSystemDirectoryHandle).removeEntry("outputs", { recursive: true });
        } catch (err) {
          if (!(err instanceof DOMException) || err.name !== "NotFoundError") throw err;
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException) || err.name !== "NotFoundError") throw err;
    }
  }

  async duplicate_project(source_id: ProjectId, name?: string): Promise<ProjectId> {
    const source = await this.get_project(source_id);
    if (!source) throw new Error("Source project not found");

    const new_id = create_project_id();
    const now = Date.now();
    const new_name = name?.trim() || `${source.name} copy`;

    const snapshot = await this.load_snapshot(source_id);
    if (snapshot) {
      const new_dir = await this.get_project_dir(new_id);
      const handle = await new_dir.getFileHandle("ydoc.bin", { create: true });
      await write_file_bytes(handle, snapshot);
    }

    try {
      const src_dir = await this.get_project_dir(source_id);
      const src_blobs = await src_dir.getDirectoryHandle("blobs");
      const new_dir = await this.get_project_dir(new_id);
      const new_blobs = await new_dir.getDirectoryHandle("blobs", { create: true });
      for await (const [blob_name, blob_handle] of (src_blobs as any).entries()) {
        if ((blob_handle as any).kind !== "file") continue;
        const file = await (blob_handle as FileSystemFileHandle).getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const wh = await new_blobs.getFileHandle(blob_name, { create: true });
        await write_file_bytes(wh, bytes);
      }
    } catch {}

    const new_record: ProjectRecord = {
      id: new_id,
      name: new_name,
      main_file: source.main_file,
      created_at: now,
      updated_at: now,
      origin: source.origin,
    };
    await put("projects", new_record, new_id);

    return new_id;
  }

  private async load_snapshot(project_id: ProjectId): Promise<Uint8Array | null> {
    try {
      const dir = await this.get_project_dir(project_id);
      const handle = await dir.getFileHandle("ydoc.bin");
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async recover_pending_deletes(): Promise<void> {
    const pending = await get_all<{ project_id: string; enqueued_at: number }>("pending_deletes");
    for (const entry of pending) {
      try {
        const projects = await get_projects_dir();
        await (projects as any).removeEntry(entry.project_id, { recursive: true });
        await remove("pending_deletes", entry.project_id);
      } catch {
        await remove("pending_deletes", entry.project_id);
      }
    }
  }
}

function is_not_found_error(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

function is_modification_blocked_error(err: unknown): boolean {
  return err instanceof DOMException
    && (err.name === "NoModificationAllowedError" || err.message.includes("modifications are not allowed"));
}

async function remove_directory_contents(dir: FileSystemDirectoryHandle): Promise<void> {
  for await (const [name, handle] of (dir as any).entries()) {
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch (err) {
      if (is_not_found_error(err)) continue;
      if (handle.kind === "directory") {
        try {
          await remove_directory_contents(handle as FileSystemDirectoryHandle);
          await dir.removeEntry(name, { recursive: true });
        } catch {
          // A locked child should not prevent reset from clearing other entries.
        }
        continue;
      }
      // A locked file should not prevent reset from clearing other entries.
    }
  }
}

async function remove_opfs_entry(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name, { recursive: true });
    return;
  } catch (err) {
    if (is_not_found_error(err)) return;
    if (!is_modification_blocked_error(err)) throw err;
  }

  let dir: FileSystemDirectoryHandle;
  try {
    dir = await root.getDirectoryHandle(name);
  } catch (err) {
    if (is_not_found_error(err)) return;
    throw err;
  }

  await remove_directory_contents(dir);
  try {
    await root.removeEntry(name, { recursive: true });
  } catch (err) {
    if (is_not_found_error(err) || is_modification_blocked_error(err)) return;
    throw err;
  }
}

async function delete_indexed_db(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`Failed to delete ${name}`));
    req.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
  });
}

export async function clear_bundle_cache(): Promise<void> {
  await remove_opfs_entry(CACHE_DIR);
  await new ProjectRepository().clear_all_outputs();
}

export async function reset_all_persistence(): Promise<void> {
  localStorage.clear();
  await delete_database();
  await remove_opfs_entry(ROOT_DIR);
  await remove_opfs_entry(CACHE_DIR);
  await delete_indexed_db("eztex-folder-sync");
}
