# eztex Optimization & Modernization Plan

## Executive Summary

This document captures the comprehensive research and audit findings for optimizing and modernizing the eztex engine. It serves as the roadmap for architectural improvements, performance optimizations, and design modernization.

**Key Insight**: The biggest wins are architectural, not algorithmic. The C engine's global-state design prevents true incremental compilation and safe concurrency. The practical frontier is "smart full recompilation" with better caching, not general incremental TeX.

---

## 1. Research Findings: Incremental Compilation Landscape

### State of the Art

| Project | Approach | True Incremental? | Notes |
|---------|----------|-------------------|-------|
| **TeXpresso** | Custom XeTeX + incremental driver | **YES** | Research project, requires deep engine work |
| **MiTeX/Typst** | Incremental compiler server | **YES** | Different architecture (not TeX) |
| **Tectonic** | Smart full + format/bundle cache | NO | Best practical reference for orchestration |
| **Overleaf** | Smart full + preserved intermediates | NO | Most relevant product model for eztex |
| **SwiftLaTeX** | Fast full + warm worker | NO | Heap snapshot restore, on-demand fetch |
| **BusyTeX** | Smart full + persistent module | NO | Pass skipping, package planning |
| **eztex (current)** | Full compile + format/bundle cache | NO | Room for significant improvement |

### Fundamental Limits

TeX is inherently global-state-based. Small edits can cascade:
- Macro expansion changes
- Counter/page number changes
- Float placement shifts
- Line breaks far downstream
- Cross-reference ripple effects

**What IS safely cacheable:**
- Format files (.fmt)
- Support files/packages (bundle)
- Font files
- Project intermediates (.aux, .bbl, .toc, .out)
- Decompressed bundle indexes

**What is NOT safely reusable without deep engine work:**
- Post-compile engine state
- Arbitrary page objects
- Differential PDF patching

---

## 2. Completed Optimizations (This Round)

### P0: BibTeX Correctness
- [x] Fixed silent failure on BibTeX error (now stops compile, surfaces error)
- [x] `.blg` log file preserved on failure for debugging
- [x] Multi-aux scanning: recursively scans `\@input` directives
- [x] Biblatex detection: emits clear error for `\abx@aux@` documents

### P0: Project Intermediate Persistence
- [x] 11 file types persisted across compiles: `.aux`, `.bbl`, `.blg`, `.toc`, `.out`, `.nav`, `.snm`, `.lof`, `.lot`, `.vrb`, `.synctex.gz`
- [x] OPFS storage under `eztex-cache/projects/<id>/intermediates/`
- [x] Restoration before compile, persistence after compile
- [x] Graceful handling of missing/corrupt entries

### P0: Preview vs Full Compile Modes
- [x] `CompileMode` enum: `preview` (fast) vs `full` (complete)
- [x] Preview caps at 2 passes, skips BibTeX if inputs unchanged
- [x] `.bibstate` tracking for bibliography invalidation
- [x] UI integration: auto-compile = preview, explicit compile = full

### P1: Broadened Rerun Detection
- [x] Stabilization set: `.aux` (primary) + `.toc`, `.out`, `.nav`, `.snm`, `.lof`, `.lot`, `.vrb`
- [x] Compile stops only when ALL present files converge
- [x] File appearance/disappearance counts as change

---

## 3. Critical Findings: Format File Strategy

### Current State

**Bundle contents**: The ITAR bundle contains TeX source files only. No precompiled `.fmt` files are included. The bundle index maps filenames to tar offsets for on-demand fetching.

**Format generation flow**:
1. Worker loads bundle index (~1-2MB decompressed)
2. Seeds ~80-100 TeX files for format generation (e.g., `xelatex.ini`, `latex.ltx`, font definitions)
3. Runs `initex` (XeTeX in initialization mode) for 10-30 seconds
4. Produces `xelatex.fmt` (~2-5MB)
5. Caches in OPFS for subsequent compiles

**Problem**: First-time user experience is poor. 10-30s of CPU-intensive work before any document can compile.

### Recommendation: Download Precompiled Formats

**Strategy**: Generate formats server-side during bundle creation, host alongside bundle, download on first run.

**Why this is optimal**:
1. **First-time UX**: 5-10s total (download + compile) vs 30-45s (generate + compile)
2. **Bundle already requires network**: Adding ~3MB format download is negligible vs ~300MB bundle
3. **Server can optimize**: Better CPU, can precompute multiple format variants
4. **Predictable experience**: No variability in format generation time
5. **Robust fallback**: JIT generation still works if download fails

**Format Key**: `{bundle_digest}_{engine_serial}_{format_type}_{target}.fmt`

Example: `xelatex_v33_abc123def456_wasm32-wasi.fmt`

**Validation**: Load format, check `FORMAT_SERIAL` embedded in header matches engine's expected serial. Reject on mismatch with clear error.

### Hosting Options

| Option | Pros | Cons |
|--------|------|------|
| **Separate format server** | Clean separation, can update independently | Extra infrastructure |
| **Bundle subdirectory** | Simple, versioned with bundle | Requires bundle restructure |
| **Same server, different path** | Easy to implement, share CDN | Slightly more complex URL |

**Recommended**: Option 3 - host at `{bundle_base_url}/formats/xelatex_v33_{digest}.fmt`

Example: `https://eztex.thuvasooriya.me/formats/xelatex_v33_abc123.fmt`

---

## 4. Worker Architecture Analysis

### Current Worker Flow

```
init()
  -> compile WASM module
  -> fetch + decompress ITAR index
  -> load init files (or fetch from network)
  -> load format from OPFS (or generate via initex)
  -> READY

compile(files)
  -> build WASI filesystem (cached + restored + user files)
  -> run WASM with compile command
  -> collect outputs (PDF, synctex, intermediates)
  -> persist intermediates
  -> done
```

### Identified Bottlenecks

