// OPFS (Origin Private File System) cache layer
// persists support files and format across browser sessions
// uses nested OPFS directories matching the original path structure

import { send_cache_status, format_size, dbg } from "./protocol.ts";

export const supported: boolean =
  typeof navigator !== "undefined" &&
  "storage" in navigator &&
  "getDirectory" in (navigator.storage ?? {});

let cache_dir: FileSystemDirectoryHandle | null = null;

export async function get_dir(): Promise<FileSystemDirectoryHandle> {
  if (cache_dir) return cache_dir;
  const root = await navigator.storage.getDirectory();
  cache_dir = await root.getDirectoryHandle("eztex-cache", { create: true });
  return cache_dir;
}

// resolve a path like "fonts/CMR10.otf" into (parent_dir_handle, "CMR10.otf")
// creates intermediate directories as needed when create=true
async function resolve_path(
  base: FileSystemDirectoryHandle,
  key: string,
  create: boolean,
): Promise<[FileSystemDirectoryHandle, string] | null> {
  const parts = key.split("/");
  const filename = parts.pop()!;
  let dir = base;
  for (const part of parts) {
    if (!part) continue;
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return [dir, filename];
}

export async function read(dir: FileSystemDirectoryHandle, filename: string): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

export async function write(dir: FileSystemDirectoryHandle, filename: string, data: Uint8Array): Promise<void> {
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data as any);
  await writable.close();
}

// read a nested path from cache (e.g. "fonts/CMR10.otf")
async function read_nested(base: FileSystemDirectoryHandle, key: string): Promise<Uint8Array | null> {
  const resolved = await resolve_path(base, key, false);
  if (!resolved) return null;
  return read(resolved[0], resolved[1]);
}

// write a nested path to cache, creating intermediate directories
async function write_nested(base: FileSystemDirectoryHandle, key: string, data: Uint8Array): Promise<void> {
  const resolved = await resolve_path(base, key, true);
  if (!resolved) return;
  await write(resolved[0], resolved[1], data);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function read_meta(dir: FileSystemDirectoryHandle): Promise<Record<string, unknown> | null> {
  const raw = await read(dir, "_metadata.json");
  if (!raw) return null;
  try {
    return JSON.parse(decoder.decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function write_meta(dir: FileSystemDirectoryHandle, meta: Record<string, unknown>): Promise<void> {
  const raw = encoder.encode(JSON.stringify(meta));
  await write(dir, "_metadata.json", raw);
}

export async function clear(): Promise<void> {
  if (!supported) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("eztex-cache", { recursive: true });
    cache_dir = null;
    dbg("cache", "OPFS cache cleared");
    send_cache_status("cleared");
  } catch (e) {
    dbg("cache", `clear failed: ${(e as Error).message}`);
  }
}

// save a single file to OPFS (fire-and-forget for on-demand fetched files)
export async function cache_file(key: string, data: Uint8Array): Promise<void> {
  if (!supported) return;
  try {
    const dir = await get_dir();
    await write_nested(dir, key, data);
  } catch {
    // non-critical
  }
}

// load init files from OPFS, returns true if cache hit
export async function load_init(
  version: string,
  init_keys: string[],
  cached_files: Map<string, Uint8Array>,
  tick: (name: string) => void,
): Promise<boolean> {
  if (!supported) {
    dbg("cache", "OPFS not supported");
    send_cache_status("unsupported");
    return false;
  }

  try {
    const dir = await get_dir();
    const meta = await read_meta(dir);

    if (!meta || meta.version !== version) {
      const reason = !meta ? "no cache" : "version mismatch";
      dbg("cache", `miss: ${reason}`);
      send_cache_status("miss", reason);
      return false;
    }

    send_cache_status("loading", "reading from OPFS cache...");
    const t0 = performance.now();
    let all_ok = true;

    for (const key of init_keys) {
      const data = await read_nested(dir, key);
      if (!data) {
        dbg("cache", `missing: ${key}, falling back to network`);
        all_ok = false;
        break;
      }
      cached_files.set(key, data);
      tick(key);
    }

    if (all_ok) {
      // scan for extra cached files (on_demand from previous sessions)
      try {
        await scan_dir_recursive(dir, "", cached_files);
      } catch {
        // non-critical
      }

      const cache_ms = (performance.now() - t0).toFixed(0);
      const bonus = cached_files.size - init_keys.length;
      dbg("cache", `loaded ${init_keys.length} init files${bonus > 0 ? ` + ${bonus} extra` : ""} in ${cache_ms}ms`);
      send_cache_status("hit", `${cached_files.size} files from cache (${cache_ms}ms)`);
      return true;
    }

    cached_files.clear();
    return false;
  } catch (e) {
    dbg("cache", `OPFS error: ${(e as Error).message}`);
    send_cache_status("error", (e as Error).message);
    return false;
  }
}

// recursively scan OPFS directories for cached files
async function scan_dir_recursive(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Map<string, Uint8Array>,
): Promise<void> {
  for await (const [name, handle] of (dir as any).entries()) {
    if (name.startsWith("_")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await scan_dir_recursive(handle as FileSystemDirectoryHandle, path, out);
    } else if (handle.kind === "file") {
      if (out.has(path)) continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.set(path, new Uint8Array(await file.arrayBuffer()));
      } catch {
        // skip individual file errors
      }
    }
  }
}

// write all cached files to OPFS
export async function write_all(
  files: Map<string, Uint8Array>,
  version: string,
): Promise<void> {
  const t0 = performance.now();
  let total_bytes = 0;
  const dir = await get_dir();

  for (const [key, data] of files) {
    await write_nested(dir, key, data);
    total_bytes += data.byteLength;
  }

  await write_meta(dir, {
    version,
    file_count: files.size,
    total_bytes,
    cached_at: new Date().toISOString(),
  });

  const elapsed = (performance.now() - t0).toFixed(0);
  dbg("cache", `wrote ${files.size} files (${format_size(total_bytes)}) to OPFS in ${elapsed}ms`);
  send_cache_status("cached", `${files.size} files saved`);
}

// load xelatex.fmt from OPFS if available
export async function load_format(cached_files: Map<string, Uint8Array>): Promise<void> {
  if (!supported || cached_files.has("xelatex.fmt")) return;
  try {
    const dir = await get_dir();
    const fmt_data = await read(dir, "xelatex.fmt");
    if (fmt_data) {
      cached_files.set("xelatex.fmt", fmt_data);
      dbg("cache", `loaded xelatex.fmt from OPFS (${format_size(fmt_data.byteLength)})`);
    }
  } catch {
    // non-critical
  }
}
