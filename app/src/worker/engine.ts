// orchestrator: init, compile, format generation
// owns wasm_module and cached_files state
//
// fetch-on-open: eztex_fetch_range is called synchronously by Zig when the
// engine needs a file. JS performs a sync XHR Range request in the worker
// thread, caches in memory + OPFS, and returns bytes to Zig immediately.
// no retry loops or miss lists needed.

import {
  WASI,
  File as WasiFile,
  Directory,
  PreopenDirectory,
  OpenFile,
  ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";
import {
  send_log,
  log,
  dbg,
  DEBUG,
  send_status,
  send_progress,
  send_complete,
  send_ready,
  send_cache_status,
  format_size,
  type ProjectFiles,
} from "./protocol.ts";
import * as opfs from "./opfs.ts";
import * as wasm_api from "./wasm_api.ts";
import * as bundle from "./bundle_fetch.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let wasm_module: WebAssembly.Module | null = null;
let cached_files: Map<string, Uint8Array> | null = null;
let cached_index_text: Uint8Array | null = null;

// -- WASI filesystem builder --

function build_wasi_fs(user_files: ProjectFiles | null): {
  root_map: Map<string, WasiFile | Directory>;
  tmp_map: Map<string, WasiFile | Directory>;
} {
  const root_map = new Map<string, WasiFile | Directory>();
  const fonts_map = new Map<string, WasiFile | Directory>();

  let cached_count = 0;
  if (cached_files) {
    for (const [name, data] of cached_files) {
      if (name.startsWith("fonts/")) {
        fonts_map.set(name.slice(6), new WasiFile(new Uint8Array(data)));
      } else {
        root_map.set(name, new WasiFile(new Uint8Array(data)));
      }
      cached_count++;
    }
  }

  root_map.set("fonts", new Directory(fonts_map));
  const tmp_map = new Map<string, WasiFile | Directory>();
  root_map.set("tmp", new Directory(tmp_map));

  // write user files into WASI filesystem (null for format generation)
  const user_count = Object.keys(user_files || {}).length;
  for (const [name, content] of Object.entries(user_files || {})) {
    const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
    root_map.set(name, new WasiFile(bytes));
  }

  dbg("wasi_fs", `built: ${cached_count} cached + ${user_count} user + fonts dir (${fonts_map.size} fonts) + tmp dir`);
  return { root_map, tmp_map };
}

// -- sync fetch-on-open: eztex_fetch_range import for WASM --
// when Zig resolves a file via its index and calls this import, we:
// 1. check memory cache (cached_files)
// 2. do a synchronous XHR Range request if not cached
// 3. cache the result in memory + OPFS
// 4. write bytes into WASM memory and return

function make_fetch_env(): {
  env: Record<string, WebAssembly.ImportValue>;
  set_instance: (inst: WebAssembly.Instance) => void;
  stats: { fetches: number; cache_hits: number; fetch_bytes: number };
} {
  let wasm_instance: WebAssembly.Instance | null = null;
  const stats = { fetches: 0, cache_hits: 0, fetch_bytes: 0 };
  // cache bundle URL once at env creation time so the sync XHR hot path
  // never calls back into the api_instance (which may be a different wasm instance)
  const resolved_bundle_url = wasm_api.bundle_url();

  interface WasmExports {
    memory: WebAssembly.Memory;
    eztex_alloc(size: number): number;
    eztex_free(ptr: number, size: number): void;
  }

  const env = {
    // posix dup() stub -- Zig's std.posix.dup compiles to an env import on wasm32-wasi.
    // bridge.zig calls dup() for gzdopen fd duplication. stub returns -1 (failure is handled).
    dup(): number { return -1; },
    js_request_range(
      name_ptr: number,
      name_len: number,
      offset_lo: number,
      offset_hi: number,
      length: number,
      buf_ptr_ptr: number,
      buf_len_ptr: number,
    ): number {
      const exports = wasm_instance!.exports as unknown as WasmExports;
      const mem = new Uint8Array(exports.memory.buffer);
      const name = decoder.decode(mem.subarray(name_ptr, name_ptr + name_len));
      dbg("fetch_range", `called: ${name} offset=${offset_lo + offset_hi * 0x100000000} len=${length}`);

      // 1. check memory cache
      let data = cached_files?.get(name);
      if (!data) {
        // also check without fonts/ prefix (index stores bare names)
        if (name.startsWith("fonts/")) {
          data = cached_files?.get(name.slice(6));
        }
      }

      if (data) {
        stats.cache_hits++;
      } else {
        // 2. synchronous XHR Range fetch (1 retry on failure)
        const offset = offset_lo + offset_hi * 0x100000000;
        const range_end = offset + length - 1;
        let last_err: string | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", resolved_bundle_url, false); // synchronous
            xhr.responseType = "arraybuffer";
            xhr.setRequestHeader("Range", `bytes=${offset}-${range_end}`);
            xhr.send();

            if (xhr.status !== 200 && xhr.status !== 206) {
              last_err = `HTTP ${xhr.status}`;
              continue;
            }

            data = new Uint8Array(xhr.response as ArrayBuffer);
            last_err = null;
            break;
          } catch (err) {
            last_err = (err as Error).message;
          }
        }
        if (last_err || !data) {
          log("fetch", "error", `sync XHR failed for ${name}: ${last_err}`);
          return -1;
        }

        stats.fetches++;
        stats.fetch_bytes += data.byteLength;

        // 3. cache in memory
        if (cached_files) {
          cached_files.set(name, data);
        }

        // 4. cache in OPFS (fire-and-forget, async is fine here since data is already in memory)
        opfs.cache_file(name, data);

        dbg("fetch", `fetched ${name} (${format_size(data.byteLength)})`);
      }

      // write data into WASM memory
      const wasm_ptr = exports.eztex_alloc(data.byteLength);
      if (!wasm_ptr) return -1;

      const wasm_mem = new Uint8Array(exports.memory.buffer);
      wasm_mem.set(data, wasm_ptr);

      const view = new DataView(exports.memory.buffer);
      view.setUint32(buf_ptr_ptr, wasm_ptr, true);
      view.setUint32(buf_len_ptr, data.byteLength, true);

      return 0;
    },
    // provide decompressed ITAR index text to Zig.
    // cached_index_text is set during init from the async fetch.
    js_request_index(buf_ptr_ptr: number, buf_len_ptr: number): number {
      dbg("fetch_index", `called, cached_index_text=${cached_index_text ? format_size(cached_index_text.byteLength) : "null"}, instance=${!!wasm_instance}`);
      if (!cached_index_text || !wasm_instance) return -1;
      const exports = wasm_instance.exports as unknown as WasmExports;
      const wasm_ptr = exports.eztex_alloc(cached_index_text.byteLength);
      if (!wasm_ptr) return -1;
      const wasm_mem = new Uint8Array(exports.memory.buffer);
      wasm_mem.set(cached_index_text, wasm_ptr);
      const view = new DataView(exports.memory.buffer);
      view.setUint32(buf_ptr_ptr, wasm_ptr, true);
      view.setUint32(buf_len_ptr, cached_index_text.byteLength, true);
      return 0;
    },
  };

  function set_instance(inst: WebAssembly.Instance): void {
    wasm_instance = inst;
  }
  return { env, set_instance, stats };
}