1. **WASI FS rebuild** (line 170-179): Copies ALL cached files into new filesystem every compile
   - As cache grows, this scales linearly
   - Solution: Lazy-mount or reference-count cached files

2. **Index double-parsing**: WASM API parses index, JS also needs index for `query_seed`
   - Solution: Precompute compact binary index or share parsed data

3. **Output flush per call** (`Engine.zig:257-260`): `ttbc_output_write` creates writer and flushes every call
   - Solution: Persistent output buffering in `OutputSlot`

4. **File slurping** (`World.zig:119-139`): Every file-backed input copied to memory on first read
   - Solution: True streaming file slots with position tracking

5. **WASM instance recreation**: Fresh instance per compile (not per init)
   - Actually: Instance is reused, but filesystem is rebuilt
   - Solution: Keep filesystem alive between compiles, patch changes

6. **Format generation** (if no cached format): 10-30s CPU-bound work
   - Solution: Download precompiled format (see section 3)

### Worker Optimization Priority

| Rank | Optimization | Impact | Effort |
|------|-------------|--------|--------|
| 1 | Download precompiled formats | Very High | Medium |
| 2 | Lazy-mount cached files in WASI FS | High | Medium |
| 3 | Persistent output buffering | High | Medium |
| 4 | Streaming file I/O (no slurp) | High | Medium |
| 5 | Reuse parsed index between JS/WASM | Medium | Low |
| 6 | Memory snapshot after format load | Medium | Medium |

---

## 5. Modernization Roadmap

### P0: Critical (Next Sprint)

#### 5.1 Runtime Allocator Strategy
**Problem**: `std.heap.c_allocator` used throughout hot code. Prevents leak detection, inconsistent in WASM.

**Solution**: Pass allocator through `Runtime`.

```zig
const Runtime = struct {
    allocator: std.mem.Allocator,
    io: Io,
    world: World,
    bundle_store: BundleStore,
    // ...
};
```

**Rules**:
- `c_allocator`: Only where C ABI requires `malloc/free` compatibility
- `DebugAllocator` (nee GPA): Debug/test builds for leak detection
- `ArenaAllocator`: Per-compile temporary data (aux snapshots, paths, diagnostics)
- `wasm_allocator`: WASM production allocations where code size matters
- Fixed stack buffers: Bounded paths, small temporary formatting (already done well)

**Hot spots to fix**:
- `src/Compiler.zig:173` (engine always gets c_allocator)
- `src/World.zig:97-139` (file slurp buffers)
- `src/Engine.zig:141-169` (diagnostics allocate)
- `src/Layout.zig:212,239,423` (layout hash maps)

#### 5.2 Precompiled Format Download
**Implementation**:
1. Add format URL builder: `{bundle_url}/formats/xelatex_v{serial}_{digest}.fmt`
2. Worker tries OPFS first, then network download, then JIT generation
3. Validate `FORMAT_SERIAL` before loading
4. Cache downloaded format in OPFS

#### 5.3 Streaming File I/O
**Problem**: `World.InputSlot.read()` lazy-loads entire file into memory.

**Solution**: Keep file-backed slots file-backed. Track position. Only load memory for sources that need slices.

**WASM caveat**: `browser_wasi_shim` files are already memory-backed, but copying into Zig heap is still wasteful.

#### 5.4 Output Buffering
**Problem**: `ttbc_output_putc/write` flush on every call.

**Solution**: Add 64KB buffer to `OutputSlot`, flush on close or overflow.

```zig
pub const OutputSlot = struct {
    file: Io.File,
    buffer: [64 * 1024]u8 = undefined,
    buffered_len: usize = 0,
    // ...
};
```

### P1: Important (Next Month)

#### 5.5 Native Range Merging
**Problem**: Native fetches one range per file. JS already has `merge_ranges` for batching.

**Solution**: Port JS range merging logic to `BundleStore.zig` native seed cache.

#### 5.6 Compact Binary Bundle Index
**Problem**: `StringHashMap` with one allocation per name. Duplicated between JS and WASM.

**Solution**: Flat string table + sorted offsets. Or interned arena. Reduces memory and parse time.

#### 5.7 Move `g_format_bytes` into `Runtime`
**Problem**: Global format memory prevents multiple runtimes.

**Solution**: Store in `Runtime`, pass through `EngineConfig`.

#### 5.8 Stream MD5 Hashing
**Problem**: `ttbc_get_file_md5` allocates up to 16MB (`allocRemaining`).

**Solution**: Stream hash with fixed buffer.

```zig
var hasher = Md5.init(.{});
var buf: [16 * 1024]u8 = undefined;
while (true) {
    const n = slot.read(io, &buf) catch return 1;
    if (n == 0) break;
    hasher.update(buf[0..n]);
}
hasher.final(digest[0..16]);
```

#### 5.9 Explicit Error Sets
**Problem**: `anyerror!` in `EngineInterface.zig` vtable prevents useful handling.

**Solution**: Define `EngineError` set.

```zig
pub const EngineError = error{
    PrimaryInputNotSet,
    PathTooLong,
    EngineVariableRejected,
    UnsupportedVariableValue,
    EngineStartFailed,
    BibtexFailed,
    FormatCacheCorrupt,
    OutOfMemory,
};
```

### P2: Medium Priority

#### 5.10 Feature Flags for Optional Components
Add build options to disable rarely-used features for WASM size:
- Graphite2 (rarely needed)
- Synctex (optional)
- BibTeX C engine (if we move to Rust or external)
- Individual image formats

#### 5.11 Contextize `Layout.zig` Globals
**Problem**: `Layout.zig` has module-level FreeType/HarfBuzz/Graphite state.

**Solution**: Move into explicit context struct before any parallel font work.

#### 5.12 Hashed Immutable WASM Caching
**Problem**: `fetch("/eztex.wasm", { cache: "no-cache" })` bypasses browser cache.

