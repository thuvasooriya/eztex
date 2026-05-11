import * as Y from "yjs";

export type ProjectId = string;
export type RoomId = string;
export type FileId = string;
export type ContentHash = string;
export type FileKind = "text" | "binary";

export interface ProjectMetadata {
  id: ProjectId;
  room_id?: RoomId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
}

export interface FileMetadata {
  id: FileId;
  path: string;
  kind: FileKind;
  created_at: number;
  updated_at: number;
  content_hash?: ContentHash;
  mime?: string;
  size?: number;
}

export interface YProjectDoc {
  doc: Y.Doc;
  meta: Y.Map<unknown>;
  paths: Y.Map<FileId>;
  file_meta: Y.Map<Y.Map<unknown>>;
  texts: Y.Map<Y.Text>;
  blob_refs: Y.Map<ContentHash>;
}

export const Y_META = "meta";
export const Y_PATHS = "paths";
export const Y_FILE_META = "file_meta";
export const Y_TEXTS = "texts";
export const Y_BLOB_REFS = "blob_refs";

export function create_file_id(): FileId {
  return `f_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function create_project_id(): ProjectId {
  return `p_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function bind_y_project_doc(doc: Y.Doc): YProjectDoc {
  return {
    doc,
    meta: doc.getMap(Y_META),
    paths: doc.getMap(Y_PATHS),
    file_meta: doc.getMap(Y_FILE_META),
    texts: doc.getMap(Y_TEXTS),
    blob_refs: doc.getMap(Y_BLOB_REFS),
  };
}

export function create_y_project_doc(project_id: ProjectId, name?: string): YProjectDoc {
  const doc = new Y.Doc();
  const yp = bind_y_project_doc(doc);
  const now = Date.now();
  yp.doc.transact(() => {
    yp.meta.set("id", project_id);
    yp.meta.set("name", name ?? "Untitled Project");
    yp.meta.set("created_at", now);
    yp.meta.set("updated_at", now);
    yp.meta.set("main_file", "main.tex");
  });
  return yp;
}

export function get_project_metadata(yp: YProjectDoc): ProjectMetadata {
  const m = yp.meta;
  return {
    id: (m.get("id") as string) ?? "",
    room_id: m.get("room_id") as string | undefined,
    name: (m.get("name") as string) ?? "Untitled Project",
    created_at: (m.get("created_at") as number) ?? 0,
    updated_at: (m.get("updated_at") as number) ?? 0,
    main_file: (m.get("main_file") as string) ?? "main.tex",
  };
}

export function set_project_metadata(yp: YProjectDoc, patch: Partial<ProjectMetadata>): void {
  yp.doc.transact(() => {
    const m = yp.meta;
    if (patch.id !== undefined) m.set("id", patch.id);
    if (patch.room_id !== undefined) m.set("room_id", patch.room_id);
    if (patch.name !== undefined) m.set("name", patch.name);
    if (patch.created_at !== undefined) m.set("created_at", patch.created_at);
    if (patch.updated_at !== undefined) m.set("updated_at", patch.updated_at);
    if (patch.main_file !== undefined) m.set("main_file", patch.main_file);
  });
}

export function get_file_id(yp: YProjectDoc, path: string): FileId | undefined {
  return yp.paths.get(path) as FileId | undefined;
}

export function get_or_create_text_file(yp: YProjectDoc, path: string, initial?: string): Y.Text {
  const existing_fid = yp.paths.get(path) as FileId | undefined;
  if (existing_fid) {
    const existing = yp.texts.get(existing_fid);
    if (existing) return existing;
  }

  const fid = create_file_id();
  const now = Date.now();
  let ytext!: Y.Text;
  yp.doc.transact(() => {
    yp.paths.set(path, fid);
    const meta_map = new Y.Map<unknown>();
    meta_map.set("id", fid);
    meta_map.set("path", path);
    meta_map.set("kind", "text");
    meta_map.set("created_at", now);
    meta_map.set("updated_at", now);
    yp.file_meta.set(fid, meta_map);
    ytext = new Y.Text();
    if (initial) ytext.insert(0, initial);
    yp.texts.set(fid, ytext);
  });
  return ytext;
}

export function create_binary_file_ref(
  yp: YProjectDoc,
  path: string,
  hash: ContentHash,
  size: number,
  mime?: string,
): FileId {
  const existing_fid = yp.paths.get(path) as FileId | undefined;
  if (existing_fid) {
    yp.doc.transact(() => {
      yp.blob_refs.set(existing_fid, hash);
      const meta = yp.file_meta.get(existing_fid) as Y.Map<unknown> | undefined;
      if (meta) {
        meta.set("content_hash", hash);
        meta.set("size", size);
        if (mime) meta.set("mime", mime);
        meta.set("updated_at", Date.now());
      }
    });
    return existing_fid;
  }

  const fid = create_file_id();
  const now = Date.now();
  yp.doc.transact(() => {
    yp.paths.set(path, fid);
    const meta_map = new Y.Map<unknown>();
    meta_map.set("id", fid);
    meta_map.set("path", path);
    meta_map.set("kind", "binary");
    meta_map.set("created_at", now);
    meta_map.set("updated_at", now);
    meta_map.set("content_hash", hash);
    meta_map.set("size", size);
    if (mime) meta_map.set("mime", mime);
    yp.file_meta.set(fid, meta_map);
    yp.blob_refs.set(fid, hash);
  });
  return fid;
}

export function rename_file_path(yp: YProjectDoc, old_path: string, new_path: string): boolean {
  const fid = yp.paths.get(old_path) as FileId | undefined;
  if (!fid) return false;
  if (yp.paths.get(new_path) !== undefined) return false;
  yp.doc.transact(() => {
    yp.paths.delete(old_path);
    yp.paths.set(new_path, fid!);
    const meta = yp.file_meta.get(fid!) as Y.Map<unknown> | undefined;
    if (meta) {
      meta.set("path", new_path);
      meta.set("updated_at", Date.now());
    }
    yp.meta.set("updated_at", Date.now());
  });
  return true;
}

export function delete_file_entry(yp: YProjectDoc, path: string): boolean {
  const fid = yp.paths.get(path) as FileId | undefined;
  if (!fid) return false;
  yp.doc.transact(() => {
    yp.paths.delete(path);
    yp.file_meta.delete(fid!);
    yp.meta.set("updated_at", Date.now());
  });
  return true;
}

export function list_paths(yp: YProjectDoc): string[] {
  return Array.from(yp.paths.keys());
}

export function encode_snapshot(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function apply_snapshot(doc: Y.Doc, bytes: Uint8Array, origin?: unknown): void {
  Y.applyUpdate(doc, bytes, origin);
}

// agent-accessible helpers (operate directly on Y.Doc)

export function list_project_paths(doc: Y.Doc): string[] {
  const paths = doc.getMap(Y_PATHS);
  return Array.from(paths.keys());
}

export function read_project_file(doc: Y.Doc, path: string): string | Uint8Array | null {
  const yp = bind_y_project_doc(doc);
  const fid = yp.paths.get(path) as FileId | undefined;
  if (!fid) return null;
  const meta = yp.file_meta.get(fid) as Y.Map<unknown> | undefined;
  const kind = meta?.get("kind") as string | undefined;
  if (kind === "binary") {
    return null;
  }
  const ytext = yp.texts.get(fid);
  return ytext?.toString() ?? null;
}

export function get_project_ytext(doc: Y.Doc, path: string): Y.Text | null {
  const yp = bind_y_project_doc(doc);
  const fid = yp.paths.get(path) as FileId | undefined;
  if (!fid) return null;
  return yp.texts.get(fid) ?? null;
}

export function create_or_get_project_ytext(doc: Y.Doc, path: string): Y.Text {
  const yp = bind_y_project_doc(doc);
  return get_or_create_text_file(yp, path, "");
}

export function delete_project_file(doc: Y.Doc, path: string): boolean {
  const yp = bind_y_project_doc(doc);
  return delete_file_entry(yp, path);
}

export function rename_project_file(doc: Y.Doc, from: string, to: string): boolean {
  const yp = bind_y_project_doc(doc);
  return rename_file_path(yp, from, to);
}

export function encode_state_vector_base64(doc: Y.Doc): string {
  const sv = Y.encodeStateVector(doc);
  const binary = String.fromCharCode(...sv);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function has_state_advanced_since(doc: Y.Doc, base_state_vector: string): boolean {
  try {
    let str = base_state_vector.replace(/-/g, "+").replace(/_/g, "/");
    str += new Array(5 - (str.length % 4)).join("=");
    const bytes = new Uint8Array(atob(str).split("").map((c) => c.charCodeAt(0)));
    const currentSv = Y.encodeStateVector(doc);
    return currentSv.length !== bytes.length || currentSv.some((b, i) => b !== bytes[i]);
  } catch {
    return true;
  }
}
