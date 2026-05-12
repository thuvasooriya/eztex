import { compute_hash } from "./crypto_utils";

export interface BlobRef {
  hash: string;
  size: number;
}

export class BlobStore {
  private project_id: string;
  private blobs_dir: FileSystemDirectoryHandle;

  constructor(project_id: string, blobs_dir: FileSystemDirectoryHandle) {
    this.project_id = project_id;
    this.blobs_dir = blobs_dir;
  }

  async put(bytes: Uint8Array): Promise<BlobRef> {
    const hash = await compute_hash(bytes);
    const handle = await this.blobs_dir.getFileHandle(hash, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
    } finally {
      try {
        await writable.close();
      } catch {
        // ignore close errors after a failed write
      }
    }
    return { hash, size: bytes.length };
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try {
      const handle = await this.blobs_dir.getFileHandle(hash);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      await this.blobs_dir.getFileHandle(hash);
      return true;
    } catch {
      return false;
    }
  }

  async ensure_available(hash: string): Promise<Uint8Array> {
    const bytes = await this.get(hash);
    if (!bytes) throw new Error(`Blob ${hash} not found for project ${this.project_id}`);
    return bytes;
  }

  async get_all_refs(): Promise<BlobRef[]> {
    const refs: BlobRef[] = [];
    for await (const [name, handle] of (this.blobs_dir as any).entries()) {
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile();
        refs.push({ hash: name, size: file.size });
      }
    }
    return refs;
  }
}