**Solution**: Use content-hashed URL: `/eztex.<hash>.wasm` with immutable cache headers.

### P3: Future Research

#### 5.13 Zig Async for Native Prefetch
Experimental. Use only for bundle prefetch, not engine hot path.

#### 5.14 WASM Heap Snapshots
After format load, capture memory snapshot. Restore before each compile. SwiftLaTeX does this.

#### 5.15 Split XeTeX/xdvipdfmx Modules
High complexity. Consider only if preview mode can skip PDF generation.

---

## 6. Concurrency and Async Assessment

### What We CAN Do

| Area | Approach | Feasibility |
|------|----------|-------------|
| Bundle prefetch | JS async fetch + batching | High (already doing) |
| Native seed cache | Range merging + thread pool | Medium |
| Browser workers | Independent compile workers | High |
| Font loading (future) | Parallel after contextizing | Medium |
| Viewer prefetch | Keep old PDF visible until new arrives | High |

### What We CANNOT Do

| Area | Why Not |
|------|---------|
| Parallel XeTeX passes | TeX semantics require sequential execution |
| Zig async inside engine | C bridge expects synchronous I/O |
| WASM threads | Requires shared memory + COOP/COEP headers |
| Reuse post-compile engine state | C globals are not thread-safe, cleanup fragile |

### Recommendation

**Do NOT use Zig async or WASM threading inside the engine.** Apply concurrency around the engine: bundle fetching, cache preparation, browser worker orchestration. The C engine's global state is the fundamental blocker.

---

## 7. Implementation Priority Matrix

| Optimization | Effort | Impact | Risk | Priority |
|-------------|--------|--------|------|----------|
| Precompiled format download | M | Very High | Low | **P0** |
| Runtime allocator strategy | M | High | Low | **P0** |
| Streaming file I/O | M | High | Medium | **P0** |
| Output buffering | M | High | Low | **P0** |
| Lazy-mount cached files | M | High | Medium | **P0** |
| Native range merging | M | Medium | Low | **P1** |
| Compact binary index | L | Medium | Medium | **P1** |
| Move format memory to Runtime | S/M | Medium | Low | **P1** |
| Stream MD5 hashing | S | Medium | Low | **P1** |
| Explicit error sets | S/M | Medium | Low | **P1** |
| Feature flags (Graphite2, etc.) | M | Medium | Medium | **P2** |
| Contextize Layout globals | L | Medium | Medium | **P2** |
| Hashed WASM caching | S | Medium | Low | **P2** |
| WASM heap snapshots | L | High | Medium | **P2** |
| Split XeTeX/xdvipdfmx | L | Low | High | **P3** |
| Zig async prefetch | M | Low | High | **P3** |

---

## 8. Design Principles

### Modern Zig Patterns to Adopt

1. **Allocator passing**: Every function that allocates takes `allocator` parameter
2. **Error sets**: Define concrete error types, not `anyerror!`
3. **Optionals over sentinels**: Use `?T` instead of `null` pointer checks where possible
4. **Stack allocation**: Use fixed buffers for bounded operations (already good)
5. **Comptime configuration**: Use feature flags for WASM vs native, debug vs release
6. **Extern struct for C ABI**: Use `extern struct`, NOT `packed struct` (pointer rules tightened)

### Patterns to Avoid

1. `std.heap.GeneralPurposeAllocator` (deprecated name, use `DebugAllocator`)
2. `std.event.Loop` (modern Zig uses `std.Io`)
3. `std.Thread.Pool` (removed in current Zig)
4. `packed struct` with pointers (undefined behavior risk)
5. `anyerror!` in public interfaces
6. `catch unreachable` (none found currently, keep it that way)

### C ABI Best Practices

1. Keep C longjmp/SJLJ contained inside C engine
2. Bridge callbacks return C-compatible sentinel values
3. Store richer error in `Runtime` state
4. Convert to Zig errors after C call returns
5. WASM exception handling flags are compatibility necessity, not design choice

---

## 9. Bundle Index and Format File Hosting

### Current Bundle Format

- **Format**: ITAR (Indexed TAR) - text index mapping filenames to tar offsets + lengths
- **Index size**: ~1-2MB decompressed
- **Bundle size**: ~300MB tar file
- **Contents**: TeX source files, fonts, packages (NO precompiled formats)

### Recommended Format Hosting

**Directory structure on server**:
```
https://eztex.thuvasooriya.me/
├── bundle                    (300MB tar)
├── index.gz                  (1MB compressed index)
└── formats/
    ├── xelatex_v33_abc123.wasm32-wasi.fmt    (~3MB)
    ├── xelatex_v33_abc123.x86_64-linux.fmt   (~3MB)
    ├── plain_v33_abc123.wasm32-wasi.fmt      (~2MB)
    └── ...
```

**Naming convention**: `{format_name}_v{FORMAT_SERIAL}_{bundle_digest_prefix}.{target}.fmt`

**Generation**: During bundle build CI/CD, run initex for each supported target, upload format files.

**Client logic**:
1. Check OPFS for cached format matching current bundle + engine
2. If not found, try downloading from `{bundle_url}/formats/...`
3. If download fails or serial mismatches, fall back to JIT generation
4. Cache downloaded/generated format in OPFS

---

## 10. Testing Strategy

### New Tests to Add

1. **Format download test**: Verify format download + validation works
2. **Format fallback test**: Verify JIT generation works when download fails
3. **Streaming I/O test**: Verify large files can be processed without slurping
4. **Output buffering test**: Verify buffered output produces correct results
5. **Allocator leak test**: Use `DebugAllocator` to detect leaks in compile loop
6. **Multi-aux test**: Verify BibTeX triggers on included aux files
7. **Preview mode test**: Verify faster compile with acceptable output

### Benchmarks

