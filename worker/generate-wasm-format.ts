// generate-wasm-format.ts -- generate xelatex.fmt using the WASM engine under Bun.
// this ensures the format is 100% compatible with the WASM build.
//
// usage:
//   cd worker
//   bun run generate-wasm-format.ts
//
// The script:
// 1. Loads the WASM module from ../zig-out/bin/eztex.wasm
// 2. Queries the seed file list from Zig exports
// 3. Fetches the ITAR bundle index
// 4. Pre-fetches all seed files via HTTP Range
// 5. Creates a WASI filesystem with the seed files
// 6. Runs 'eztex generate-format' in WASM
// 7. Extracts tmp/xelatex.fmt and writes to assets/
// 8. Prints the upload command

import path from "path";
import {
  WASI,
  File as WasiFile,
  Directory,
  PreopenDirectory,
  OpenFile,
  ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";

const BUNDLE_URL = "https://eztex.thuvasooriya.me/bundle";
const INDEX_URL = "https://eztex.thuvasooriya.me/index.gz";
const WASM_PATH = "../zig-out/bin/eztex.wasm";
const ASSETS_DIR = "assets";

const defaultOutputPath = path.join(ASSETS_DIR, "xelatex_v33_wasm32-wasi_c1607948053fc5d4.fmt");
const outputPath = process.argv[2] ?? defaultOutputPath;

// -- load wasm --
console.log("loading WASM module...");
const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
const wasmModule = await WebAssembly.compile(wasmBytes);

// -- create minimal api_instance to query seed lists --
const apiFds = [
  new OpenFile(new WasiFile(new Uint8Array())),
  ConsoleStdout.lineBuffered(() => {}),
  ConsoleStdout.lineBuffered(() => {}),
];
const apiWasi = new WASI([], [], apiFds);
const apiInstance = new WebAssembly.Instance(wasmModule, {
  wasi_snapshot_preview1: apiWasi.wasiImport,
  env: {
    dup() {
      return -1;
    },
    js_request_range() {
      return -1;
    },
    js_request_index() {
      return -1;
    },
  },
});
apiWasi.initialize(apiInstance);

const exports = apiInstance.exports as unknown as {
  memory: WebAssembly.Memory;
  eztex_alloc(size: number): number;
  eztex_free(ptr: number, size: number): void;
  eztex_query_seed_init(out_ptr: number, out_cap: number): number;
  eztex_query_seed_format(out_ptr: number, out_cap: number): number;
  eztex_query_bundle_url(out_ptr: number, out_cap: number): number;
};

function readExportString(getter: (out_ptr: number, out_cap: number) => number): string {
  const cap = 32768;
  const ptr = exports.eztex_alloc(cap);
  const n = getter(ptr, cap);
  const mem = new Uint8Array(exports.memory.buffer);
  const s = new TextDecoder().decode(mem.subarray(ptr, ptr + n));
  exports.eztex_free(ptr, cap);
  return s;
}

const initSeeds = readExportString((p, c) => exports.eztex_query_seed_init(p, c))
  .split("\n")
  .filter((s) => s.length > 0);
const formatSeeds = readExportString((p, c) => exports.eztex_query_seed_format(p, c))
  .split("\n")
  .filter((s) => s.length > 0);

console.log(`init seeds: ${initSeeds.length} files`);
console.log(`format seeds: ${formatSeeds.length} files`);

// -- fetch and decompress ITAR index --
console.log("fetching bundle index...");
const indexResp = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30000) });
if (!indexResp.ok) throw new Error(`index fetch failed: HTTP ${indexResp.status}`);
const compressed = new Uint8Array(await indexResp.arrayBuffer());
console.log(`index downloaded (${compressed.length} bytes compressed)`);

const ds = new DecompressionStream("gzip");
const writer = ds.writable.getWriter();
writer.write(compressed);
writer.close();
const decompressed = await new Response(ds.readable).arrayBuffer();
const indexText = new TextDecoder().decode(decompressed);
console.log(`index decompressed (${indexText.length} bytes)`);

// parse index into Map<name, {offset, length}>
const index = new Map<string, { offset: number; length: number }>();
for (const line of indexText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("SVNREV") || trimmed.startsWith("GITHASH")) continue;
  const parts = trimmed.split(" ");
  if (parts.length < 3) continue;
  const name = parts[0].toLowerCase();
  const offset = parseInt(parts[1], 10);
  const length = parseInt(parts[2], 10);
  if (!isNaN(offset) && !isNaN(length)) {
    index.set(name, { offset, length });
  }
}
console.log(`index entries: ${index.size}`);

