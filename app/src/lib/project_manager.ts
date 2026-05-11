import type { ProjectId, ProjectCatalogEntry } from "./project_persist";
import {
  load_catalog,
  save_catalog,
  load_project_manifest,
  save_project_manifest,
  create_fresh_project as _create_fresh_project,
  load_ydoc_snapshot,
  save_ydoc_snapshot,
} from "./project_persist";

export async function list_projects(): Promise<ProjectCatalogEntry[]> {
  const catalog = await load_catalog();
  return catalog.projects;
}

export async function get_project(id: ProjectId): Promise<ProjectCatalogEntry | null> {
  const catalog = await load_catalog();
  return catalog.projects.find((p) => p.id === id) ?? null;
}

export async function create_project(name?: string): Promise<ProjectId> {
  const id = await _create_fresh_project(name);
  return id;
}

export async function set_current_project(id: ProjectId): Promise<void> {
  const catalog = await load_catalog();
  catalog.current_project_id = id;
  await save_catalog(catalog);
}

export async function rename_project(id: ProjectId, name: string): Promise<void> {
  const catalog = await load_catalog();
  const entry = catalog.projects.find((p) => p.id === id);
  if (!entry) return;
  entry.name = name;
  entry.updated_at = Date.now();
  await save_catalog(catalog);

  const manifest = await load_project_manifest(id);
  if (manifest) {
    manifest.name = name;
    manifest.updated_at = Date.now();
    await save_project_manifest(id, manifest);
  }
}

export async function delete_project(id: ProjectId): Promise<boolean> {
  const catalog = await load_catalog();
  const idx = catalog.projects.findIndex((p) => p.id === id);
  if (idx < 0) return false;

  catalog.projects.splice(idx, 1);
  if (catalog.current_project_id === id) {
    catalog.current_project_id = catalog.projects[0]?.id ?? null;
  }
  await save_catalog(catalog);

  try {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle("eztex-projects");
    const projects_dir = await projects.getDirectoryHandle("projects");
    await (projects_dir as any).removeEntry(id, { recursive: true });
  } catch {
    // graceful degradation
  }

  return true;
}

export function get_project_url(id: ProjectId): string {
  const url = new URL(window.location.href);
  url.searchParams.set("project", id);
  return url.pathname + url.search;
}

export async function duplicate_project(source_id: ProjectId, name?: string): Promise<ProjectId> {
  const catalog = await load_catalog();
  const source = catalog.projects.find((p) => p.id === source_id);
  if (!source) throw new Error("Source project not found");

  const { create_project_id } = await import("./y_project_doc");
  const new_id = create_project_id();
  const now = Date.now();
  const new_name = name?.trim() || `${source.name} copy`;

  const snapshot = await load_ydoc_snapshot(source_id);
  if (snapshot) {
    await save_ydoc_snapshot(new_id, snapshot);
  }

  const source_manifest = await load_project_manifest(source_id);
  if (source_manifest) {
    await save_project_manifest(new_id, {
      ...source_manifest,
      id: new_id,
      name: new_name,
      created_at: now,
      updated_at: now,
    });
  }

  if (snapshot && source_manifest) {
    try {
      const root = await navigator.storage.getDirectory();
      const projects_dir_handle = await root.getDirectoryHandle("eztex-projects");
      const projects = await projects_dir_handle.getDirectoryHandle("projects");
      const src_dir = await projects.getDirectoryHandle(source_id);
      const blobs_dir = await src_dir.getDirectoryHandle("blobs");
      const new_dir = await projects.getDirectoryHandle(new_id, { create: true });
      const new_blobs_dir = await new_dir.getDirectoryHandle("blobs", { create: true });
      for await (const [blob_name] of (blobs_dir as any).entries()) {
        const fh = await blobs_dir.getFileHandle(blob_name);
        const file = await fh.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const wh = await new_blobs_dir.getFileHandle(blob_name, { create: true });
        const w = await wh.createWritable();
        await w.write(bytes);
        await w.close();
      }
    } catch { /* blobs copy best-effort */ }
  }

  catalog.current_project_id = new_id;
  catalog.projects.push({
    id: new_id,
    name: new_name,
    main_file: source.main_file,
    created_at: now,
    updated_at: now,
  });
  await save_catalog(catalog);

  return new_id;
}