// -- run wasm: shared compile/format-gen runner --

interface RunResult {
  exit_code: number;
  root_map: Map<string, WasiFile | Directory>;
  tmp_map: Map<string, WasiFile | Directory>;
  fetch_stats: { fetches: number; cache_hits: number; fetch_bytes: number };
}

function run_wasm(
  wasi_args: string[],
  user_files: ProjectFiles | null,
  classify_stderr: boolean = false,
): RunResult {
  const label = wasi_args[1] ?? "wasm";
  dbg("run", `run_wasm: args=[${wasi_args.join(",")}], files=${user_files ? Object.keys(user_files).length : 0}`);
  const { root_map, tmp_map } = build_wasi_fs(user_files);
  const { env, set_instance, stats } = make_fetch_env();

  const stderr_handler = classify_stderr
    ? (line: string) => {
        if (line.includes("error") || line.includes("Error")) send_log(line, "log-error");
        else if (line.includes("warning") || line.includes("Warning")) send_log(line, "log-warn");
        else send_log(line, "log-info");
      }
    : (line: string) => send_log(line, "log-info");

  const fds = [
    new OpenFile(new WasiFile(new Uint8Array())),
    ConsoleStdout.lineBuffered((line: string) => send_log(line)),
    ConsoleStdout.lineBuffered(stderr_handler),
    new PreopenDirectory(".", root_map),
  ];

  const wasi = new WASI(wasi_args, [], fds);
  dbg("run", `instantiating WebAssembly.Instance for ${label}...`);
  const instance = new WebAssembly.Instance(wasm_module!, {
    wasi_snapshot_preview1: wasi.wasiImport,
    env,
  });
  set_instance(instance);
  if (DEBUG) {
    const exp = instance.exports as Record<string, Function>;
    if (exp.eztex_set_debug) exp.eztex_set_debug(1);
  }
  dbg("run", `instance created, exports: ${Object.keys(instance.exports).join(",")}`);

  let exit_code: number;
  try {
    dbg("run", `calling wasi.start() for ${label}...`);
    exit_code = wasi.start(instance);
    dbg("run", `wasi.start() returned exit_code=${exit_code}`);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      log("wasm", "error", `runtime error: ${e.message}`);
      dbg("run", `RuntimeError stack: ${e.stack}`);
      exit_code = 1;
    } else {
      const err = e as { exit_code?: number; message?: string; constructor?: { name?: string } };
      if (err.exit_code !== undefined) {
        exit_code = err.exit_code;
      } else {
        log("wasm", "error", `exception: ${err.constructor?.name}: ${err.message}`);
        exit_code = 1;
      }
    }
  }

  return { exit_code, root_map, tmp_map, fetch_stats: stats };
}