// -- pre-fetch seed files --
const allSeeds = [...new Set([...initSeeds, ...formatSeeds])];
const cachedFiles = new Map<string, Uint8Array>();

console.log(`pre-fetching ${allSeeds.length} seed files...`);
let fetched = 0;
let failed = 0;

for (const name of allSeeds) {
  const entry = index.get(name.toLowerCase());
  if (!entry) {
    failed++;
    continue;
  }

  const rangeEnd = entry.offset + entry.length - 1;
  try {
    const resp = await fetch(BUNDLE_URL, {
      headers: { Range: `bytes=${entry.offset}-${rangeEnd}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      failed++;
      continue;
    }
    const data = new Uint8Array(await resp.arrayBuffer());
    cachedFiles.set(name, data);
    fetched++;
  } catch {
    failed++;
  }
}

console.log(`fetched ${fetched} files, ${failed} failed`);

// -- build WASI filesystem --
const rootMap = new Map<string, WasiFile | Directory>();
const fontsMap = new Map<string, WasiFile | Directory>();
const tmpMap = new Map<string, WasiFile | Directory>();

function ensureDir(parent: Map<string, WasiFile | Directory>, name: string): Map<string, WasiFile | Directory> {
  const existing = parent.get(name);
  if (existing instanceof Directory) return existing.contents;
  const dir = new Map<string, WasiFile | Directory>();
  parent.set(name, new Directory(dir));
  return dir;
}

function placeFile(root: Map<string, WasiFile | Directory>, filePath: string, data: Uint8Array) {
  const parts = filePath.split("/");
  if (parts.length === 1) {
    root.set(filePath, new WasiFile(data));
    return;
  }
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = ensureDir(current, parts[i]);
  }
  current.set(parts[parts.length - 1], new WasiFile(data));
}

for (const [name, data] of cachedFiles) {
  if (name.startsWith("fonts/")) {
    fontsMap.set(name.slice(6), new WasiFile(new Uint8Array(data)));
  } else {
    placeFile(rootMap, name, new Uint8Array(data));
  }
}

rootMap.set("fonts", new Directory(fontsMap));
rootMap.set("tmp", new Directory(tmpMap));

console.log(`WASI filesystem: ${cachedFiles.size} files + fonts dir`);

// -- run generate-format in WASM --
console.log("running WASM generate-format...");
const runFds = [
  new OpenFile(new WasiFile(new Uint8Array())),
  ConsoleStdout.lineBuffered((line: string) => console.log("[stdout]", line)),
  ConsoleStdout.lineBuffered((line: string) => console.log("[stderr]", line)),
  new PreopenDirectory(".", rootMap),
];
const runWasi = new WASI(["eztex", "generate-format"], [], runFds);

const runInstance = new WebAssembly.Instance(wasmModule, {
  wasi_snapshot_preview1: runWasi.wasiImport,
  env: {
    dup() {
      return -1;
    },
    js_request_range() {
      return -1;
    },
    js_request_index() {
      return -1;
    },
  },
});

let exitCode: number;
try {
  exitCode = runWasi.start(runInstance);
} catch (e: any) {
  if (e.exit_code !== undefined) {
    exitCode = e.exit_code;
  } else {
    console.error("WASM runtime error:", e.message);
    exitCode = 1;
  }
}

console.log(`WASM exit code: ${exitCode}`);

// -- extract format --
const fmtFile = tmpMap.get("xelatex.fmt") ?? tmpMap.get("_make_xelatex_fmt.fmt");
if (!fmtFile || !(fmtFile instanceof WasiFile) || !fmtFile.data || fmtFile.data.byteLength === 0) {
  console.error("ERROR: no format file found in tmp/");
  process.exit(1);
}

const fmtBytes = new Uint8Array(fmtFile.data);
console.log(`format generated: ${fmtBytes.length} bytes`);

// validate header
const magic = new TextDecoder().decode(fmtBytes.slice(0, 4));
const serial = new DataView(fmtBytes.buffer, fmtBytes.byteOffset, fmtBytes.byteLength).getUint32(4, false);
console.log(`format magic: "${magic}", serial: ${serial}`);

if (magic !== "TTNC" || serial !== 33) {
  console.error("ERROR: format validation failed");
  process.exit(1);
}

await Bun.write(outputPath, fmtBytes);
console.log(`written to ${outputPath}`);

console.log("\n--- Next steps ---");
console.log("Upload to R2:");
console.log(`  bun run upload-format`);
console.log("\nOr manually:");
const objectKey = `formats/${path.basename(outputPath)}`;
console.log(`  bun run upload ${outputPath} ${objectKey}`);
console.log("\nRedeploy worker (only needed if you changed index.js or wrangler.toml):");
console.log("  bun run deploy");
