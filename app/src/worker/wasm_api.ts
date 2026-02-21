// thin wrappers around eztex WASM API exports
// the api_instance is a persistent WASM instance used for index queries,
// cache management, and file list retrieval (separate from per-compile instances)

import { send_log, dbg } from "./protocol.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EztexExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  eztex_alloc(size: number): number;
  eztex_free(ptr: number, size: number): void;
  eztex_set_debug(enabled: number): void;
  eztex_push_index(ptr: number, len: number): number;
  eztex_query_cache_version(out_ptr: number, out_cap: number): number;
  eztex_query_bundle_url(out_ptr: number, out_cap: number): number;
  eztex_query_index_url(out_ptr: number, out_cap: number): number;
  eztex_query_main_file(list_ptr: number, list_len: number, out_ptr: number, out_cap: number): number;
  eztex_query_seed_init(out_ptr: number, out_cap: number): number;
  eztex_query_seed_format(out_ptr: number, out_cap: number): number;
  eztex_query_index(name_ptr: number, name_len: number, out_offset: number, out_length: number): number;
}

let api_instance: WebAssembly.Instance | null = null;
let _cache_version: string | null = null;
let index_loaded = false;

function inst(): EztexExports {
  if (!api_instance) throw new Error("api_instance not initialized");
  return api_instance.exports as unknown as EztexExports;
}

function alloc(size: number): number {
  const ptr = inst().eztex_alloc(size);
  if (!ptr) throw new Error(`eztex_alloc failed (${size} bytes)`);
  return ptr;
}

function dealloc(ptr: number, size: number): void {
  inst().eztex_free(ptr, size);
}

export function set_instance(instance: WebAssembly.Instance): void {
  api_instance = instance;
  dbg("wasm_api", `set_instance: exports=${Object.keys(instance.exports).join(",")}`);
}

export function has_instance(): boolean {
  return api_instance !== null;
}

// enable Zig-side debug logging (calls eztex_set_debug on the api_instance)
export function enable_zig_debug(): void {
  if (!api_instance) return;
  try {
    inst().eztex_set_debug(1);
    dbg("wasm_api", "Zig debug logging enabled");
  } catch {
    dbg("wasm_api", "eztex_set_debug not available (old binary?)");
  }
}

export function is_index_loaded(): boolean {
  return index_loaded;
}

export function load_index(decompressed: Uint8Array): boolean {
  dbg("wasm_api", `load_index: ${decompressed.byteLength} bytes`);
  const ptr = alloc(decompressed.byteLength);
  const mem = new Uint8Array(inst().memory.buffer);
  mem.set(decompressed, ptr);
  const rc = inst().eztex_push_index(ptr, decompressed.byteLength);
  dealloc(ptr, decompressed.byteLength);
  index_loaded = rc === 0;
  dbg("wasm_api", `load_index: rc=${rc}, loaded=${index_loaded}`);
  return index_loaded;
}

export function cache_version(): string {
  if (_cache_version) return _cache_version;
  dbg("wasm_api", "cache_version: calling eztex_query_cache_version");
  const out_cap = 64;
  const out_ptr = alloc(out_cap);
  const n = inst().eztex_query_cache_version(out_ptr, out_cap);
  const mem = new Uint8Array(inst().memory.buffer);
  const s = decoder.decode(mem.subarray(out_ptr, out_ptr + n));
  dealloc(out_ptr, out_cap);
  _cache_version = s;
  dbg("wasm_api", `cache_version: "${s}"`);
  return s;
}

let _bundle_url: string | null = null;

export function bundle_url(): string {
  if (_bundle_url) return _bundle_url;
  dbg("wasm_api", "bundle_url: calling eztex_query_bundle_url");
  const out_cap = 512;
  const out_ptr = alloc(out_cap);
  const n = inst().eztex_query_bundle_url(out_ptr, out_cap);
  const mem = new Uint8Array(inst().memory.buffer);
  const s = decoder.decode(mem.subarray(out_ptr, out_ptr + n));
  dealloc(out_ptr, out_cap);
  _bundle_url = s;
  dbg("wasm_api", `bundle_url: "${s}"`);
  return s;
}