// -- generate xelatex.fmt via initex (fetch-on-open for missing files) --

async function generate_format(): Promise<boolean> {
  if (!wasm_module || !cached_files) return false;

  dbg("fmt", "generating xelatex.fmt via initex (fetch-on-open)...");
  send_status("Generating format...", "loading");
  send_progress(0);
  const t0 = performance.now();

  const { exit_code, tmp_map, fetch_stats } = run_wasm(["eztex", "generate-format"], null);

  // check for format output (may appear in tmp/ as xelatex.fmt or _make_xelatex_fmt.fmt)
  const fmt_inode = (tmp_map.get("xelatex.fmt") ?? tmp_map.get("_make_xelatex_fmt.fmt")) as WasiFile | undefined;
  if (fmt_inode && fmt_inode.data && fmt_inode.data.byteLength > 0) {
    const fmt_copy = new Uint8Array(fmt_inode.data);
    cached_files.set("xelatex.fmt", fmt_copy);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    log("fmt", "info", `generated xelatex.fmt (${format_size(fmt_copy.byteLength)}) in ${elapsed}s`);
    if (fetch_stats.fetches > 0) {
      dbg("fmt", `fetched ${fetch_stats.fetches} files on-demand (${format_size(fetch_stats.fetch_bytes)}), ${fetch_stats.cache_hits} cache hits`);
    }
    opfs.cache_file("xelatex.fmt", fmt_copy);
    return true;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  log("fmt", "warn", `format generation failed (exit code ${exit_code}) in ${elapsed}s`);
  if (fetch_stats.fetches > 0) {
    dbg("fmt", `fetched ${fetch_stats.fetches} files on-demand before failure`);
  }
  return false;
}

// -- init: load WASM + ITAR index + init files from Zig exports --

export async function init(): Promise<void> {
  send_status("Loading WASM...", "loading");
  dbg("init", "engine.init() starting");
  const t0_total = performance.now();

  // step 1: compile WASM + fetch ITAR index in parallel.
  const wasm_promise = (async () => {
    dbg("init", "fetching /eztex.wasm...");
    const wasm_resp = await fetch("/eztex.wasm", { cache: "no-cache" });
    if (!wasm_resp.ok) throw new Error("failed to fetch eztex.wasm");
    dbg("init", `wasm response: ${wasm_resp.status}, content-length=${wasm_resp.headers.get("content-length")}`);
    wasm_module = await WebAssembly.compileStreaming(Promise.resolve(wasm_resp));
    dbg("init", "WebAssembly.compileStreaming complete");
  })();

  const index_bytes_promise = (async () => {
    try {
      return await bundle.fetch_itar_index();
    } catch (e) {
      log("init", "warn", `index fetch failed: ${(e as Error).message}`);
      return null;
    }
  })();

  await wasm_promise;

  // step 2: create persistent api_instance (for index queries, cache marking, file lists)
  try {
    dbg("init", "creating api_instance (persistent, for index queries)...");
    const fds = [
      new OpenFile(new WasiFile(new Uint8Array())),
      ConsoleStdout.lineBuffered(() => {}),
      ConsoleStdout.lineBuffered(() => {}),
    ];
    const wasi = new WASI([], [], fds);
    const api_inst = new WebAssembly.Instance(wasm_module!, {
      wasi_snapshot_preview1: wasi.wasiImport,
      env: {
        dup() { return -1; },
        js_request_range() { return -1; },
        js_request_index() { return -1; },
      },
    });
    (wasi as any).initialize(api_inst);
    wasm_api.set_instance(api_inst);
    if (DEBUG) wasm_api.enable_zig_debug();
    dbg("init", "api_instance created and set");
  } catch (e) {
    log("wasm", "error", `failed to init api instance: ${(e as Error).message}`);
    throw e;
  }

  // step 3: load ITAR index into api_instance + cache for per-compile instances
  send_status("Loading index...", "loading");
  const index_bytes = await index_bytes_promise;
  if (index_bytes) {
    cached_index_text = index_bytes;
    const ok = wasm_api.load_index(index_bytes);
    dbg("index", `pushed to WASM: ${ok ? "ok" : "failed"} (${format_size(index_bytes.byteLength)})`);
    if (!ok) log("init", "warn", "failed to parse index in WASM");
  }

  // step 4: get init file list from Zig comptime data
  const version = wasm_api.cache_version();
  dbg("cache", `version: ${version}`);

  const init_keys = wasm_api.query_seed_init();
  const init_total = init_keys.length;
  dbg("init", `seed init list: ${init_total} files from Zig`);

  // progress tracking
  let phase_loaded = 0;
  let phase_total = init_total;
  function seed_tick(_name: string): void {
    phase_loaded++;
    const clamped = Math.min(phase_loaded, phase_total);
    send_progress(Math.round((clamped / phase_total) * 100));
    send_status(`Seeding init cache ${clamped}/${phase_total}`, "loading");
  }

  // step 5: load init files from OPFS cache or network
  cached_files = new Map();
  const cache_hit = await opfs.load_init(version, init_keys, cached_files, seed_tick);

  if (!cache_hit) {
    phase_loaded = 0;
    phase_total = init_total;
    send_cache_status("downloading", "fetching init files...");
    await bundle.batch_fetch(init_keys, cached_files, 6, seed_tick);

    if (opfs.supported) {
      opfs.write_all(cached_files, version).catch((e: Error) => {
        dbg("cache", `background write failed: ${e.message}`);
      });
    }
  }

  // step 6: load xelatex.fmt from OPFS if available
  await opfs.load_format(cached_files);

  // step 7: generate format if not available
  if (!cached_files.has("xelatex.fmt")) {
    dbg("fmt", "no format file found, generating on first launch...");
    const fmt_keys = wasm_api.query_seed_format();
    const fmt_needed = fmt_keys.filter((f) => !cached_files!.has(f));
    if (fmt_needed.length > 0) {
      phase_loaded = 0;
      phase_total = fmt_needed.length;
      function fmt_tick(_name: string): void {
        phase_loaded++;
        const clamped = Math.min(phase_loaded, phase_total);
        send_progress(Math.round((clamped / phase_total) * 100));
        send_status(`Seeding format cache ${clamped}/${phase_total}`, "loading");
      }
      dbg("seed", `seeding ${fmt_needed.length}/${fmt_keys.length} format dependencies`);
      send_status(`Seeding format cache 0/${fmt_needed.length}`, "loading");
      const t0 = performance.now();
      await bundle.batch_fetch(fmt_needed, cached_files, 6, fmt_tick);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      dbg("seed", `format seed complete in ${elapsed}s`);
    } else if (fmt_keys.length > 0) {
      dbg("seed", `all ${fmt_keys.length} format files already cached`);
    }
    send_status("Generating format...", "loading");
    await generate_format();
  }

  const total_elapsed = ((performance.now() - t0_total) / 1000).toFixed(2);
  log(
    "init", "info",
    `ready in ${total_elapsed}s: ${cached_files.size} files, index ${wasm_api.is_index_loaded() ? "ok" : "missing"}${cache_hit ? " (cached)" : ""}`,
  );
  send_status("Ready", "success");
  send_progress(100);
  send_ready();
}

// -- resolve main file --

function resolve_main(user_files: ProjectFiles, main?: string): string {
  if (main) return main;
  const names = Object.keys(user_files);
  if (names.length === 1) return names[0];

  if (wasm_api.has_instance()) {
    const detected = wasm_api.detect_main(names);
    if (detected) return detected;
  }

  return names.find((n) => n === "input.tex" || n === "main.tex") || names[0];
}

// -- compile (single run, fetch-on-open) --

export async function compile(user_files: ProjectFiles, main?: string): Promise<void> {
  if (!wasm_module || !cached_files) {
    log("eztex", "error", "engine not ready");
    return;
  }

  const main_file = resolve_main(user_files, main);
  send_status("Compiling...", "loading");
  dbg("eztex", `compiling ${main_file} (${Object.keys(user_files).length} file(s))...`);

  const t0 = performance.now();

  try {
    const { exit_code, root_map, tmp_map, fetch_stats } = run_wasm(["eztex", "compile", main_file], user_files, true);

    // persist xelatex.fmt if generated during this run
    const fmt_inode = tmp_map.get("xelatex.fmt") as WasiFile | undefined;
    if (fmt_inode && fmt_inode.data && fmt_inode.data.byteLength > 0) {
      const fmt_copy = new Uint8Array(fmt_inode.data);
      cached_files.set("xelatex.fmt", fmt_copy);
      dbg("fmt", `generated xelatex.fmt (${format_size(fmt_copy.byteLength)}), caching to OPFS`);
      opfs.cache_file("xelatex.fmt", fmt_copy);
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    if (fetch_stats.fetches > 0) {
      dbg("fetch", `fetched ${fetch_stats.fetches} files on-demand (${format_size(fetch_stats.fetch_bytes)}), ${fetch_stats.cache_hits} cache hits`);
    }

    if (exit_code === 0) {
      const pdf_name = main_file.replace(/\.tex$/, ".pdf");
      log("eztex", "info", `compiled ${main_file} in ${elapsed}s`);
      send_status(`Done (${elapsed}s)`, "success");

      const pdf_inode = root_map.get(pdf_name) as WasiFile | undefined;
      if (pdf_inode && pdf_inode.data) {
        dbg("eztex", `output: ${pdf_name} (${format_size(pdf_inode.data.length)})`);
        send_complete(pdf_inode.data, elapsed);
      } else {
        log("eztex", "warn", `no PDF output found (expected ${pdf_name})`);
        send_status("No PDF output", "error");
        send_complete(null, elapsed);
      }
    } else {
      log("eztex", "error", `compilation failed (exit code ${exit_code}) in ${elapsed}s`);
      send_status(`Failed (${elapsed}s)`, "error");
      send_complete(null, elapsed);
    }
  } catch (e) {
    const err = e as Error;
    log("eztex", "error", err.message);
    if (err.stack) send_log(err.stack, "log-error");
    send_status("Error", "error");
    send_complete(null, "0");
  }
}

// -- clear cache --

export async function clear_cache(): Promise<void> {
  await opfs.clear();
}
