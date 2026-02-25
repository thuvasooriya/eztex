// network fetch layer: ITAR index + Range-based bundle fetches
// JS is a dumb fetch executor -- all file list planning comes from Zig exports
// bundle URL comes from Zig config (single source of truth)
//
// IMPORTANT: get_index_url() / get_bundle_url() use JS-side fallback URLs
// so they work before api_instance is initialized (index fetch runs in
// parallel with WASM compilation). Once api_instance exists, the Zig
// comptime URLs are cached and used for all subsequent calls.

import { format_size, dbg } from "./protocol.ts";
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
        dbg("index", `loaded from OPFS (${format_size(cached.byteLength)})`);
        return cached;
      }
    } catch {
      // fall through to network
    }
  }

  dbg("index", "fetching ITAR index from network...");
  const index_url = get_index_url();
  dbg("index", `fetching: ${index_url}`);
  let resp: Response;
  try {
    resp = await fetch(index_url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      offline
        ? `cannot fetch package index -- you appear to be offline and the index was not previously cached`
        : `index fetch failed: ${msg}`,
    );
  }
  if (!resp.ok) throw new Error(`index fetch failed: HTTP ${resp.status}`);
  const compressed = new Uint8Array(await resp.arrayBuffer());
  dbg("index", `downloaded ${format_size(compressed.byteLength)} compressed`);

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

// merge adjacent Range entries to reduce HTTP request count.
// entries must be pre-sorted by offset. merges when gap <= max_gap
// and combined size <= max_range_size.
interface MergedRange {
  names: string[];
  offsets: number[];     // per-file offset within merged response
  lengths: number[];     // per-file original length
  range_start: number;   // byte offset in bundle
  range_length: number;  // total bytes to fetch
}

function merge_ranges(
  entries: { name: string; offset: bigint; length: number }[],
  max_gap: number = 65536,
  max_range_size: number = 2 * 1024 * 1024,
): MergedRange[] {
  if (entries.length === 0) return [];

  // sort by offset
  const sorted = [...entries].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));

  const merged: MergedRange[] = [];
  let cur: MergedRange = {
    names: [sorted[0].name],
    offsets: [0],
    lengths: [sorted[0].length],
    range_start: Number(sorted[0].offset),
    range_length: sorted[0].length,
  };

  for (let i = 1; i < sorted.length; i++) {
    const entry = sorted[i];
    const entry_start = Number(entry.offset);
    const cur_end = cur.range_start + cur.range_length;
    const gap = entry_start - cur_end;
    const new_length = (entry_start - cur.range_start) + entry.length;

    if (gap <= max_gap && new_length <= max_range_size) {
      // merge into current range
      cur.names.push(entry.name);
      cur.offsets.push(entry_start - cur.range_start);
      cur.lengths.push(entry.length);
      cur.range_length = new_length;
    } else {
      // start new range
      merged.push(cur);
      cur = {
        names: [entry.name],
        offsets: [0],
        lengths: [entry.length],
        range_start: entry_start,
        range_length: entry.length,
      };
    }
  }
  merged.push(cur);
  return merged;
}

// batch fetch files by name via Range requests
// resolves each name to (offset, length) via Zig's eztex_index_lookup
// uses range merging for efficiency, retries failed fetches
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

  // merge adjacent ranges for fewer HTTP requests
  const ranges = merge_ranges(plan);
  dbg("batch", `merged ${plan.length} files into ${ranges.length} range requests`);

  // first pass: fetch all with concurrency pool
  const failed_entries = await run_merged_fetch_pass(ranges, cached_files, opfs_queue, concurrency, tick);
  fetched = plan.length - failed_entries.length;

  // retry failed entries individually with lower concurrency
  if (failed_entries.length > 0) {
    dbg("batch", `retrying ${failed_entries.length} failed files...`);
    const individual_plan = failed_entries.map(e => ({
      name: e.name, offset: BigInt(e.offset), length: e.length,
    }));
    for (let attempt = 0; attempt < 2 && individual_plan.length > 0; attempt++) {
      const delay = 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      const still_failed = await run_fetch_pass(individual_plan, cached_files, opfs_queue, 2, tick);
      fetched += individual_plan.length - still_failed.length;
      individual_plan.length = 0;
      individual_plan.push(...still_failed);
    }
    failed = individual_plan.length;
    if (failed > 0) {
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      const names_str = individual_plan.map((e) => e.name).join(", ");
      const hint = offline ? " (you appear to be offline)" : "";
      dbg("batch", `permanent failures${hint}: ${names_str}`);
    }
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  dbg("batch", `${fetched} fetched, ${failed} failed in ${elapsed}ms (${ranges.length} requests)`);

  // flush OPFS writes after all fetches complete
  if (opfs_queue.length > 0) {
    flush_opfs(opfs_queue);
  }
}

// fetch merged ranges with a concurrency pool, split response into individual files
async function run_merged_fetch_pass(
  ranges: MergedRange[],
  cached_files: Map<string, Uint8Array>,
  opfs_queue: { name: string; data: Uint8Array }[],
  concurrency: number,
  tick?: (name: string) => void,
): Promise<{ name: string; offset: number; length: number }[]> {
  let idx = 0;
  const failures: { name: string; offset: number; length: number }[] = [];
  const url = get_bundle_url();

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= ranges.length) break;
      const range = ranges[i];
      const range_end = range.range_start + range.range_length - 1;
      const timeout = request_timeout(range.range_length);

      try {
        const resp = await fetch(url, {
          headers: { Range: `bytes=${range.range_start}-${range_end}` },
          signal: AbortSignal.timeout(timeout),
        });
        if (!resp.ok && resp.status !== 206) throw new Error(`status ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());

        // split merged response into individual files
        for (let j = 0; j < range.names.length; j++) {
          const name = range.names[j];
          if (cached_files.has(name)) continue;
          const data = buf.slice(range.offsets[j], range.offsets[j] + range.lengths[j]);
          cached_files.set(name, data);
          opfs_queue.push({ name, data });
          if (tick) tick(name);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dbg("fetch", `merged range failed (${range.names.length} files, offset=${range.range_start}, len=${range.range_length}): ${msg}`);
        // add all files in this range as individual failures for retry
        for (let j = 0; j < range.names.length; j++) {
          if (!cached_files.has(range.names[j])) {
            failures.push({
              name: range.names[j],
              offset: range.range_start + range.offsets[j],
              length: range.lengths[j],
            });
          }
        }
        if (tick) {
          for (const name of range.names) {
            if (!cached_files.has(name)) tick(name + " (retry)");
          }
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker());
  await Promise.all(workers);
  return failures;
}

// run a single fetch pass over individual entries with a concurrency pool
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
  const url = get_bundle_url();

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