let _index_url: string | null = null;

export function index_url(): string {
  if (_index_url) return _index_url;
  dbg("wasm_api", "index_url: calling eztex_query_index_url");
  const out_cap = 512;
  const out_ptr = alloc(out_cap);
  const n = inst().eztex_query_index_url(out_ptr, out_cap);
  const mem = new Uint8Array(inst().memory.buffer);
  const s = decoder.decode(mem.subarray(out_ptr, out_ptr + n));
  dealloc(out_ptr, out_cap);
  _index_url = s;
  dbg("wasm_api", `index_url: "${s}"`);
  return s;
}

export function detect_main(filenames: string[]): string | null {
  if (!api_instance) return null;
  const list_str = filenames.join("\n");
  const list_bytes = encoder.encode(list_str);
  const list_ptr = alloc(list_bytes.byteLength);
  const out_cap = 1024;
  const out_ptr = alloc(out_cap);

  const mem = new Uint8Array(inst().memory.buffer);
  mem.set(list_bytes, list_ptr);

  const n = inst().eztex_query_main_file(list_ptr, list_bytes.byteLength, out_ptr, out_cap);
  const detected = n > 0 ? decoder.decode(mem.subarray(out_ptr, out_ptr + n)) : null;

  dealloc(list_ptr, list_bytes.byteLength);
  dealloc(out_ptr, out_cap);

  if (detected) {
    send_log(`[project] detected main file: ${detected}`);
  }
  return detected;
}

// -- file list exports (comptime data from Zig) --

function read_newline_list(getter: (out_ptr: number, out_cap: number) => number, cap: number = 32768): string[] {
  const ptr = alloc(cap);
  const n = getter(ptr, cap);
  const mem = new Uint8Array(inst().memory.buffer);
  const text = decoder.decode(mem.subarray(ptr, ptr + n));
  dealloc(ptr, cap);
  return text.split("\n").filter((s) => s.length > 0);
}

export function query_seed_init(): string[] {
  dbg("wasm_api", "query_seed_init: calling eztex_query_seed_init");
  const result = read_newline_list((p, c) => inst().eztex_query_seed_init(p, c));
  dbg("wasm_api", `query_seed_init: ${result.length} files`);
  return result;
}

export function query_seed_format(): string[] {
  dbg("wasm_api", "query_seed_format: calling eztex_query_seed_format");
  const result = read_newline_list((p, c) => inst().eztex_query_seed_format(p, c));
  dbg("wasm_api", `query_seed_format: ${result.length} files`);
  return result;
}

// -- index lookup: resolve a filename to (offset, length) via Zig ITAR index --

export interface IndexEntry {
  offset: bigint;
  length: number;
}

export function index_lookup(name: string): IndexEntry | null {
  if (!index_loaded) return null;
  dbg("wasm_api", `index_lookup: "${name}"`);
  const name_bytes = encoder.encode(name);
  const name_ptr = alloc(name_bytes.byteLength);
  const mem = new Uint8Array(inst().memory.buffer);
  mem.set(name_bytes, name_ptr);

  // out_offset is u64 (8 bytes), out_length is u32 (4 bytes)
  const out_offset_ptr = alloc(8);
  const out_length_ptr = alloc(4);

  const rc = inst().eztex_query_index(name_ptr, name_bytes.byteLength, out_offset_ptr, out_length_ptr);

  let result: IndexEntry | null = null;
  if (rc === 0) {
    const view = new DataView(inst().memory.buffer);
    const offset = view.getBigUint64(out_offset_ptr, true);
    const length = view.getUint32(out_length_ptr, true);
    result = { offset, length };
  }

  dealloc(name_ptr, name_bytes.byteLength);
  dealloc(out_offset_ptr, 8);
  dealloc(out_length_ptr, 4);

  return result;
}
