# Collaborative Editing Architecture for eztex

## 1. System Overview

```
+------------------------------------------------------------------+
|                        BROWSER CLIENT A                          |
|                                                                  |
|  +------------------+    +------------------+    +-------------+ |
|  | SolidJS Main     |    | Compile Worker   |    | Collab      | |
|  | Thread           |    | (Web Worker)     |    | Module      | |
|  |                  |    |                  |    | (main thrd) | |
|  | +- Editor.tsx    |    | +- engine.ts     |    |             | |
|  | +- CodeMirror    |<-->| +- tectonic WASM |    | +- Yjs Doc  | |
|  | +- project_store |    | +- bundle_fetch  |    | +- Awareness| |
|  | +- y-codemirror  |    |                  |    | +- Provider | |
|  +--------+---------+    +------------------+    +------+------+ |
|           |                                             |        |
|           +---------------------------------------------+        |
|                             |                                    |
+-----------------------------+------------------------------------+
                              |
              +---------------+---------------+
              |                               |
              v (preferred)                   v (fallback)
    +-------------------+           +-------------------+
    | WebRTC DataChannel|           | WebSocket via DO  |
    | (peer-to-peer)    |           | (relay, no store) |
    +-------------------+           +---------+---------+
              |                               |
              |        +------------+         |
              +------->| Cloudflare |<--------+
                       | Durable    |
                       | Object     |
                       |            |
                       | - signaling|
                       | - WS relay |
                       | - presence |
                       | - NO state |
                       | - NO KV/R2 |
                       +-----+------+
                             |
                       +-----+------+
                       | CF Worker  |
                       | (router)   |
                       | /ws/:room  |
                       +------------+
              |
              v
    +-------------------+
    | WebRTC DataChannel|
    | (peer-to-peer)    |
    +-------------------+
              |
+-------------+--------------------------------------------+
|                        BROWSER CLIENT B                  |
|  (same structure as Client A)                            |
+----------------------------------------------------------+
```

### Connection Flow

```
Client A                  CF DO (room-xyz)              Client B
   |                           |                           |
   |--- WS connect ---------->|                           |
   |                           |<--- WS connect ----------|
   |                           |                           |
   |<-- peer-list (B) --------|                           |
   |                           |-------- peer-list (A) -->|
   |                           |                           |
   |--- SDP offer ----------->|-------- SDP offer ------->|
   |                           |                           |
   |<-- SDP answer via DO ----|<------- SDP answer -------|
   |                           |                           |
   |--- ICE candidates ------>|-------- ICE candidates -->|
   |<-- ICE candidates -------|<------- ICE candidates ---|
   |                           |                           |
   |========= WebRTC DataChannel established =============|
   |                           |                           |
   |--- Yjs sync step 1 ------|-----(via DataChannel)---->|
   |<-- Yjs sync step 2 ------|<---(via DataChannel)------|
   |                           |                           |
   | (DO goes idle/hibernates) |                           |
   |===== CRDT ops flow P2P, DO is dormant ===============|
```

## 2. CRDT Layer Choice: Yjs

### Decision: Yjs (not Automerge, not Diamond-types, not custom)

**Rationale:**

| Criterion | Yjs | Automerge | Diamond-types | Custom (Zed-style) |
|-----------|-----|-----------|---------------|---------------------|
| Bundle size | ~15KB min+gz (JS) | ~800KB+ (WASM) | ~200KB (WASM, alpha) | N/A (months of work) |
| Awareness/presence | Built-in protocol | Manual | None | Manual |
| CodeMirror binding | `y-codemirror.next` (official) | Community | None | From scratch |
| WebRTC provider | `y-webrtc` (official) | None | None | From scratch |
| Maturity | 7+ years, used by Jupyter, Notion, BlockSuite | Solid but heavy | Experimental | N/A |
| Web Worker safe | Core Yjs: yes. Providers: main thread | WASM in worker: yes | WASM in worker: yes | N/A |
| Perf (text edit) | O(1) amortized local ops | O(log n) | O(log n), fastest raw | N/A |

