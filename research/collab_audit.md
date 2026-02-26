# Collaboration Implementation Audit

## Intuitive Summary of the Plan

eztex is a browser-based LaTeX editor that compiles via tectonic WASM. The collaboration plan adds real-time multi-user editing with a deliberate "no server state" philosophy. Here is how it works in plain terms:

**The CRDT layer:** Every open document becomes a Yjs `Y.Text` object. When you type, Yjs generates a tiny binary diff (~20-50 bytes per keystroke). These diffs are commutative -- they can arrive in any order and the final document will be identical on every peer. The `y-codemirror.next` binding sits between Yjs and CodeMirror, translating in both directions. Cursor positions and user names travel via the Yjs awareness protocol as a separate channel.

**The transport:** Peers first connect via WebSocket to a Cloudflare Durable Object (DO). The DO acts as a matchmaker -- it tells peers about each other and relays WebRTC signaling messages (SDP offers/answers, ICE candidates). Once peers establish a direct WebRTC DataChannel, the DO becomes dormant. If WebRTC fails (corporate firewalls, symmetric NAT), the DO stays active and relays Yjs diffs over the WebSocket instead. The DO stores *nothing* to disk -- it holds a peer map in memory and that is it.

**Identity and sharing:** No accounts. Each browser generates a UUID stored in localStorage. Room owners generate HMAC-signed tokens client-side using a room secret. These tokens are embedded in the URL hash fragment (never sent to the server in HTTP requests). The DO holds the room secret in memory to verify tokens. Write and read-only permissions are enforced at three layers: CodeMirror read-only facet, provider skips broadcasting local edits, DO drops update messages from read-only peers.

**Compilation:** Every peer compiles independently using their local tectonic WASM. No PDF is sent over the network. Each browser sees its own compile result with its own debounce timing.

---

## Performance Estimates

### Client-Side Performance

| Operation | Estimated Latency | Notes |
|-----------|-------------------|-------|
| Local keystroke -> Yjs update generated | <1ms | Yjs O(1) amortized for text insert |
| Yjs update -> CodeMirror dispatch (remote) | <1ms | Delta conversion is trivial |
| Awareness update processing | <0.5ms | Small JSON-like struct |
| Yjs state vector sync (reconnect, 100KB doc) | 5-20ms | One-shot diff computation |
| Yjs state vector sync (reconnect, 500KB doc) | 20-80ms | Larger diff, still single-pass |
| y-codemirror.next extension overhead per transaction | ~0.1ms | Negligible on top of CM transaction cost |
| Memory overhead (100KB LaTeX doc, Yjs state) | 200-400KB | 2-4x CRDT metadata overhead |
| Memory overhead (500KB thesis, Yjs state) | 1-2MB | Well within browser limits |
| Bundle size addition (yjs + y-codemirror + y-protocols + lib0) | ~23KB gzipped | 0.15% of current total (tectonic WASM is ~15MB) |

### Network Performance

| Metric | P2P (WebRTC DataChannel) | WS Relay (via DO) |
|--------|--------------------------|-------------------|
| Latency per keystroke | 10-30ms (same region), 50-150ms (cross-continent) | 30-100ms (same region), 80-200ms (cross-continent) |
| Bandwidth per keystroke | 20-80 bytes | 20-80 bytes + JSON wrapper (~50 bytes overhead) |
| Awareness update size | ~100-200 bytes | ~100-200 bytes + wrapper |
| Initial sync (100KB doc) | 200-400KB one-shot | 200-400KB one-shot |
| Sustained typing (60 WPM, 1 user) | ~3-5 KB/s outbound | ~3-5 KB/s outbound |
| 5 concurrent editors, 60 WPM each | ~15-25 KB/s per peer | ~15-25 KB/s per peer through DO |

### Perceived Latency

For a LaTeX editor, the relevant threshold is ~200ms (beyond which cursor lag becomes noticeable). Both P2P and WS relay comfortably stay under this for same-continent peers. Cross-continent WS relay can approach the threshold during high-latency periods, but Yjs's eventual consistency means the document never corrupts -- the worst case is brief visual stutter.

---

## Cloudflare Usage Estimates