1. **First compile time**: With and without precompiled format
2. **Iterative compile time**: With and without intermediate persistence
3. **Memory peak**: During compile, especially WASM
4. **WASI FS build time**: Scale with cache size
5. **Bundle fetch latency**: Sequential vs. batched vs. range-merged

---

## 11. Metrics and Monitoring

### Key Metrics to Track

| Metric | Target | Measurement |
|--------|--------|-------------|
| First compile time | < 10s | From fresh start to PDF |
| Iterative compile (preview) | < 3s | With intermediates + preview mode |
| Format generation time | < 15s | Fallback path |
| WASM binary size | < 4MB | ReleaseSmall build |
| Memory peak (WASM) | < 128MB | During compile |
| Cache hit rate | > 90% | Bundle file requests |

---

## 12. Appendix: Reference Projects

### SwiftLaTeX
- Warm WASM worker with heap snapshot restore
- On-demand package/font fetch with in-worker cache
- Format generation support
- Separate xetex + dvipdfmx workers

### BusyTeX
- Single static WASM binary with multiple tools
- Persistent compiled module
- Fixed command pipelines with pass skipping
- WASM heap reset between commands

### Tectonic
- Content-addressed format cache
- Smart rerun detection (files read-then-rewritten)
- Bundle cache by digest
- In-memory intermediates by default

### Overleaf
- Incremental project sync (not incremental TeX)
- Preserved helper files between compiles
- Fast draft mode
- PDF viewer optimized for partial page loading

---

## 13. Collaboration Architecture (NEW)

### 13.1 Executive Summary

**Decision**: Build real-time multiplayer collaboration into extex using Yjs CRDT with WebSocket transport via Cloudflare Durable Objects. Target a "Zed-lite" product feel: Zed is inspiration for CRDT-first collaboration and shared project presence, not a direct architecture to copy. extex will use a simpler browser-native, static-site-compatible design.

**Key Design Principles**:
1. **CRDT is always the source of truth** - Solo editing is just collaboration with one peer
2. **WebSocket-only transport for v1** - Skip WebRTC complexity, add later if needed
3. **Multi-project workspace** - Users can switch between LaTeX projects
4. **Agent-native design** - First-class support for LLM agents as collaboration peers first, MCP sidecar later
5. **Static site compatible** - Frontend deploys to Cloudflare Pages, backend is Worker/DO

### 13.2 CRDT Selection Analysis

#### Options Evaluated

| Library | Bundle Size | CM6 Binding | Awareness | Maturity | Verdict |
|---------|-------------|-------------|-----------|----------|---------|
| **Yjs** | ~25KB gzipped (core + binding + protocols) | Official (`y-codemirror.next`) | Built-in | 7+ years | **Use this** |
| Automerge | ~800KB WASM | Community | Manual | Solid | Too heavy |
| Diamond Types | ~200KB WASM | None | None | Experimental | Too early |
| Custom (Zed-style) | N/A | Build from scratch | Build from scratch | N/A | Months of work |

**Why Yjs is correct for extex**:
- Proven in production (Notion, Jupyter, Figma plugins, JupyterLab)
- `y-codemirror.next` provides drop-in CodeMirror 6 integration
- Handles LaTeX documents (flat text) perfectly
- Garbage collection handles long editing sessions (but see compaction below)
- Total added: ~25KB gzipped vs 15MB tectonic WASM (0.17% increase)

#### Yjs State Compaction

**Warning**: Yjs update logs grow monotonically. Long sessions or high-edit documents can accumulate significant metadata.

**Mitigation**:
- Periodic compaction: `Y.encodeStateAsUpdate(doc)` produces a full state snapshot
- Replace update log with snapshot every N minutes or M updates
- Client-side: trigger compaction before save to OPFS
- Server-side (DO): store compacted state, not full operation log

#### Dependencies to Add

```json
{
  "yjs": "^13.6",
  "y-codemirror.next": "^0.3",
  "y-protocols": "^1.0",
  "y-indexeddb": "^9.0",
  "lib0": "^0.2"
}
```

### 13.3 Transport Architecture

#### Decision: WebSocket-Only (No WebRTC for v1)

| Approach | Complexity | Reliability | Latency | Verdict |
|----------|------------|-------------|---------|---------|
| WebRTC + WebSocket Fallback | High | Medium (NAT issues) | 10-30ms P2P | Over-engineered |
| **WebSocket DO Room Authority** | Medium | Very High | 30-100ms | **Use this** |

**Rationale**: The 50-70ms latency difference is imperceptible for text editing. WebSocket through Cloudflare Durable Objects provides:
- Global edge distribution (low latency worldwide)
- Works behind all firewalls/NAT
- No STUN/TURN infrastructure needed
- Simpler debugging and reasoning
- Can add WebRTC later as optimization

#### Cloudflare Durable Object Design

**Role**: The Durable Object is not only a transient relay. It is the room authority for admission control, read/write permissions, persisted room metadata, and a compacted Yjs state snapshot used to bootstrap late joiners.

```typescript
// worker/collab_room.ts
export class CollabRoom extends DurableObject {
  // In-memory state (lost on hibernation)
  peers: Map<WebSocket, PeerInfo> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    
    // Restore state after hibernation
    this.ctx.blockConcurrencyWhile(async () => {
      // 1. Restore room metadata from DO Storage
      const meta = await this.ctx.storage.get<RoomMetadata>("room-meta");
      this.roomMeta = meta ?? null;
      
      // 2. Rebuild peer map from WebSocket attachments
      this.peers = new Map();
      for (const ws of this.ctx.getWebSockets()) {
        const peer = ws.deserializeAttachment<PeerAttachment>();
        if (peer) this.peers.set(ws, peer);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["peer"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const peer = this.peers.get(ws);

    // Binary = framed y-protocols message
    if (msg instanceof ArrayBuffer) {
      const frame = decodeFrame(new Uint8Array(msg));

      // Read-only peers may receive sync/doc state and send awareness, but may not
      // publish document mutations into the room.
      if (frame.kind === "doc-update" && peer?.permission !== "write") return;

      await this.applyAndPersist(frame);
      this.broadcastBinary(frame.bytes, ws);
      return;
    }
    // JSON = control messages (join, signal, etc.)
    const parsed = JSON.parse(msg);
    // ... handle create/join/signal/awareness
  }
  
  async webSocketClose(ws: WebSocket) {
    this.peers.delete(ws);
    // If last peer, schedule room cleanup after TTL
    if (this.peers.size === 0) {
      await this.schedule_cleanup();
    }
  }
}
```

