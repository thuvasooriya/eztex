import * as Y from "yjs";
import { ProjectRepository, type LoadedProject } from "./project_repository";
import { RoomRegistry } from "./room_registry";
import { FolderHandleRegistry } from "./folder_handle_registry";
import { BlobStore } from "./blob_store";
import { ProjectBroadcast, type BCMessage } from "./project_broadcast";
import { create_project_store, type ProjectStore } from "./project_store";
import { create_collab_provider, type CollabProvider } from "./collab_provider";
import { create_local_folder_sync, type LocalFolderSync } from "./local_folder_sync";
import {
  bind_y_project_doc,
  apply_snapshot,
  get_project_metadata,
} from "./y_project_doc";
import type { ProjectId } from "./y_project_doc";
import type { ProjectSession } from "./project_session";
import { get_or_create_identity } from "./identity";
import { get_collab_ws_url } from "./collab_config";

export type CloseReason = "switch" | "tab-close" | "delete";

export class ProjectSessionManager {
  private current_session: ProjectSession | null = null;
  private repo: ProjectRepository;
  private room_registry: RoomRegistry;
  private folder_registry: FolderHandleRegistry;
  private _store: ReturnType<typeof create_project_store> | null = null;
  on_session_changed: ((session: ProjectSession | null) => void) | null = null;
  on_error: ((error: string) => void) | null = null;

  constructor() {
    this.repo = new ProjectRepository();
    this.room_registry = new RoomRegistry();
    this.folder_registry = new FolderHandleRegistry();
  }

  set_store(store: ReturnType<typeof create_project_store>): void {
    this._store = store;
  }

  get_repository(): ProjectRepository {
    return this.repo;
  }

  get_room_registry(): RoomRegistry {
    return this.room_registry;
  }

  get_folder_registry(): FolderHandleRegistry {
    return this.folder_registry;
  }

  async init(): Promise<void> {
    await this.repo.recover_pending_deletes();
  }

  private async _init_store_and_broadcast(
    project_id: ProjectId,
    doc: Y.Doc,
    loaded: LoadedProject,
    room_id?: string,
  ): Promise<{ store: ProjectStore; blob_store: BlobStore; broadcast: ProjectBroadcast }> {
    if (loaded.snapshot && loaded.snapshot.length > 0) {
      apply_snapshot(doc, loaded.snapshot, "eztex:load");
    }

    const blobs_dir = loaded.blobs_dir ?? await this.repo.get_blobs_dir(project_id);
    const blob_store = new BlobStore(project_id, blobs_dir);

    const store = this._store ?? create_project_store();
    const session_id = crypto.randomUUID();
    const broadcast = new ProjectBroadcast(project_id, session_id, (msg: BCMessage) => {
      if (msg.type === "yjs-update" && msg.payload instanceof Uint8Array) {
        Y.applyUpdate(doc, msg.payload, "eztex:remote-broadcast");
      } else if (msg.type === "blob-available") {
        store.handle_blob_available(msg.payload?.hash);
      } else if (msg.type === "blob-request") {
        store.handle_blob_request(msg.payload?.hash);
      } else if (msg.type === "blob-response") {
        store.handle_blob_response(msg.payload?.hash, msg.payload?.bytes);
      }
    });

    store.init_with_doc(project_id, doc, blob_store, broadcast);
    if (room_id !== undefined) {
      store.set_room_id(room_id);
    }

    return { store, blob_store, broadcast };
  }

  private _create_session(options: {
    project_id: ProjectId;
    doc: Y.Doc;
    store: ProjectStore;
    blob_store: BlobStore;
    broadcast: ProjectBroadcast;
    collab_provider: CollabProvider | null;
    folder_sync: LocalFolderSync | null;
  }): ProjectSession {
    return {
      project_id: options.project_id,
      doc: options.doc,
      store: options.store,
      blob_store: options.blob_store,
      broadcast: options.broadcast,
      collab_provider: options.collab_provider,
      folder_sync: options.folder_sync,
      flush: async () => { await this.flush(); },
      close: async (reason: CloseReason) => { await this.close_current(reason); },
    };
  }

  private async _activate_session(session: ProjectSession): Promise<void> {
    this.current_session = session;
    await this.repo.set_current_project(session.project_id);
    this.on_session_changed?.(session);
  }

  async open_local(project_id: ProjectId): Promise<ProjectSession> {
    await this.close_current("switch");

    const loaded = await this.repo.load_project(project_id);
    const doc = new Y.Doc();
    const yp = bind_y_project_doc(doc);
    const { store, blob_store, broadcast } = await this._init_store_and_broadcast(project_id, doc, loaded);

    if (loaded.snapshot && loaded.snapshot.length > 0 && store.file_names().length > 0) {
      const meta = get_project_metadata(yp);
      if (meta.main_file && store.file_names().includes(meta.main_file)) {
        store.set_main_file(meta.main_file);
        store.set_current_file(meta.main_file);
      }
    }

    if (!loaded.snapshot || store.file_names().length === 0) {
      await store.init_from_template();
    } else {
      await store.load_persisted_blobs();
    }

    let folder_sync: LocalFolderSync | null = null;
    const handle_record = await this.folder_registry.get_handle(project_id);
    if (handle_record) {
      folder_sync = create_local_folder_sync(store, project_id, this.folder_registry);
      try {
        const perm = await (handle_record.handle as any).requestPermission({ mode: "readwrite" });
        if (perm === "granted") {
          await folder_sync.reconnect();
        }
      } catch {
        // permission denied, skip folder sync
      }
    }

    const room = await this.room_registry.get_by_project_id(project_id);
    if (room) {
      store.set_room_id(room.room_id);
    }

    const session = this._create_session({
      project_id,
      doc,
      store,
      blob_store,
      broadcast,
      collab_provider: null,
      folder_sync,
    });
    await this._activate_session(session);
    return session;
  }