**Why not Automerge:** The WASM bundle is ~800KB min+gzip. For an app that already loads tectonic WASM (~15MB), this is not catastrophic but is still 50x larger than Yjs for equivalent functionality. Automerge also lacks an official CodeMirror binding and WebRTC provider.

**Why not Diamond-types:** Fastest raw CRDT benchmark performance but explicitly labeled "API in flux" and "plain text only." No awareness protocol, no editor bindings, no transport providers. Would require building everything from scratch for a marginal speed gain on operations that are already sub-millisecond with Yjs.

**Why not custom CRDT (Zed-style):** Zed's SumTree + tombstone CRDT is beautiful engineering, but it took a dedicated team months to build. The existing research doc's Rust/WASM prototype is a skeleton, not production code. For a LaTeX editor with <100 concurrent users per room, Yjs provides equivalent user experience with 1/100th the implementation effort.

### LaTeX-specific CRDT considerations

LaTeX documents are **flat text files**, not structured trees. Despite having logical structure (`\begin{document}...\end{document}`), the actual editing model is character-by-character text insertion/deletion -- identical to any other source code file. There is no need for block-level CRDT semantics because:

1. LaTeX environments are denoted by plain text markers (`\begin{...}`, `\end{...}`), not tree nodes
2. Users editing different sections work in disjoint text regions -- Yjs handles this natively
3. Concurrent edits within the same `\begin{equation}` block resolve the same way as concurrent edits in any text -- by CRDT ordering rules
4. The compile step (tectonic) is the "structural validator" -- if a merge produces invalid LaTeX, the compile error surfaces it immediately

**One edge case:** Binary files (images, fonts) in the project. Yjs `Y.Map` can store `Uint8Array` values, but for this phase, binary files should remain local-only (not synced). The collaboration targets `.tex` and `.bib` text files only.

## 3. Transport Architecture

### Phase 1: Signaling via Cloudflare Durable Object

The Durable Object (DO) serves exactly three purposes:
1. **Room membership** -- track which peers are connected (in-memory `Map`)
2. **WebRTC signaling** -- relay SDP offers/answers/ICE candidates between peers
3. **WebSocket fallback relay** -- when WebRTC fails, relay Yjs update messages

The DO holds **zero document content**. It processes opaque binary blobs (Yjs updates) and signaling JSON. It has no KV, R2, or D1 bindings.

**Signaling protocol (JSON over WebSocket):**

```typescript
// Client -> DO
type ClientMsg =
  | { type: "join"; peer_id: string; name: string }
  | { type: "signal"; to: string; data: RTCSignalData }
  | { type: "awareness"; data: Uint8Array }
  | { type: "yjs-update"; data: Uint8Array }  // fallback only

// DO -> Client
type ServerMsg =
  | { type: "peers"; peers: Array<{ id: string; name: string }> }
  | { type: "peer-join"; peer: { id: string; name: string } }
  | { type: "peer-leave"; peer_id: string }
  | { type: "signal"; from: string; data: RTCSignalData }
  | { type: "awareness"; from: string; data: Uint8Array }
  | { type: "yjs-update"; from: string; data: Uint8Array }

type RTCSignalData =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
```

**DO implementation sketch:**

```typescript
export class CollabRoom {
  state: DurableObjectState;
  peers: Map<WebSocket, { id: string; name: string }> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
    // NO storage bindings. NO this.state.storage calls.
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation API handlers
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    // parse, route signal/awareness/update messages to target peer(s)
    // broadcast peer-join/peer-leave on connect/disconnect
  }

  async webSocketClose(ws: WebSocket) {
    const peer = this.peers.get(ws);
    if (peer) {
      this.peers.delete(ws);
      this.broadcast({ type: "peer-leave", peer_id: peer.id });
    }
    // When last peer disconnects, DO has nothing in memory, hibernates, eventually evicts
  }
}
```