### Durable Object Costs

Pricing model (as of 2025): $0.15/million requests + $12.50/million GB-s duration.

**Per room session (2 peers, 1 hour editing):**

| Metric | Estimate |
|--------|----------|
| WS messages (signaling only, P2P established) | ~50-100 messages (initial handshake + periodic presence) |
| WS messages (full relay, no P2P) | ~10,000-50,000 messages (depends on typing speed) |
| DO wall-clock time (P2P mode, mostly hibernating) | ~5 minutes active, 55 minutes hibernated |
| DO wall-clock time (relay mode) | ~60 minutes active |
| DO memory usage | <100KB |

**Monthly cost estimate for 100 daily active rooms (2-3 peers each):**

| Scenario | Requests | Duration (GB-s) | Monthly Cost |
|----------|----------|-----------------|--------------|
| 80% P2P, 20% relay | ~15M requests | ~500 GB-s | ~$2-4 |
| 100% relay (worst case) | ~150M requests | ~4,000 GB-s | ~$25-50 |

**Key cost insight:** WebSocket Hibernation API is the critical cost saver. When peers go P2P, the DO hibernates and costs essentially nothing. The plan correctly uses `acceptWebSocket` / `webSocketMessage` / `webSocketClose` instead of the legacy `addEventListener` pattern.

### CF Worker Costs (Router)

The router worker handles WebSocket upgrade requests only. One request per peer per room join. Negligible cost (free tier covers 100K requests/day).

### Bandwidth

Cloudflare Workers have no bandwidth charges for WebSocket traffic. The only bandwidth consideration is the initial page load (unchanged from current) and the STUN/signaling traffic (tiny).

### STUN Costs

Cloudflare STUN (`stun:stun.cloudflare.com:3478`) is free. No TURN is planned, so no per-GB relay charges.

**Bottom line:** For a project of this scale (likely <1000 daily active rooms in the foreseeable future), the DO costs are negligible -- well under $10/month for the common case where WebRTC succeeds.

---

## Critical Audit Findings

### CRITICAL: Room Secret Loss on DO Eviction Breaks Share Links Silently

**Severity: Critical**

The room secret lives only in DO memory. The DO evicts after all peers disconnect and the hibernation timeout expires. If a recipient opens a share link after eviction but before the owner reconnects, the DO has no room secret to verify the HMAC token. The plan's response is `ws.close(4002, "Room not initialized")`.

**The problem:** This creates a fundamentally unreliable user experience. The plan says "show a 'waiting for room owner' message" but this is deeply confusing for users. Academic collaborators share links via email/Slack. The recipient may open the link hours or days later. If the owner's tab is closed, the room is dead. There is no indication in the URL that it is expired or that the owner needs to be online.

**Recommendation:** This is the single biggest weakness in the design. Two options:

1. **Accept the limitation explicitly** and design the UX around it: make the share link page show a clear status ("Room is sleeping. The owner needs to be online for you to join.") with an auto-retry every 5s. Document this behavior prominently.
2. **Store `room_secret` in KV with a TTL.** This is a single KV write on room creation and a single KV read on join. TTL of 30 days auto-cleans. This breaks the "no cloud storage" principle but only for a single 32-byte value per room. The plan already acknowledges this as a future mitigation -- it should be Phase 1, not "future."

**My recommendation:** Option 2. A single KV binding for room secrets is minimal infrastructure. The "no storage" principle is admirable but the user experience cost of option 1 is too high for a tool that competes with Overleaf.

### CRITICAL: No Undo Stack Coordination After Yjs Integration

**Severity: Critical**

The current Editor.tsx uses CodeMirror's built-in `history()` extension for undo/redo. When `y-codemirror.next` is integrated, remote changes will be interleaved with local changes in the undo stack. If User A types "hello", then User B types "world" (which arrives via Yjs and is applied to CM), and User A presses Cmd+Z, the undo could revert User B's change instead of User A's.

`y-codemirror.next` addresses this with `yUndoManagerPlugin` which replaces the standard CodeMirror history with a Yjs `UndoManager`. The `UndoManager` tracks only local changes and undoes them correctly in the CRDT.