  async open_guest_room(room_id: string, token: string): Promise<ProjectSession> {
    await this.close_current("switch");

    const room = await this.room_registry.get_by_room_id(room_id);
    let project_id: ProjectId;
    let project_name = "Shared Project";

    if (room) {
      project_id = room.project_id;
      const record = await this.repo.get_project(project_id);
      if (record) project_name = record.name;
    } else {
      const record = await this.repo.create_project(project_name, "guest-room");
      project_id = record.id;
      await this.room_registry.save_guest_room(room_id, project_id, token);
    }

    const loaded = await this.repo.load_project(project_id);
    const doc = new Y.Doc();
    const { store, blob_store, broadcast } = await this._init_store_and_broadcast(project_id, doc, loaded, room_id);

    if (!loaded.snapshot || store.file_names().length === 0) {
      // guest room: wait for collab snapshot
    } else {
      await store.load_persisted_blobs();
    }

    const identity = get_or_create_identity();
    const collab_provider = create_collab_provider({
      room_id,
      token,
      doc,
      awareness: store.awareness(),
      identity,
      ws_url: get_collab_ws_url(room_id),
      put_blobs: async (blobs: Record<string, string>) => {
        await store.import_blobs(blobs);
      },
      on_status: () => {},
      on_permission: () => {},
    });

    const session = this._create_session({
      project_id,
      doc,
      store,
      blob_store,
      broadcast,
      collab_provider,
      folder_sync: null,
    });

    collab_provider.connect();
    await this._activate_session(session);
    return session;
  }

  async open_owned_room(project_id: ProjectId, room_id: string): Promise<ProjectSession> {
    await this.close_current("switch");

    const room = await this.room_registry.get_by_room_id(room_id);
    if (!room || room.role !== "owner") {
      throw new Error("Not owner of room");
    }

    const loaded = await this.repo.load_project(project_id);
    const doc = new Y.Doc();
    const { store, blob_store, broadcast } = await this._init_store_and_broadcast(project_id, doc, loaded, room_id);

    if (loaded.snapshot && loaded.snapshot.length > 0 && store.file_names().length > 0) {
      const yp = bind_y_project_doc(doc);
      const meta = get_project_metadata(yp);
      if (meta.main_file && store.file_names().includes(meta.main_file)) {
        store.set_main_file(meta.main_file);
        store.set_current_file(meta.main_file);
      }
      await store.load_persisted_blobs();
    }

    const identity = get_or_create_identity();
    const { create_share_token } = await import("./room_registry");
    const room_secret = room.room_secret!;
    const write_token = await create_share_token(room_secret, room_id, "w");

    const precomputed_blobs = await store.export_blobs();

    const collab_provider = create_collab_provider({
      room_id,
      token: write_token,
      room_secret,
      doc,
      awareness: store.awareness(),
      identity,
      ws_url: get_collab_ws_url(room_id),
      precomputed_blobs,
      put_blobs: async (blobs: Record<string, string>) => {
        await store.import_blobs(blobs);
      },
      on_status: () => {},
      on_permission: () => {},
    });

    const session = this._create_session({
      project_id,
      doc,
      store,
      blob_store,
      broadcast,
      collab_provider,
      folder_sync: null,
    });

    collab_provider.connect();
    await this._activate_session(session);
    return session;
  }

  async switch_to(project_id: ProjectId): Promise<ProjectSession> {
    return await this.open_local(project_id);
  }

  async close_current(reason: CloseReason): Promise<void> {
    const session = this.current_session;
    if (!session) return;

    if (reason !== "delete") {
      await this.flush();
    }

    session.broadcast.send_session_closing();
    session.broadcast.close();

    if (session.collab_provider) {
      session.collab_provider.destroy();
    }

    if (session.folder_sync) {
      session.folder_sync.cleanup();
    }

    if (!this._store) {
      session.store.destroy();
    }
    session.doc.destroy();

    this.current_session = null;
    if (reason === "switch") {
      this.on_session_changed?.(null);
    }
  }

  async delete_project(project_id: ProjectId): Promise<void> {
    const session = this.current_session;
    const is_current = session?.project_id === project_id;

    if (is_current) {
      await this.close_current("delete");
    }

    await this.room_registry.delete_by_project_id(project_id);
    await this.folder_registry.delete_by_project_id(project_id);
    await this.repo.delete_project(project_id);

    this.on_session_changed?.(null);
  }

  async flush(): Promise<void> {
    const session = this.current_session;
    if (!session) return;
    await session.store.flush_dirty_blobs();
    const snapshot = session.store.encode_ydoc_snapshot();
    await this.repo.save_snapshot(session.project_id, snapshot);
    await this.repo.update_main_file(session.project_id, session.store.main_file());
  }

  current(): ProjectSession | null {
    return this.current_session;
  }
}
