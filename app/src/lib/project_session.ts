import * as Y from "yjs";
import type { ProjectId } from "./y_project_doc";
import type { ProjectStore } from "./project_store";
import type { BlobStore } from "./blob_store";
import type { ProjectBroadcast } from "./project_broadcast";
import type { CollabProvider } from "./collab_provider";
import type { LocalFolderSync } from "./local_folder_sync";

export interface ProjectSession {
  project_id: ProjectId;
  doc: Y.Doc;
  store: ProjectStore;
  blob_store: BlobStore;
  broadcast: ProjectBroadcast;
  collab_provider: CollabProvider | null;
  folder_sync: LocalFolderSync | null;

  flush(): Promise<void>;
  close(reason: "switch" | "tab-close" | "delete"): Promise<void>;
}
