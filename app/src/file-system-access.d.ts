// type declarations for the File System Access API (Chrome/Edge)

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  readonly name: string;
  readonly kind: "directory";
}

interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  readonly name: string;
  readonly kind: "file";
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | ArrayBuffer | Uint8Array | Blob | DataView): Promise<void>;
  close(): Promise<void>;
}

interface Window {
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}