**The plan's Phase 0 step 3 says:** "Replace manual `EditorView.updateListener` with `y-codemirror.next` extension." But it does not mention replacing `history()` with `yUndoManagerPlugin`.

**Recommendation:** Phase 0 MUST replace `history()` + `historyKeymap` with the Yjs undo manager. If both are active, undo behavior is broken and data corruption (from the user's perspective) is likely.

### HIGH: WebRTC Peer Mesh Does Not Scale Beyond ~5 Peers

**Severity: High**

The plan describes a full mesh: every peer connects to every other peer via a WebRTC DataChannel. For N peers, this means N*(N-1)/2 connections. Each connection maintains STUN bindings, DTLS sessions, and SCTP channels.

| Peers | Connections | Viable? |
|-------|-------------|---------|
| 2 | 1 | Yes |
| 3 | 3 | Yes |
| 5 | 10 | Marginal |
| 10 | 45 | Problematic -- CPU and memory for ICE/DTLS adds up |

For 10 peers (the plan's stated max), each peer maintains 9 DataChannels. Each incoming Yjs update from one peer must be forwarded to 8 others (or rather, Yjs handles this via its own update distribution). The problem is not bandwidth but connection setup cost and browser resource consumption.

**Recommendation:** For >5 peers, fall back to WS relay unconditionally. The DO can handle 10 peers relaying easily. The full mesh is only a latency optimization that becomes a liability at higher peer counts. Add a constant like `MAX_P2P_PEERS = 5` and skip WebRTC when the room has more peers.

### HIGH: Race Condition in Room Creation ("create" message)

**Severity: High**

Two clients could race to send `{ type: "create", room_secret }` simultaneously. The plan says "First peer to create sets the room_secret" with `if (!this.room_secret) { this.room_secret = parsed.room_secret; }`. But the DO processes WebSocket messages sequentially (JavaScript single-threaded), so this is technically safe within a single DO instance.

However, the real race is: what if TWO different users both generate a `room_id` that hashes to the same DO? Room IDs are 8-char base62. That is 62^8 = 218 trillion possible IDs. Collision probability is negligible for practical purposes. But the `create` message should still be authenticated -- currently, ANYONE who knows a room ID can send a `create` message and set the room secret before the real owner.

**Attack scenario:** Attacker guesses or learns a room ID (e.g., from a shared URL). If they connect to the DO before the owner (e.g., owner's tab reloads after DO eviction), the attacker can send `{ type: "create", room_secret: attacker_secret }` and take over the room. All subsequent share link validation uses the attacker's secret.

**Recommendation:** The `create` message should include a proof that the sender generated the original room ID. One approach: the room ID itself is derived from the room secret: `room_id = base62(SHA-256(room_secret)[:6])`. The DO can verify `SHA-256(provided_room_secret)` starts with the known room_id bytes. This prevents an attacker from setting an arbitrary room secret for a room they didn't create. This is a 10-line change.

### HIGH: Hibernation Does Not Preserve Custom In-Memory State

**Severity: High**

The plan states: "DO memory is rebuilt from the WebSocket Hibernation API's stored socket list." This is partially correct. Cloudflare's WebSocket Hibernation preserves WebSocket connections across hibernation/wake cycles. However, it does NOT preserve custom JavaScript state (like `this.peers`, `this.room_secret`). When the DO wakes from hibernation, the constructor re-runs and all instance variables are reset.

The plan acknowledges this ("constructor re-runs, peer map rebuilt from active sockets") and suggests using WebSocket attachment metadata (tags). This is correct -- `state.acceptWebSocket(ws)` can store tags, and `state.getWebSockets(tag?)` retrieves them on wake. But the plan does not detail HOW the room_secret and per-peer permissions survive hibernation.

**Recommendation:** Must be explicit about what goes into WebSocket tags/attachments:
- Each WebSocket gets a tag like `peer:{peer_id}:{permission}` via `state.acceptWebSocket(server, ["peer:abc:w"])`
- The room_secret must be stored via `state.storage.put("room_secret", secret)` -- yes, this requires one storage call, contradicting the "no storage" principle. Alternatively, the room_secret is attached to the owner's WebSocket as metadata.
- On wake: iterate `state.getWebSockets()`, parse tags to rebuild peer map. Retrieve room_secret from the owner's WebSocket metadata or storage.

Without this, the DO loses all permission state on hibernation wake, and every peer would be treated as unauthenticated.

### MEDIUM: Yjs Sync Protocol Over JSON Wrapper is Inefficient

**Severity: Medium**

The signaling protocol wraps Yjs binary updates in JSON messages: `{ type: "yjs-update", data: Uint8Array }`. When sent over WebSocket as a string (JSON.stringify), the `Uint8Array` gets base64-encoded, inflating the payload by ~33%.

For the WS relay fallback path, this means every keystroke's 20-50 byte Yjs update becomes a ~100-150 byte JSON message. At scale (5 peers, 60 WPM each), this adds up unnecessarily.

**Recommendation:** Use binary WebSocket frames for Yjs data. Define a simple binary protocol: first byte = message type (0x01 = yjs-update, 0x02 = yjs-sync, 0x03 = awareness), remaining bytes = payload. Use JSON only for signaling messages (peer-join, signal, etc.). The DO can distinguish binary frames from text frames trivially. This is a ~20-line change and avoids the base64 tax entirely.

### MEDIUM: No Conflict Resolution for File Tree Operations

**Severity: Medium**

The plan syncs file contents via `Y.Text` and mentions file tree sync via `Y.Map` in Phase 3. But the plan does not address what happens when:

1. User A renames `main.tex` to `paper.tex` while User B is editing `main.tex`
2. User A deletes `chapter2.tex` while User B is editing it
3. User A and User B both create a file with the same name simultaneously

Yjs's `Y.Map` handles key-level conflicts (last-write-wins per key), but the semantic conflicts above need application-level handling. For example, if User A deletes a file that User B has open, User B's editor needs to handle the disappearance gracefully.

**Recommendation:** Define explicit behavior for each case:
1. Rename: propagate via Y.Map. If the renamed key matches User B's current file, update `current_file` signal.
2. Delete: propagate via Y.Map. If deleted file is another user's current file, switch them to main_file and show a toast.
3. Simultaneous create: Y.Map's LWW means one version wins. Content merges via Y.Text if both created a Y.Text for the same key. This is actually fine -- document this as expected behavior.

### MEDIUM: The `project_store` Replacement Strategy is Unclear

**Severity: Medium**

Phase 0 says "Replace `project_store.ts` text content with Yjs-backed reactive text." But `project_store` is deeply integrated:
- `App.tsx` creates it and passes it everywhere
- `Toolbar.tsx` uses it for file operations, compile triggers, watch controller
- `Editor.tsx` reads/writes via it
- `local_folder_sync.ts` depends on it for dirty tracking and conflict resolution
- `project_persist.ts` uses its `files` store for OPFS serialization

The plan does not address how `local_folder_sync.ts` interacts with the Yjs-backed store. If the content source of truth moves from `project_store.files` to `Y.Doc`, the folder sync's hash-based dirty tracking and conflict detection need to observe the Yjs doc, not the SolidJS store.

**Recommendation:** Phase 0 should not "replace" `project_store`. Instead, `collab_store` should wrap `project_store` -- the Yjs doc is the content authority, and `project_store` becomes a reactive view of the Yjs state (updated via Y.Doc observers). This preserves all existing integrations. The `update_content` path changes from "CM -> project_store" to "CM -> Yjs -> project_store observer -> SolidJS reactivity." The folder sync continues to work against `project_store.files` without modification.

### MEDIUM: Permission Escalation via WebRTC DataChannel

**Severity: Medium**

The DO enforces read-only permissions by dropping `yjs-update` messages from read-only peers. But when peers establish a WebRTC DataChannel, Yjs updates flow directly peer-to-peer, bypassing the DO entirely. A read-only client with a modified browser/JS could send Yjs updates over the DataChannel directly to a write-permission peer. The receiving peer's Yjs doc would apply them (Yjs has no concept of "authorized" updates).

**Recommendation:** Two options:
1. **Do not establish DataChannels for read-only peers.** The provider should skip WebRTC for peers with `permission: "r"`. Read-only peers receive all updates via the DO WebSocket relay, where the DO can enforce permissions. This is simple but means read-only viewers always go through the DO.
2. **Peers validate incoming DataChannel updates against the sender's permission.** Each peer knows the permission of every other peer (from the peer list). If a peer's permission is "r", drop any Yjs updates received from their DataChannel. This is ~5 lines of code in the DataChannel message handler.

Option 2 is better (lower DO load for read-only viewers who are receiving data) but requires trust in the peer list. Since the peer list comes from the DO (which validates tokens), this is sound.

### LOW: No Rate Limiting During Initial Sync

**Severity: Low**

When a new peer joins a room with a large document (~500KB), the Yjs sync protocol sends the full state as a single update. Over WebSocket relay, this is one large message (up to 2MB with CRDT metadata). The plan mentions the DO's 32 MiB message limit, so the message fits, but there is no backpressure. If 5 peers join simultaneously, the DO broadcasts 5 large sync responses, potentially consuming significant memory briefly.

**Recommendation:** Acceptable for v1. The 128MB DO memory limit and 32 MiB message limit provide natural bounds. For future hardening, consider chunking large sync responses.

### LOW: Deterministic Color Collision

**Severity: Low**

The color hue algorithm produces 37 distinct hues. In a room with >10 users, color collisions are likely (birthday problem: 50% collision at ~8 users for 37 buckets). Two users with the same cursor color is confusing.

**Recommendation:** Increase to 360 hue buckets (one per degree). The current `(Math.abs(hash) % 37) * 10` should just be `Math.abs(hash) % 360`. This is a one-line change.

### LOW: No Graceful Handling of "Owner Reconnect" Race

**Severity: Low**

When the owner reconnects after DO eviction, they re-send the room secret. But if multiple tabs are open with the same `localStorage` identity, multiple "create" messages could arrive. The plan's `if (!this.room_secret)` guard prevents overwriting, but the second tab would be treated as a regular join without a token -- and would fail validation.

**Recommendation:** The "create" message should succeed idempotently: if the provided room_secret matches the one already stored, treat it as a successful owner rejoin. If it doesn't match, reject. This handles both the multi-tab case and the legitimate "owner reconnect" case.

---

## Summary Table

| Finding | Severity | Effort to Fix | Phase Impact |
|---------|----------|---------------|-------------|
| Room secret loss on DO eviction | Critical | Short (KV binding) | Phase 1 |
| No undo stack coordination | Critical | Quick (swap history for yUndoManagerPlugin) | Phase 0 |
| WebRTC mesh >5 peers | High | Quick (add constant, fallback logic) | Phase 2 |
| Room creation race / takeover | High | Short (derive room_id from secret) | Phase 1 |
| Hibernation state loss | High | Short (WebSocket tags + 1 storage call) | Phase 1 |
| Binary protocol for Yjs messages | Medium | Short (~20 lines) | Phase 1 |
| File tree operation conflicts | Medium | Short (define behaviors) | Phase 3 |
| project_store replacement strategy | Medium | Medium (architectural decision) | Phase 0 |
| Permission escalation via WebRTC | Medium | Quick (~5 lines) | Phase 2 |
| No rate limiting during sync | Low | Defer | Future |
| Color collision with 37 hues | Low | Quick (1 line) | Phase 0 |
| Owner reconnect race (multi-tab) | Low | Quick (idempotent create) | Phase 1 |

---

## Overall Assessment

The architecture is well-reasoned and makes good trade-offs for a v1 collaborative editor. The Yjs choice is correct. The transport layering (signaling -> WebRTC -> WS fallback) is sound. The no-account identity model fits the target audience.

The two critical items (room secret persistence and undo stack) are both straightforward to fix and should be addressed before implementation begins. The high-severity items (mesh scaling, room takeover, hibernation state) require design decisions but are each <1 day of work.

Total estimated effort including fixes: ~10-14 days across all 4 phases (original estimate was 7-11 days). The added ~3 days come primarily from KV integration for room secrets, the binary protocol, and proper hibernation state management.
