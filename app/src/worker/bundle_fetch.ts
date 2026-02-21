// network fetch layer: ITAR index + Range-based bundle fetches
// JS is a dumb fetch executor -- all file list planning comes from Zig exports
// bundle URL comes from Zig config (single source of truth)
//
// IMPORTANT: get_index_url() / get_bundle_url() use JS-side fallback URLs
// so they work before api_instance is initialized (index fetch runs in
// parallel with WASM compilation). Once api_instance exists, the Zig
// comptime URLs are cached and used for all subsequent calls.

import { send_log, format_size, dbg } from "./protocol.ts";
import * as opfs from "./opfs.ts";
import * as wasm_api from "./wasm_api.ts";

export let index_bytes_len = 0;

// fallback URLs matching Config.zig defaults -- used when api_instance
// is not yet initialized (index fetch races WASM compilation).
const FALLBACK_BUNDLE_URL = "https://eztex-cors-proxy.thuva.workers.dev/bundle";
const FALLBACK_INDEX_URL = "https://eztex-cors-proxy.thuva.workers.dev/index.gz";

// get bundle URL: prefer Zig config via api_instance, fallback to JS constant.
function get_bundle_url(): string {
  if (wasm_api.has_instance()) return wasm_api.bundle_url();
  dbg("bundle", "api_instance not ready, using fallback bundle URL");
  return FALLBACK_BUNDLE_URL;
}

// get index URL: prefer Zig config via api_instance, fallback to JS constant.
function get_index_url(): string {
  if (wasm_api.has_instance()) return wasm_api.index_url();
  dbg("index", "api_instance not ready, using fallback index URL");
  return FALLBACK_INDEX_URL;
}

// fetch + gzip-decompress the ITAR index, with OPFS caching
export async function fetch_itar_index(): Promise<Uint8Array | null> {
  // try OPFS cache first
  if (opfs.supported) {
    try {
      const dir = await opfs.get_dir();
      const cached = await opfs.read(dir, "_itar_index.bin");
      if (cached) {
        index_bytes_len = cached.byteLength;
        send_log(`[index] loaded from OPFS (${format_size(cached.byteLength)})`);
        return cached;
      }
    } catch {
      // fall through to network
    }
  }

  send_log("[index] fetching ITAR index...");
  const index_url = get_index_url();
  dbg("index", `fetching: ${index_url}`);
  const resp = await fetch(index_url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`index fetch failed: ${resp.status}`);
  const compressed = new Uint8Array(await resp.arrayBuffer());
  send_log(`[index] downloaded ${format_size(compressed.byteLength)} compressed`);

  // decompress gzip via browser DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const decompressed = await new Response(ds.readable).arrayBuffer();
  const bytes = new Uint8Array(decompressed);
  index_bytes_len = bytes.byteLength;

  // cache to OPFS
  if (opfs.supported) {
    try {
      const dir = await opfs.get_dir();
      await opfs.write(dir, "_itar_index.bin", bytes);
    } catch {
      // non-critical
    }
  }

  return bytes;
}

// per-request timeout scales with file size: base 20s + 1s per 100KB
function request_timeout(length: number): number {
  return 20_000 + Math.ceil(length / 100_000) * 1_000;
}