**Key details:**
- Uses WebSocket Hibernation API (`acceptWebSocket` / `webSocketMessage` / `webSocketClose`) so the DO consumes zero CPU when peers are idle
- DO hibernates after ~10s of no messages, wakes on next message
- Max 32,768 WebSocket connections per DO -- vastly exceeds our needs
- WebSocket message size limit: 32 MiB (sufficient for any Yjs sync)
- DO lifecycle: created on first room join, garbage collected after all sockets close and hibernation timeout expires

### Phase 2: WebRTC Peer-to-Peer

Once peers discover each other via the DO, they establish WebRTC DataChannels:

```typescript
// For each remote peer:
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    // Cloudflare TURN (requires API key for credentials):
    // { urls: "turn:turn.cloudflare.com:3478", username: "...", credential: "..." }
  ]
});

const dc = pc.createDataChannel("yjs", {
  ordered: true,      // CRDT ops should arrive in causal order when possible
  maxRetransmits: 10   // retry a few times, then Yjs sync catches gaps
});
```

**What flows over the DataChannel:**
- Yjs document updates (binary, `Uint8Array`)
- Yjs awareness updates (binary, `Uint8Array`)
- These are identical to what `y-webrtc` sends -- we can use its encoding or roll a thin wrapper

**Why ordered DataChannel:** Yjs updates are commutative (order doesn't affect final state), but ordered delivery reduces the frequency of "catch-up" sync rounds. The small overhead of ordering is negligible for text editing traffic.

### Phase 3: WebSocket Fallback

When WebRTC connection fails (symmetric NAT, corporate firewalls, no TURN server), the system falls back to relaying Yjs updates through the DO WebSocket:

**Fallback detection:**
1. After signaling exchange, wait 5 seconds for DataChannel `open` event
2. If DataChannel fails to open, mark that peer pair as "ws-relay"
3. Send Yjs updates to the DO with `{ type: "yjs-update", data: ... }` for relay
4. Periodically retry WebRTC connection (every 30s) -- upgrade to P2P if it succeeds

**The DO relay is stateless:** it receives a binary blob from peer A and forwards it to all other peers in the room. It does not parse, store, or buffer these messages. If a peer disconnects and reconnects, the Yjs sync protocol handles catch-up (peers exchange state vectors and missing updates directly).

### TURN/STUN

- **STUN:** Use Cloudflare's free STUN server (`stun:stun.cloudflare.com:3478`) or Google's (`stun:stun.l.google.com:19302`)
- **TURN:** Cloudflare offers TURN service (Cloudflare Realtime / Calls). Credentials are generated via API call. This is optional -- the WebSocket fallback through DO achieves the same connectivity without TURN cost. TURN only adds value if you need lower latency than WebSocket relay for the small % of peers behind symmetric NAT.
- **Recommendation:** Skip TURN entirely. The DO WebSocket relay serves as the fallback transport. This eliminates a service dependency and keeps the architecture simpler.

## 4. Layer Breakdown

| Layer | Component | Lives In | Notes |
|-------|-----------|----------|-------|
| **CRDT** | `Y.Doc` + `Y.Text` | Main thread | Yjs core, one `Y.Text` per file in a `Y.Map` |
| **Editor binding** | `y-codemirror.next` | Main thread | Binds `Y.Text` to CodeMirror EditorState |
| **Awareness** | `y-protocols/awareness` | Main thread | Cursor positions, selections, user names/colors |
| **Transport: P2P** | WebRTC DataChannels | Main thread | Yjs updates + awareness, per-peer connections |
| **Transport: WS** | WebSocket to DO | Main thread | Signaling always, Yjs relay as fallback |
| **Signaling** | `CollabRoom` DO | Cloudflare edge | Peer discovery, SDP/ICE relay, WS fallback |
| **Router** | CF Worker | Cloudflare edge | Routes `/ws/:room` to the correct DO |
| **Project store** | `project_store.ts` | Main thread | Replaced by Yjs doc for collab files |
| **Compile trigger** | Debounced watcher | Main thread | Observes Yjs doc changes, triggers compile |
| **Compile engine** | tectonic WASM | Web Worker | Receives files snapshot, returns PDF |

### Why CRDT is on main thread, not in the Web Worker

The Yjs document must live on the main thread because:
1. `y-codemirror.next` needs direct access to both the `Y.Text` and the CodeMirror `EditorView` -- these are main-thread DOM-bound objects
2. WebRTC `RTCDataChannel` is a main-thread API (not available in dedicated Web Workers in most browsers)
3. WebSocket is available in workers, but the DataChannel constraint forces main thread anyway
4. The compile Web Worker receives a **snapshot** (`Record<string, string>`) of all files -- it doesn't need the live CRDT

The Yjs doc is lightweight for text editing. A 100KB LaTeX document produces <1ms CRDT operations. There is no performance reason to offload it.

## 5. Data Flow Walkthrough

### User A types a character

```
1. User A presses 'x' in CodeMirror
   |
2. CodeMirror dispatches transaction with change {from: 42, insert: "x"}
   |
3. y-codemirror intercepts the transaction:
   - Applies the insert to Y.Text at the corresponding Yjs position
   - This generates a Yjs update (binary, ~20-50 bytes for single char)
   |
4. Yjs Y.Doc fires 'update' event with the binary update
   |
5. CollabProvider (our custom thin layer) distributes the update:
   a. For each peer with open DataChannel: dc.send(update)
   b. For each peer on WS fallback: ws.send({type:"yjs-update", data: update})
   |
6. Concurrently, awareness module sends cursor position update:
   - awareness.setLocalStateField("cursor", {anchor: 43, head: 43})
   - Awareness update sent via same channels (DataChannel or WS)
```

### Remote peer (User B) receives the update

```
1. DataChannel.onmessage fires with binary update
   (or WebSocket.onmessage with {type:"yjs-update"} wrapper)
   |
2. Y.applyUpdate(doc, update) merges into local Yjs doc
   |
3. Y.Text fires 'delta' event
   |
4. y-codemirror observes the delta:
   - Converts Yjs delta to CodeMirror ChangeSpec
   - Dispatches remote transaction (annotated so local change handler ignores it)
   |
5. CodeMirror renders the character at the correct position
   |
6. Awareness update arrives (via same or next message):
   - Remote cursor decoration updated in CodeMirror
   - User B sees User A's cursor/selection highlighted
```

### LaTeX compile trigger

```
1. Yjs Y.Doc fires 'update' event (any change, local or remote)
   |
2. Debounce timer resets (1000ms default, configurable)
   |
3. After 1000ms of no changes:
   a. Snapshot all Y.Text values into a ProjectFiles object
   b. worker_client.compile({ files: snapshot, main: main_file })
   |
4. Compile Worker runs tectonic WASM, produces PDF
   |
5. PDF blob URL set in worker_client.pdf_url signal
   |
6. Preview component renders the PDF
```

**Compile strategy: every peer compiles independently.**

Reasoning:
- Each browser has the tectonic WASM engine loaded already
- Compiling locally means zero network transfer of PDF binaries (PDFs are ~100KB-1MB)
- Each user sees their compile result immediately, no waiting for a "compile host"
- If one user's browser is slow, it doesn't block others
- The compile is debounced per-client, so rapid typing doesn't cause N compiles
- This is how Overleaf works too -- each client compiles, the server compile is for persistence

## 6. Novel Architecture Considerations

### No-storage guarantee enforcement

The Durable Object class must have **no storage API calls**:

```typescript
export class CollabRoom {
  // Enforcement: never call this.state.storage.*
  // The wrangler.toml should have NO kv/r2/d1 bindings for the collab worker
  // Code review rule: grep for ".storage." in the DO file -- should return 0 results
}
```

The wrangler config enforces this at the infrastructure level:

```toml
[durable_objects]
bindings = [{ name = "COLLAB_ROOM", class_name = "CollabRoom" }]

# NO kv_namespaces, NO r2_buckets, NO d1_databases
# The DO literally cannot persist data because it has no storage bindings
```

Additionally, DO memory is capped at 128MB. Since we only store a `Map<WebSocket, {id, name}>`, actual memory usage is <1KB per peer. If the DO restarts (crash, hibernation wake), the in-memory map is rebuilt from the WebSocket Hibernation API's stored socket list (the framework maintains socket references across hibernation, though we need to re-derive metadata from socket tags/attachments).

### Serverless DO lifecycle

1. **Room creation:** First client hits `/ws/room-abc` -> Worker creates/looks up DO by room ID -> DO instantiates with empty peer map
2. **Joining:** WebSocket upgrade -> `acceptWebSocket` -> peer added to map -> existing peers notified
3. **Idle:** After all messages processed, DO hibernates in ~10s -> zero CPU cost
4. **Wake:** Next WebSocket message wakes the DO -> constructor re-runs -> peer map rebuilt from active sockets
5. **Teardown:** Last peer disconnects -> DO has no sockets -> after hibernation timeout, DO is eligible for eviction -> memory freed

There is no "room list" or "room persistence." Rooms exist only as long as at least one peer is connected. Room IDs are generated client-side (UUID or user-chosen slug). Share the URL to join.

### Hybrid P2P/relay switching criteria

```
                       +--> DataChannel opens? --YES--> P2P mode
                       |                                  |
  Signaling exchange --+                                  |
                       |                            (monitor health)
                       +--> 5s timeout? ---------> WS relay mode
                                                         |
                                                   (retry P2P every 30s)
                                                         |
                                                    DataChannel opens?
                                                     YES: switch to P2P
                                                     NO: stay on WS relay
```

Per-peer-pair decision. Client A might have P2P to Client B but WS relay to Client C. The CollabProvider abstracts this -- Yjs updates go to the "best available channel" for each peer.

### Offline / reconnect without server state

**Scenario:** User A goes offline, edits for 10 minutes, comes back.

1. During offline: Yjs accumulates local updates in its internal state
2. On reconnect: WebSocket to DO re-established -> peer list refreshed
3. Yjs sync protocol kicks in:
   - User A sends state vector to each peer (or via DO broadcast)
   - Peers respond with missing updates (Yjs sync step 1 / step 2)
   - All clients converge to the same document state
4. No server-side op log needed -- Yjs's state vector sync is peer-to-peer

**Tradeoff:** If ALL peers disconnect simultaneously and the DO evicts, there is no "recovery source." Each peer has their local Yjs state, so if any one reconnects, they become the source of truth. But if a peer closes their browser tab entirely (losing in-memory Yjs state) and no other peer is online, the document is lost.

**Mitigation options (future, not phase 1):**
- Browser-local persistence: serialize `Y.encodeStateAsUpdate(doc)` to IndexedDB/OPFS periodically. On reconnect, load from local store and sync.
- This already exists as `y-indexeddb` provider. Adding it is a one-line integration.
- This does NOT violate the "no cloud storage" constraint -- it's client-side only.

### Compile architecture: independent compilation

Each peer compiles independently. This is the right default because:
- No PDF streaming over WebRTC/WebSocket (saves bandwidth, avoids complexity)
- Each user has responsive compile feedback regardless of network conditions
- Avoids "who is the compile authority" coordination
- The tectonic WASM is already loaded per-client

Future optimization: for expensive compiles (large documents, many passes), one peer could compile and share the PDF hash for cache validation. But this is premature.

## 7. Implementation Phases

### Phase 0: Yjs integration (no networking) [1-2 days]

**Goal:** Replace `project_store.ts` text content with Yjs-backed reactive text.

1. Add dependencies: `yjs`, `y-codemirror.next`, `y-protocols`
2. Create `collab_store.ts`:
   - Manages a `Y.Doc` with a `Y.Map<Y.Text>` for file contents
   - Exposes a SolidJS-compatible reactive interface matching `ProjectStore`
   - File metadata (names, main file) stays in SolidJS store (not synced yet)
3. Update `Editor.tsx`:
   - Replace manual `EditorView.updateListener` with `y-codemirror.next` extension
   - The `yCollab()` extension handles bidirectional sync between `Y.Text` and CodeMirror
4. Update compile trigger:
   - Observe `Y.Doc` updates instead of `project_store.on_change`
   - Snapshot `Y.Text.toString()` for each file when compile fires
5. **Verify:** Single-user editing works identically to current behavior. No networking.

### Phase 1: WebSocket relay via Durable Object [2-3 days]

**Goal:** Two browsers can co-edit a document via WebSocket relay through a Durable Object.

1. Create `worker/collab.js` (or extend existing worker):
   - CF Worker routes `/ws/:room` to a `CollabRoom` Durable Object
   - DO implements WebSocket Hibernation API
   - DO broadcasts all messages to all other peers in the room (simple fan-out)
2. Create `app/src/lib/collab_provider.ts`:
   - Custom Yjs provider (simpler than `y-webrtc`)
   - Connects WebSocket to DO
   - Sends/receives Yjs updates and awareness via WebSocket
   - Handles reconnection with exponential backoff
3. Wire into `collab_store.ts`:
   - On "join room" action: create provider, connect to DO
   - Yjs sync protocol handles initial state exchange between peers
4. Add awareness:
   - `y-protocols/awareness` for cursor/selection/username
   - `y-codemirror.next` renders remote cursors with colored decorations
5. Add minimal room UI:
   - "Share" button generates room URL
   - Room URL encodes the room ID in hash or path
   - Display peer count / names in toolbar
6. **Verify:** Two browser tabs/windows can co-edit. Cursor positions visible. Compile works for both.

### Phase 2: WebRTC P2P upgrade [2-3 days]

**Goal:** Peers establish direct WebRTC connections where possible, reducing latency and DO load.

1. Extend DO signaling protocol:
   - Add `signal` message type for SDP offer/answer/ICE candidate relay
   - DO routes signal messages to the target peer's WebSocket
2. Extend `collab_provider.ts`:
   - After peer discovery, initiate WebRTC connections
   - Create DataChannel for Yjs updates + awareness
   - On DataChannel open: stop sending Yjs updates via WebSocket (still keep WS for signaling)
   - On DataChannel close/fail: fall back to WebSocket relay
3. ICE configuration:
   - Use Cloudflare STUN (`stun:stun.cloudflare.com:3478`)
   - No TURN -- WebSocket relay is the fallback
4. **Verify:** Chrome devtools shows DataChannel traffic. Edit latency drops. DO sees reduced message volume after P2P established.

### Phase 3: Resilience and polish [2-3 days]

1. Client-side persistence:
   - `y-indexeddb` or manual `Y.encodeStateAsUpdate` to OPFS
   - On page load: restore from local store, then sync with peers
2. Reconnection handling:
   - WebSocket reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
   - WebRTC re-signaling on reconnect
   - Yjs sync protocol handles state merge automatically
3. File tree sync:
   - Add/remove/rename files synced via `Y.Map` observers
   - Main file setting synced
4. User presence polish:
   - User name prompt or random name generation
   - Cursor colors derived from user ID (deterministic hash)
   - "N users online" indicator
5. Rate limiting / abuse:
   - DO enforces max peers per room (e.g., 10)
   - Message rate limiting in DO (e.g., 100 msgs/sec per peer)
6. **Verify:** Offline editing + reconnect works. File operations sync. Graceful degradation on network issues.

### Phase 4 (future): Advanced features

- Read-only spectator mode
- Room access control (simple shared secret in URL hash)
- Compile result sharing (share PDF URL instead of each peer compiling)
- Multi-file awareness (show which file each peer is editing)
- Comment/annotation CRDT layer

## 8. Open Questions and Risks

### WebRTC NAT traversal success rate

Without TURN, WebRTC connections fail for ~10-15% of peer pairs (symmetric NAT, corporate proxies). The WebSocket relay fallback handles this, but those users get slightly higher latency (~50-100ms round trip through CF edge vs ~10-30ms P2P). For a LaTeX editor, this latency difference is imperceptible. **Risk: low.**

### Durable Object memory limits

DOs have a 128MB memory limit. Our DO stores only a peer map (~1KB per peer) and passes through messages without buffering. Even with 100 peers, memory usage is <100KB. **Risk: none.**

### Yjs bundle size impact

Yjs core: ~15KB min+gz. y-codemirror.next: ~5KB. y-protocols: ~3KB. Total: ~23KB. The app currently loads tectonic WASM at ~15MB. Yjs adds 0.15% to total bundle. **Risk: none.**

### Yjs scaling with document size

A 100KB LaTeX document generates a Yjs internal state of ~200-400KB (CRDT metadata overhead is roughly 2-4x for text). For a 500KB document (very large thesis), state might reach 2MB. All well within browser memory. Yjs has been tested with documents up to 10MB+. **Risk: none for expected use.**

### Concurrent editing conflicts in LaTeX

Two users editing the same `\begin{equation}...\end{equation}` block simultaneously could produce syntactically invalid LaTeX (e.g., interleaved tokens). This is inherent to any character-level CRDT and is not specific to our architecture. The immediate compile feedback loop surfaces these issues in <2 seconds. **Risk: low, mitigated by existing UX.**

### Browser tab close without sync

If a user closes their tab mid-edit and no other peer is online, unsaved Yjs state is lost. Phase 3's `y-indexeddb` persistence mitigates this, but the first two phases are vulnerable. **Risk: medium, mitigated in phase 3.**

### Cloudflare TURN cost

Cloudflare TURN is billed per-GB. We've chosen to skip TURN entirely and use WebSocket relay as fallback. If future testing shows that WebSocket relay latency is a problem for some users, TURN can be added as an optional upgrade. **Risk: architectural flexibility preserved, no lock-in.**

### y-webrtc vs custom WebRTC provider

We could use the existing `y-webrtc` package instead of writing a custom provider. However, `y-webrtc` makes assumptions about its signaling server format, bundles its own signaling client, and touches `window` (problematic for testing). A custom thin provider (~200 lines) gives us full control over the DO signaling protocol and fallback logic. The Yjs provider interface is simple: call `Y.applyUpdate()` on receive, listen for `doc.on('update')` on send. **Decision: custom provider, informed by y-webrtc's design.**

### WASM threading constraints

The compile Web Worker is single-threaded (no SharedArrayBuffer / Atomics in most deployments without cross-origin isolation headers). This is fine -- the compile worker is independent of the collab layer. Yjs runs on the main thread. There is no contention. **Risk: none.**

---

## Appendix: Key Dependencies

```json
{
  "yjs": "^13.6",
  "y-codemirror.next": "^0.3",
  "y-protocols": "^1.0",
  "y-indexeddb": "^9.0",
  "lib0": "^0.2"
}
```

Total addition: ~5 packages, ~25KB gzipped. Zero WASM. Zero native dependencies.

## Appendix: File Structure (proposed additions)

```
app/src/
  lib/
    collab_store.ts        -- Yjs doc management, SolidJS reactive wrappers
    collab_provider.ts     -- WebSocket + WebRTC transport, signaling
    collab_awareness.ts    -- Cursor presence, user identity
  components/
    CollabToolbar.tsx       -- Share button, peer list, room status

worker/
  index.js                 -- existing CORS proxy (unchanged)
  collab_worker.js         -- new: CF Worker for /ws/:room routing
  collab_room.js           -- new: Durable Object class
  wrangler.toml            -- updated: add DO binding, no storage bindings
```
