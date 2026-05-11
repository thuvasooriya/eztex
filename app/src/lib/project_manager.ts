import type { ProjectId, ProjectCatalogEntry } from "./project_persist";
import {
  load_catalog,
  save_catalog,
  load_project_manifest,
  save_project_manifest,
  create_fresh_project as _create_fresh_project,
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
