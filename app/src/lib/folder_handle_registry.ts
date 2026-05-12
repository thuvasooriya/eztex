import { get, put, remove } from "./storage_db";

export interface FolderHandleRecord {
  project_id: string;
  handle: FileSystemDirectoryHandle;
  folder_name: string;
  updated_at: number;
}

export class FolderHandleRegistry {
  async has_handle(project_id: string): Promise<boolean> {
    const record = await this.get_handle(project_id);
    return record !== null;
  }

  async get_handle(project_id: string): Promise<FolderHandleRecord | null> {
    return (await get<FolderHandleRecord>("folder_handles", project_id)) ?? null;
  }

  async set_handle(project_id: string, handle: FileSystemDirectoryHandle, folder_name: string): Promise<void> {
    const record: FolderHandleRecord = {
      project_id,
      handle,
      folder_name,
      updated_at: Date.now(),
    };
    await put("folder_handles", record, project_id);
  }

  async clear_handle(project_id: string): Promise<void> {
    await remove("folder_handles", project_id);
  }

  async delete_by_project_id(project_id: string): Promise<void> {
    await remove("folder_handles", project_id);
  }
}