**Hibernation Recovery Strategy**:

| State Type | Storage | Restoration |
|------------|---------|-------------|
| Room secret | DO Storage (`storage.put`) | Read in constructor |
| Room metadata | DO Storage | Read in constructor |
| Yjs snapshot | DO Storage (periodic) | Sent to joining peers |
| Per-peer info | `serializeAttachment` | Rebuild from `getWebSockets()` |
| Active peer list | Memory only | Rebuild from attachments |

**Room Bootstrap (Critical)**:
- When first peer creates room: store Yjs state snapshot in DO Storage
- When a peer joins: DO validates token, attaches `{ peer_id, permission, identity }` to the WebSocket, then sends the persisted Yjs snapshot before allowing live updates
- When other peers are online: Yjs sync protocol still reconciles any state-vector deltas after the snapshot
- When no peers are online: the stored snapshot is the source of truth and is sufficient to open the room
- On every accepted document update: DO applies the update to its in-memory `Y.Doc` and stores either an append-only update or a debounced compacted snapshot
- Compaction: replace the update log with `Y.encodeStateAsUpdate(roomDoc)` every N updates or M minutes, and always before room hibernation/cleanup when possible
- Room storage must include enough data to recover after all peers disconnect: `room-meta`, `ydoc-snapshot`, optional `pending-updates`, and `last_compacted_at`

#### WebSocket Message Protocol

Do not relay opaque binary blindly. Use explicit framing around `y-protocols` messages so the DO can enforce permissions and persist state.

```typescript
type ClientFrame =
  | { kind: "sync-step-1"; bytes: Uint8Array }      // allowed for read/write
  | { kind: "sync-step-2"; bytes: Uint8Array }      // allowed for read/write
  | { kind: "doc-update"; bytes: Uint8Array }       // write only
  | { kind: "awareness"; bytes: Uint8Array };       // allowed for read/write

type ControlMessage =
  | { type: "create"; room_id: RoomId; room_secret: string; initial_state: Uint8Array }
  | { type: "join"; room_id: RoomId; token: string; peer_id: string; identity: UserIdentity };
```

**Read-only enforcement**:
- DO stores `permission` per WebSocket using `serializeAttachment`
- DO rejects `doc-update` frames from read-only sockets
- DO permits sync request/response frames needed to receive state
- DO permits awareness frames but marks users as read-only in awareness state
- Client UI also sets CodeMirror read-only mode, but server-side enforcement is authoritative

### 13.4 Multi-Project / Sessions Architecture

#### Current Limitation

The current codebase supports exactly ONE project:
- `project_persist.ts` uses `eztex-projects/default/` (single slot)
- `App.tsx` creates one `create_project_store()`
- No project identity (ID, name, metadata)

#### New Project Model

```typescript
export type ProjectId = string;
export type RoomId = string;

export interface ProjectMetadata {
  id: ProjectId;
  room_id?: RoomId;             // Optional remote collaboration room mapping
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
}

// URL structure
// Solo: /?project=abc123
// Collab: /?project=abc123&room=xyz789#w.signature_here
```

**Identity separation**:
- `ProjectId` is local to the browser/OPFS catalog and keys local outputs, caches, worker requests, and UI state
- `RoomId` is the remote collaboration room identifier and keys the Durable Object
- A local project may attach to zero or one active room at a time
- Joining `/c/<room_id>` creates or opens a local `ProjectId` that maps to that `RoomId`

#### Yjs Document Schema

```typescript
type YProjectDoc = {
  meta: Y.Map<unknown>;           // ProjectMetadata
  paths: Y.Map<string>;          // path -> file_id
  file_meta: Y.Map<Y.Map<any>>;  // file_id -> FileMetadata
  texts: Y.Map<Y.Text>;          // file_id -> collaborative text
  blob_refs: Y.Map<string>;      // file_id -> content_hash (NOT the blob itself)
};
```

**Binary file storage**: Do NOT store binary content in Yjs. Large `Uint8Array` values in Y.Map cause:
- Excessive memory usage
- Large update messages
- Slow CRDT merge operations

**Solution**: Store binary files out-of-band:
```
Yjs document:     file_id -> content_hash
Blob store:       content_hash -> Uint8Array
```

Blob store options:
- OPFS for local-only projects
- IndexedDB for small projects
- R2/S3-like storage for collaboration (future)
- Content-addressed (hash = key) for deduplication

**Why stable file IDs**: Renames should not destroy file identity, undo history, or awareness state.

#### OPFS v2 Layout

```
eztex-projects/
  catalog.json              // Project list with metadata
  projects/
    <project_id>/
      project.json         // Manifest
      ydoc.bin             // Yjs state snapshot
      blobs/
        <sha256>           // Binary file content, content-addressed
      outputs/
        output.pdf
        output.synctex
      history/             // Checkpoints (future)
```

#### ProjectManager Interface