// batch fetch files by name via Range requests
// resolves each name to (offset, length) via Zig's eztex_index_lookup
// retries failed fetches up to 2 times with exponential backoff
export async function batch_fetch(
  names: string[],
  cached_files: Map<string, Uint8Array>,
  concurrency: number = 6,
  tick?: (name: string) => void,
): Promise<void> {
  if (names.length === 0) return;

  // resolve names to index entries, skip any not in index
  const plan: { name: string; offset: bigint; length: number }[] = [];
  const skipped: string[] = [];
  const already_cached: string[] = [];
  for (const name of names) {
    if (cached_files.has(name)) {
      already_cached.push(name);
      continue;
    }
    const entry = wasm_api.index_lookup(name);
    if (entry) {
      plan.push({ name, offset: entry.offset, length: entry.length });
    } else {
      skipped.push(name);
    }
  }

  if (skipped.length > 0) {
    dbg("batch", `${skipped.length} files not in index: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? "..." : ""}`);
    send_log(`[batch] ${skipped.length} file(s) not in index (will fetch on demand)`, "log-warn");
  }
  if (already_cached.length > 0) {
    dbg("batch", `${already_cached.length} files already cached`);
  }
  dbg("batch", `plan: ${plan.length} files to fetch, ${skipped.length} skipped, ${already_cached.length} cached`);

  if (plan.length === 0) return;

  const t0 = performance.now();
  let fetched = 0;
  let failed = 0;
  const opfs_queue: { name: string; data: Uint8Array }[] = [];

  // first pass: fetch all with concurrency pool
  const failed_entries = await run_fetch_pass(plan, cached_files, opfs_queue, concurrency, tick);
  fetched = plan.length - failed_entries.length;

  // retry failed entries with lower concurrency and exponential backoff
  if (failed_entries.length > 0) {
    send_log(`[batch] retrying ${failed_entries.length} failed files...`);
    for (let attempt = 0; attempt < 2 && failed_entries.length > 0; attempt++) {
      const delay = 1000 * (attempt + 1); // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
      const still_failed = await run_fetch_pass(failed_entries, cached_files, opfs_queue, 2, tick);
      fetched += failed_entries.length - still_failed.length;
      failed_entries.length = 0;
      failed_entries.push(...still_failed);
    }
    failed = failed_entries.length;
    if (failed > 0) {
      const names_str = failed_entries.map((e) => e.name).join(", ");
      send_log(`[batch] permanent failures: ${names_str}`, "log-warn");
    }
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  if (fetched > 0 || failed > 0) {
    send_log(`[batch] ${fetched} fetched, ${failed} failed in ${elapsed}ms`);
  }

  // flush OPFS writes after all fetches complete (avoids contention during fetch)
  if (opfs_queue.length > 0) {
    flush_opfs(opfs_queue);
  }
}

// run a single fetch pass over entries with a concurrency pool
// returns the list of entries that failed
async function run_fetch_pass(
  entries: { name: string; offset: bigint; length: number }[],
  cached_files: Map<string, Uint8Array>,
  opfs_queue: { name: string; data: Uint8Array }[],
  concurrency: number,
  tick?: (name: string) => void,
): Promise<{ name: string; offset: bigint; length: number }[]> {
  let idx = 0;
  const failures: { name: string; offset: bigint; length: number }[] = [];
  const url = get_bundle_url(); // resolve once, reuse for all requests

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= entries.length) break;
      const entry = entries[i];
      if (cached_files.has(entry.name)) continue;
      const range_end = entry.offset + BigInt(entry.length) - 1n;
      const timeout = request_timeout(entry.length);

      try {
        const resp = await fetch(url, {
          headers: { Range: `bytes=${entry.offset}-${range_end}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!resp.ok && resp.status !== 206) throw new Error(`status ${resp.status}`);
        const data = new Uint8Array(await resp.arrayBuffer());
        cached_files.set(entry.name, data);
        opfs_queue.push({ name: entry.name, data });
        if (tick) tick(entry.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dbg("fetch", `failed: ${entry.name} (offset=${entry.offset}, len=${entry.length}): ${msg}`);
        failures.push(entry);
        if (tick) tick(entry.name + " (retry)");
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker());
  await Promise.all(workers);
  return failures;
}

// write fetched files to OPFS in the background (fire-and-forget)
function flush_opfs(queue: { name: string; data: Uint8Array }[]): void {
  (async () => {
    for (const { name, data } of queue) {
      try {
        await opfs.cache_file(name, data);
      } catch {
        // non-critical
      }
    }
  })();
}