```typescript
export interface ProjectRuntime {
  project_id: ProjectId;
  room_id?: RoomId;
  metadata: ProjectMetadata;
  doc: Y.Doc;
  awareness: Awareness;
  provider: ProjectProvider | null;
  blob_store: BlobStore;
  snapshot_files(): Promise<ProjectFiles>;
  persist(): Promise<void>;
  destroy(): Promise<void>;
}

export interface ProjectManager {
  catalog(): Promise<ProjectCatalog>;
  current(): ProjectRuntime | null;
  create_project(name?: string): Promise<ProjectRuntime>;
  open_project(id: ProjectId): Promise<ProjectRuntime>;
  open_room(room_id: RoomId, token: string): Promise<ProjectRuntime>;
  close_project(id?: ProjectId): Promise<void>;
  delete_project(id: ProjectId): Promise<void>;
}
```

`ProjectRuntime` owns all lifecycle cleanup: Yjs observers, CodeMirror bindings, BroadcastChannel/WebSocket providers, OPFS persistence, blob references, and compile cancellation guards. Project switching must cancel or sequence-guard in-flight compiles with `{ project_id, compile_seq }`.

### 13.5 Editor Refactoring Plan

#### Current Problems

1. **Keystroke writeback** (Editor.tsx:222-227):
```typescript
// WRONG: Writes full string on every keystroke
props.store.update_content(
  props.store.current_file(),
  update.state.doc.toString(),
);
```

2. **Full document replacement on file switch** (Editor.tsx:287-289):
```typescript
// WRONG: Destroys undo history, breaks CRDT
view.dispatch({
  changes: { from: 0, to: view.state.doc.length, insert: content },
});
```

#### New Approach

```typescript
// 1. Get Y.Text for current file
const ytext = store.get_ytext(store.current_file());

// 2. Create editor bound to Y.Text
const state = EditorState.create({
  doc: ytext.toString(),
  extensions: [
    // ... base extensions ...
    yCollab(ytext, provider.awareness, { undoManager }),
  ],
});

// 3. File switch = rebind, not replace
function switch_file(path: string) {
  const new_ytext = store.get_ytext(path);
  view.setState(EditorState.create({
    doc: new_ytext.toString(),
    extensions: create_extensions(new_ytext),
  }));
}
```

#### Undo/Redo Changes

- **Remove**: `history()` and `historyKeymap` from `@codemirror/commands`
- **Add**: `yUndoManagerKeymap` from `y-codemirror.next`
- **Behavior**: Each user undoes only their own changes (correct for collaboration)

### 13.6 Agent Integration Architecture

#### Design Decision: Agents Are Collaboration Peers First

**V1 primary path**: An agent connects to a collaboration room as a WebSocket peer and applies CRDT transactions through the same provider/protocol as humans. This works with a static browser app because the agent does not need the browser to host an MCP server.

**Flow**:
```
Agent runtime -> WebSocket provider -> Durable Object -> Yjs transaction -> persistence -> UI
```

**Why not browser-hosted MCP for v1**: A normal web page cannot expose a local MCP server to desktop agents. MCP still makes sense, but it needs an explicit host process or hosted service.

#### MCP Hosting Options

| Option | How It Works | Pros | Cons | Phase |
|--------|--------------|------|------|-------|
| **WebSocket collaborator** | Agent joins room with a capability token and edits Yjs directly | Works with static app, reuses collab auth/persistence, simplest v1 | Requires agent runtime to implement room protocol | **V1** |
| Local sidecar MCP server | User runs local process; sidecar hosts MCP and connects to room/browser | Standard MCP tools, can access local files with permission | Install step, lifecycle/permissions complexity | V2 |
| Hosted MCP-over-HTTP service | Cloud service hosts MCP tools and connects to rooms | No local install, good for remote agents | Requires auth, billing/security boundary, server state | V2/V3 |
| Browser extension bridge | Extension mediates MCP-like calls into the page | Can talk to active tab | Extension distribution and permissions friction | Defer |

**V1 Recommendation**: Implement the WebSocket collaborator first. Keep the MCP tool shape as the external API contract, but expose it from an agent adapter that talks to the room protocol, not from the browser page itself.

**MCP Tools Spec**:
```typescript
type ExtexMCP = {
  listFiles(): string[];
  readFile(path: string): string;
  writeFile(path: string, content: string, opts?: { baseRevision?: string }): Result;
  applyPatch(path: string, patch: string): Result;
  createFile(path: string, content: string): Result;
  deleteFile(path: string): Result;
  renameFile(from: string, to: string): Result;
  runCompile(): Promise<CompileResult>;
  getDiagnostics(): Diagnostic[];
  beginTransaction(label: string): TransactionId;
  commitTransaction(id: TransactionId): void;
};
```

**Critical**: Every mutating call requires `baseRevision` to prevent overwriting concurrent user edits.

**Agent write safety**:
- Agent joins with explicit identity and permission, e.g. `{ name: "Claude", kind: "agent" }`
- Mutations are grouped in Yjs transactions with an origin label for review/history
- Large rewrites should use a shadow branch/doc or review mode before applying to the live document
- `baseRevision` maps to a Yjs state vector or file-level content hash, not a global integer revision
- Compile requests are debounced and project-scoped to avoid compile storms

#### Secondary Path: Local Folder Mode

When user opens local folder via File System Access API:
- Browser edits CRDT
- CRDT writes to local files (outbound)
- External edits detected via polling/FileSystemObserver (inbound)
- Inbound changes applied as diffs to CRDT (not full replacement)

**Important**: Local folder mode DOES require sync logic. File watching in browsers is not reliable without polling.

### 13.7 Pierre Libraries Adoption

#### Decision: Adopt Selectively

| Library | Use For | Loading | Bundle Impact |
|---------|---------|---------|---------------|
| **@pierre/trees** | FilePanel upgrade | Eager | Low |
| **@pierre/diffs** | Agent review, conflict resolution | **Lazy** | Medium (Shiki) |

#### SolidJS Integration

Both libraries expose **vanilla JS imperative APIs** that integrate cleanly with SolidJS via `onMount`, `createEffect`, and `onCleanup`:

```typescript
// @pierre/trees wrapper
function FileTreeWrapper(props: { paths: string[] }) {
  let container!: HTMLDivElement;
  let tree: FileTree | undefined;

  onMount(() => {
    tree = new FileTree({ paths: props.paths, id: "extex-tree" });
    tree.render({ fileTreeContainer: container });
  });

  createEffect(() => tree?.resetPaths(props.paths));
  onCleanup(() => tree?.cleanUp());

  return <div ref={container} />;
}

// @pierre/diffs lazy loading
async function showDiff(container: HTMLElement, before: string, after: string) {
  const { FileDiff } = await import("@pierre/diffs");
  const diff = new FileDiff({
    oldFile: { contents: before, language: "tex" },
    newFile: { contents: after, language: "tex" },
    diffStyle: "split",
  });
  diff.render(container);
}
```

### 13.8 Identity and Sharing Model

#### Anonymous Identity

```typescript
interface UserIdentity {
  user_id: string;      // crypto.randomUUID() - stored in localStorage
  display_name: string;  // "Quick Fox" - auto-generated
  color_hue: number;     // deterministic from user_id
}
```

#### Complete Capability Token Protocol

**Share URL Format**:
```
https://eztex.app/c/room123#w.signature_here
                              ^
                              HMAC-SHA256(room_secret, room_id + ":w")
```

**Token in URL fragment**: Never sent in HTTP request, visible only to browser.

**Lifecycle**:

1. **Room Creation**:
   ```typescript
   // Owner's browser
   const room_id = generate_room_id();  // 8-char base62
   const room_secret = crypto.getRandomValues(32);  // 256-bit
   
   // Connect to DO
   ws.send(JSON.stringify({
     type: "create",
     room_id,
     room_secret: base64url(room_secret)
   }));
   ```

2. **DO Stores Secret**:
   ```typescript
    // DO persists to survive hibernation
    await this.ctx.storage.put("room-meta", {
      room_id,
      // The DO must store the secret itself, not only a hash. HMAC verification
      // requires the key. Treat DO Storage as trusted room authority storage.
      room_secret: encrypt_at_rest_if_available(room_secret),
      created_at: Date.now(),
      ttl_days: 30
    });
   ```

3. **Token Generation** (client-side):
   ```typescript
   async function create_token(
     room_secret: Uint8Array,
     room_id: string,
     permission: "r" | "w"
   ): Promise<string> {
     const key = await crypto.subtle.importKey(
       "raw", room_secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
     );
     const message = new TextEncoder().encode(`${room_id}:${permission}`);
     const sig = await crypto.subtle.sign("HMAC", key, message);
     const truncated = new Uint8Array(sig).slice(0, 16);  // 128-bit
     return `${permission}.${base64url(truncated)}`;
   }
   ```

4. **Token Verification** (DO-side):
   ```typescript
   async function verify_token(
     room_secret: Uint8Array,
     room_id: string,
     permission: "r" | "w",
     token: string
   ): Promise<boolean> {
     const [perm, sig_b64] = token.split(".");
     if (perm !== permission) return false;
      
      const expected = await hmac_truncated(room_secret, `${room_id}:${permission}`);
      return constant_time_equal(base64url_decode(sig_b64), expected);
   }
   ```

5. **Join Flow**:
   ```
   Peer opens URL -> extracts token from hash -> connects WebSocket
   -> sends { type: "join", room_id, token, peer_id, name }
   -> DO verifies token against stored secret
   -> accepts or rejects (close with 4001/4002)
   ```

**Read-Only Enforcement**:
- DO tracks permission per WebSocket in attachment
- DO drops document update messages from read-only peers
- Client-side: CodeMirror `readOnly` facet
- Client-side: Provider skips `doc.on('update')` registration
- Binary protocol: separate `yjs-sync` (allowed) from `yjs-update` (blocked)

**Revocation**:
- V1: No per-token revocation (all tokens share same secret)
- V2: Add `version` field to tokens, increment room version to invalidate old tokens
- V2: Store revoked token hashes in DO (with TTL)

**Room Cleanup**:
- DO schedules alarm when last peer disconnects
- After TTL (e.g., 7 days of inactivity), DO deletes storage
- Owner can explicitly close room (sets closed flag)

### 13.9 Implementation Phases

#### Phase 0: Yjs Foundation + Same-Origin Safety (2-3 weeks)

**Goal**: CRDT-backed store, single project, safe same-origin multi-tab editing

1. Install Yjs dependencies
2. Create `y_project_doc.ts` with document schema
3. Refactor `project_store.ts` internals (preserve API)
4. Refactor `Editor.tsx` to use `yCollab`
5. Add `snapshot_files()` for compile/export compatibility
6. Add BroadcastChannel provider with project-scoped channel names
7. Add `y-indexeddb` or OPFS snapshot persistence for local Yjs state
8. Verify single-user editing unchanged and two tabs converge

**Multi-tab rule**: BroadcastChannel is not optional. Without it, two tabs can edit and persist divergent versions of the same OPFS project.

#### Phase 1: Multi-Project Persistence (2 weeks)

**Goal**: Multiple projects, project switcher

1. Add v2 OPFS layout with project catalog
2. Create `project_manager.ts`
3. Migrate v1 `default` slot to new project
4. Add project switcher UI to toolbar
5. URL-based project routing (`?project=abc123`)

#### Phase 2: Collaboration Protocol Prototype (1-2 weeks)

**Goal**: Validate WebSocket provider, framed Yjs protocol, and DO room persistence before full sharing UI

1. Implement minimal WebSocket provider over `y-protocols/sync` and `awareness`
2. Implement DO room create/join with persisted room metadata
3. Persist compacted Yjs snapshot in DO Storage
4. Verify late join after all peers disconnect
5. Verify read-only sockets cannot publish document updates

#### Phase 3: Remote Collaboration (4-6 weeks)

**Goal**: Share projects via URL

1. Cloudflare Worker + Durable Object room authority
2. Production Yjs provider over WebSocket
3. Anonymous identity + awareness
4. Share link generation
5. Peer list / remote cursors
6. Read-only mode support
7. Reconnection, hibernation recovery, state compaction, room TTL cleanup

#### Phase 4: Agent Integration (Timeline depends on architecture decision)

**Goal**: LLM agents can edit projects

1. V1: Agent WebSocket collaborator adapter using room capability tokens
2. Define MCP tool contract, but do not require browser-hosted MCP
3. Decide whether V2 is local sidecar MCP or hosted MCP-over-HTTP
4. Agent session model and identity/permission UI
5. Shadow workspace for reviewed changes
6. @pierre/diffs integration for review UI
7. Transaction batching (compile debounce)

#### Phase 5: Bidirectional Folder Sync (2-3 weeks)

**Goal**: Local folder mode with external agent edits

1. Polling-based disk change detection
2. Text diff application to Yjs (not full replacement)
3. Hash-based echo suppression
4. Conflict resolution UI
5. FileSystemObserver (Chrome 133+) as optimization

### 13.10 Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Editor full-replace breaks CRDT | Critical | Rebind editor state, don't dispatch changes |
| Facade leakage through `store.files` | High | Audit all access, migrate to `snapshot_files()` |
| Stale compile after project switch | High | Add `project_id` + `compile_seq` guards |
| Room secret lost on DO eviction | High | Use DO Storage API (not just memory) |
| Late joiner has no Yjs state | Critical | Persist compacted Yjs snapshot in DO Storage |
| Read-only peer mutates document | Critical | Frame Yjs messages and reject `doc-update` from read-only sockets |
| Browser cannot host MCP directly | High | V1 agent = WebSocket collaborator; MCP requires sidecar or hosted service |
| Binary file bloat in Yjs | Medium | Store content-addressed blobs out-of-band |
| Yjs update log grows indefinitely | Medium | Periodic snapshot compaction and log replacement |
| FileSystemObserver unreliable | Medium | Polling fallback mandatory |
| Agent partial writes | Medium | Atomic transactions, base revision checks |
| Shiki bundle size from diffs | Low | Lazy-load only when needed |
| Shadow DOM styling friction | Low | Isolate Pierre components |

### 13.11 Updated Priority Matrix (Collaboration)

| Feature | Effort | Impact | Risk | Priority |
|---------|--------|--------|------|----------|
| Yjs foundation (Phase 0) | M | Very High | Medium | **P0** |
| Editor CRDT binding | M | Very High | High | **P0** |
| BroadcastChannel same-origin sync | S | High | Low | **P0** |
| Multi-project persistence | M | High | Low | **P1** |
| WebSocket DO room authority | L | High | Medium | **P1** |
| DO Yjs snapshot persistence | M | Very High | Medium | **P1** |
| Identity + share links | S | Medium | Low | **P1** |
| Agent WebSocket collaborator | M | High | Medium | **P2** |
| MCP sidecar API | L | High | Medium | **P3** |
| @pierre/diffs integration | S | Medium | Low | **P2** |
| @pierre/trees integration | S | Medium | Low | **P2** |
| Bidirectional folder sync | M | Medium | High | **P3** |
| WebRTC optimization | L | Low | High | **P3** |

---

---

## 14. Development Workflow (NEW)

### Wave-Based Iterative Implementation

**Process**:
1. **gpt55 (Task ID: `ses_1e9362f08ffe78oVgw2ByjnB5r`)** writes wave requirements, constraints, examples, and rules
2. **glm** executes the implementation wave
3. **gpt55** reviews the completed implementation
4. **Repeat** until all waves are complete

**Supporting Subagents**:
| Subagent | Role | When to Use |
|----------|------|-------------|
| **gpt55** | Primary architect & planner | Requirements, design decisions, reviews |
| **glm** | High-confidence implementation | Code execution, wave completion |
| **scout** | Read-only file search | Finding files, patterns, edit surfaces |
| **researcher** | Research & information gathering | External docs, libraries, strategies |
| **builder** | Batch editing & refactoring | Low-effort, high-repetition changes |

**Task ID Reference**:
- `ses_1e9362f08ffe78oVgw2ByjnB5r` - gpt55 (use for all planning/consultation/review)

**Wave Definitions**:

| Wave | Scope | Est. Duration | Dependencies |
|------|-------|---------------|--------------|
| **Wave 0** | Yjs CRDT foundation + Editor refactor | 2-3 weeks | None |
| **Wave 1** | Multi-project OPFS persistence | 2 weeks | Wave 0 |
| **Wave 2** | Same-tab sync (BroadcastChannel) | 3-5 days | Wave 0 |
| **Wave 3** | Remote collab (WS + DO relay) | 4-6 weeks | Wave 1, 2 |
| **Wave 4** | Agent integration (WS collaborator) | 3-4 weeks | Wave 3 |
| **Wave 5** | Local folder bidirectional sync | 2-3 weeks | Wave 0 |
| **Wave 6** | Pierre libraries + polish | 2-3 weeks | Wave 4 |
| **Wave 7** | Advanced features (MCP, WebRTC, etc.) | 4-8 weeks | Wave 4 |

**Implementation Rules**:
1. Each wave produces working, testable code
2. No wave breaks existing functionality
3. Review gate before proceeding to next wave
4. gpt55 defines acceptance criteria for each wave
5. All code follows existing project style (AGENTS.md rules)
6. Tests required for collaboration-critical paths

---

*Document version: 2026-05-11*
*Collaboration section added based on comprehensive analysis of Zed architecture, Yjs CRDT evaluation, Cloudflare Durable Objects research, Pierre libraries assessment, and agent integration design.*
*Development workflow documented for wave-based iterative implementation.*
