# Wave 2: Remote Real-Time Collaboration

Task ID: `ses_1e9362f08ffe78oVgw2ByjnB5r`

Repository: `/Users/tony/arc/dev/eztex`

Implementation target: WebSocket-only remote collaboration using Cloudflare Workers and Durable Objects.

---

## Executive Summary

Wave 2 adds real-time remote collaboration to eztex projects. The implementation builds on Wave 0 and Wave 1: local project state is already Yjs-backed, OPFS v2 persistence exists, multi-project routing exists, and the editor is bound to `Y.Text` through CodeMirror/Yjs integration.

Wave 2 introduces a Cloudflare Durable Object room authority and a browser-side Yjs WebSocket provider. A user can create a collaboration room for a local project, generate read/write capability links, and invite other users to edit or view the same project in real time. The transport is WebSocket-only for v1. WebRTC is explicitly out of scope.

The Durable Object is not a dumb relay. It is the authority for room creation, HMAC token authentication, read/write permission enforcement, persisted room metadata, compacted Yjs snapshots, WebSocket hibernation recovery, and room cleanup after inactivity.

---

## 1. Scope

### In Scope

1. Cloudflare Durable Object room authority.
2. Worker routes for room creation and WebSocket upgrade.
3. HMAC capability token authentication using per-room secrets.
4. Client-side share link generation for write/read access.
5. Client-side WebSocket provider for Yjs sync and awareness.
6. Anonymous identity persisted in `localStorage`.
7. Remote cursors/presence through Yjs awareness.
8. Read-only mode enforced on both server and client.
9. Yjs snapshot persistence in Durable Object Storage.
10. Durable Object hibernation recovery using Storage and WebSocket attachments.
11. Room cleanup alarm after 7 days of inactivity.
12. Minimal UI for Share, copy write link, copy read link, connected peers, and local identity name.

### Out Of Scope

1. WebRTC or peer-to-peer transport.
2. User accounts, OAuth, email invites, or server user database.
3. Per-user ACLs beyond capability tokens.
4. Token revocation UI.
5. Password-protected rooms.
6. End-to-end encryption.
7. Server-side LaTeX compilation.
8. Remote binary blob storage beyond the Yjs project state required for text collaboration.
9. MCP/agent collaboration.

### Numbered Phases

1. **Phase 2.1: Worker/DO Foundation**
   Add Durable Object bindings, route WebSocket requests, create room authority class, and keep existing bundle CORS proxy routes working.

2. **Phase 2.2: Protocol + Persistence**
   Implement framed binary protocol, Yjs sync handling, snapshot persistence, HMAC validation, WebSocket attachment restoration, and cleanup alarms.

3. **Phase 2.3: Client Provider**
   Implement browser WebSocket provider that connects a local `Y.Doc` and awareness instance to a room.

4. **Phase 2.4: Sharing + Identity UI**
   Add anonymous identity, share link creation, read/write link copy actions, and presence display.

5. **Phase 2.5: Read-Only UX + Verification**
   Enforce read-only mode in provider, editor, and server; test late join, hibernation recovery, reconnection, and invalid tokens.

---

## 2. Existing Infrastructure

### Worker

Current worker directory:

```txt
worker/
  index.js
  wrangler.toml
```

Current `wrangler.toml`:

```toml
name = "eztex-cors-proxy"
main = "index.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "ASSETS"
bucket_name = "eztex-assets"
preview_bucket_name = "eztex-assets"
```

Current worker behavior:

1. Serves `/bundle`, `/index.gz`, and `/formats/*`.
2. Handles CORS preflight.
3. Uses R2 bucket binding `ASSETS`.
4. Must continue to serve all existing bundle routes.

### App

Current app assumptions after Wave 0 and Wave 1:

1. SolidJS + Vite.
2. CodeMirror 6 editor.
3. Yjs-backed project store.
4. `store.ydoc()` returns the current `Y.Doc`.
5. `store.awareness()` or equivalent returns a Yjs `Awareness` instance.
6. `store.get_ytext(path)` returns a file `Y.Text`.
7. `store.snapshot_files()` produces compile/export files.
8. OPFS v2 multi-project persistence exists.
9. URL routing supports `?project=<project_id>`.

If `store.awareness()` does not exist yet, add it in Wave 2 before provider integration.

---

## 3. Architecture

### High-Level Flow

```txt
Owner browser
  -> create room id + room secret
  -> connect WebSocket with create message and initial Yjs snapshot
  -> generate write/read links locally from room secret

Guest browser
  -> open /c/<room_id>#<permission>.<signature>
  -> parse token from URL fragment
  -> connect WebSocket
  -> Durable Object validates token
  -> DO sends persisted Yjs state
  -> live Yjs sync + awareness begins
```

### Durable Object Responsibilities

1. Store room secret in DO Storage.
2. Store room metadata in DO Storage.
3. Store compacted Yjs snapshot in DO Storage.
4. Authenticate joins using HMAC capability tokens.
5. Track per-WebSocket permission using serialized attachments.
6. Reject document update frames from read-only peers.
7. Relay allowed sync/awareness frames.
8. Apply document updates to in-memory `Y.Doc`.
9. Debounce snapshot persistence.
10. Recover state after hibernation.
11. Schedule cleanup alarm after 7 days of no peers.

### Client Provider Responsibilities

1. Connect local `Y.Doc` and `Awareness` to a room WebSocket.
2. Encode/decode framed protocol messages.
3. Run Yjs sync protocol.
4. Send/receive awareness updates.
5. Reconnect with backoff.
6. Surface connection status to UI.
7. Respect read-only permission locally.
8. Destroy cleanly on project switch/page unload.

---

## 4. URL Structure

### Share URLs

Canonical collaboration URL:

```txt
https://eztex.app/c/<room_id>#<permission>.<signature>
```

Examples:

```txt
https://eztex.app/c/r_abcd1234#w.NpfXn6wTJGSqNR2xXZxPmw
https://eztex.app/c/r_abcd1234#r.qI1n5CBhV8A8s2dnYpP93Q
```

### Token Fragment

The fragment is never sent in the initial HTTP request. The browser reads `window.location.hash` and sends the token only over the WebSocket join message.

Format:

```txt
#<permission>.<signature>
```

Permissions:

1. `w`: write/edit access.
2. `r`: read-only access.

Signature:

```txt
base64url(HMAC-SHA256(room_secret, room_id + ":" + permission))[0..16]
```

Use a 128-bit truncated HMAC for compact URLs.

### Route Behavior

| URL | Behavior |
|-----|----------|
| `/` | Existing Wave 1 project behavior |
| `/?project=<project_id>` | Existing Wave 1 project behavior |
| `/c/<room_id>#w.<sig>` | Join room as writer |
| `/c/<room_id>#r.<sig>` | Join room as read-only viewer |

When a user joins `/c/<room_id>`, the app should create or reuse a local OPFS project mapped to `room_id`. The local project id remains separate from the remote room id.

---

## 5. Cloudflare Worker Requirements

### Wrangler Configuration

Update `worker/wrangler.toml`.

Required additions:

```toml
compatibility_date = "2024-04-05"

[[durable_objects.bindings]]
name = "COLLAB_ROOM"
class_name = "CollabRoom"

[[migrations]]
tag = "v1-collab-room"
new_classes = ["CollabRoom"]
```

Notes:

1. Compatibility date must support Durable Object WebSocket hibernation APIs.
2. Keep existing R2 binding `ASSETS`.
3. Keep worker name unless deployment strategy intentionally changes it.

### Worker Routes

Existing bundle routes must continue to work.

Add routes:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/collab/health` | Collab health check |
| `GET` | `/collab/ws/<room_id>` | WebSocket upgrade to room DO |
| `OPTIONS` | `/collab/*` | CORS preflight if needed |

The Worker should route by path before falling through to existing bundle-serving logic.

### WebSocket Upgrade Handler

```ts
async function handleCollabWebSocket(request: Request, env: Env, room_id: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const id = env.COLLAB_ROOM.idFromName(room_id);
  const room = env.COLLAB_ROOM.get(id);
  return room.fetch(request);
}
```

Room IDs are used as Durable Object names. This guarantees all clients for one room land in the same DO instance.

---

## 6. Durable Object Room Authority

### Class Shape

Create `CollabRoom` in `worker/index.js` or a new module imported by `index.js`.

```ts
export class CollabRoom {
  constructor(state: DurableObjectState, env: Env);
  fetch(request: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  webSocketError(ws: WebSocket, error: unknown): Promise<void>;
  alarm(): Promise<void>;
}
```

If using module-worker Durable Object class syntax with `DurableObject`, follow Cloudflare’s current API for the configured compatibility date.

### Stored Room Metadata

Storage keys:

```ts
const ROOM_META_KEY = "room-meta";
const YDOC_SNAPSHOT_KEY = "ydoc-snapshot";
const LAST_COMPACTED_AT_KEY = "last-compacted-at";
```

Metadata:

```ts
type RoomMetadata = {
  version: 1;
  room_id: string;
  room_secret: string;        // base64url encoded 32-byte secret
  created_at: number;
  updated_at: number;
  last_active_at: number;
  owner_peer_id?: string;
  closed?: boolean;
};
```

Important: the DO must store `room_secret`, not only a hash. HMAC verification requires the secret key.

### WebSocket Attachment

Persist per-connection state through hibernation.

```ts
type PeerAttachment = {
  peer_id: string;
  permission: "read" | "write";
  identity: UserIdentity;
  joined_at: number;
};
```

On accepted join:

```ts
ws.serializeAttachment(peerAttachment);
```

On constructor wake:

```ts
for (const ws of this.ctx.getWebSockets()) {
  const attachment = ws.deserializeAttachment();
  if (attachment) this.peers.set(ws, attachment);
}
```

### Constructor Recovery

On constructor:

1. Initialize `peers = new Map()`.
2. Load `room-meta` from DO Storage.
3. Load `ydoc-snapshot` from DO Storage if present.
4. Create in-memory `Y.Doc` and apply snapshot.
5. Rebuild peers from `ctx.getWebSockets()` attachments.
6. Set WebSocket auto response for ping/pong if supported.

### Room Creation

First message from owner:

```ts
type CreateRoomMessage = {
  type: "create";
  room_id: string;
  room_secret: string;
  peer_id: string;
  identity: UserIdentity;
  initial_state: ArrayBuffer;
};
```

Rules:

1. `room_secret` must be 32 random bytes, base64url encoded.
2. If room does not exist, create it.
3. If room exists and `room_secret` matches stored secret, allow owner reconnect.
4. If room exists and secret does not match, close with code `4403`.
5. Store `room-meta` and `ydoc-snapshot`.
6. Attach peer with `permission: "write"`.
7. Send `created` ack.

Ack:

```ts
type CreatedMessage = {
  type: "created";
  room_id: string;
  snapshot_applied: true;
};
```

### Room Join

Join message:

```ts
type JoinRoomMessage = {
  type: "join";
  room_id: string;
  token: string;              // "w.<sig>" or "r.<sig>"
  peer_id: string;
  identity: UserIdentity;
};
```

Join rules:

1. Room must exist and not be closed.
2. Parse permission from token prefix.
3. Verify HMAC using stored room secret.
4. Attach peer permission.
5. Send `joined` ack with permission and current snapshot.
6. Broadcast awareness peer list update if needed.

Ack:

```ts
type JoinedMessage = {
  type: "joined";
  room_id: string;
  permission: "read" | "write";
  snapshot: ArrayBuffer;
};
```

### Close Codes

Use app-specific close codes:

| Code | Meaning |
|------|---------|
| `4400` | Bad request / malformed message |
| `4401` | Missing token |
| `4403` | Invalid token or permission denied |
| `4404` | Room not found |
| `4409` | Room already exists with different secret |
| `4410` | Room closed |
| `4429` | Rate limited |
| `4500` | Server error |

---

## 7. Capability Tokens

### Room ID Generation

Client generates room ids:

```ts
function create_room_id(): string {
  return `r_${random_base62(12)}`;
}
```

Use at least 72 bits of entropy. UUID-based ids are also acceptable:

```ts
`r_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
```

### Room Secret Generation

```ts
function create_room_secret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}
```

The owner browser stores room secret locally so it can generate additional links later.

Local storage key:

```txt
eztex_owned_rooms
```

Value:

```ts
type OwnedRoom = {
  room_id: string;
  project_id: string;
  room_secret: string;
  created_at: number;
  name: string;
};
```

### Token Creation

```ts
export async function create_share_token(
  room_secret: Uint8Array,
  room_id: string,
  permission: "r" | "w",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    room_secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`${room_id}:${permission}`);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return `${permission}.${base64url_encode(sig.slice(0, 16))}`;
}
```

### Token Verification In DO

```ts
async function verify_share_token(
  room_secret_b64: string,
  room_id: string,
  token: string,
): Promise<"read" | "write" | null> {
  const [permission, sig_b64] = token.split(".");
  if (permission !== "r" && permission !== "w") return null;

  const room_secret = base64url_decode(room_secret_b64);
  const expected = await hmac_truncated(room_secret, `${room_id}:${permission}`);
  const actual = base64url_decode(sig_b64);
  if (!constant_time_equal(actual, expected)) return null;

  return permission === "w" ? "write" : "read";
}
```

### Revocation

V1 has no per-token revocation.

V1 mitigation:

1. Room owner can close room.
2. New room can be created with a new secret.
3. Existing old links cannot join a closed room.

Future v2:

1. Add token version to HMAC payload.
2. Store room token version in DO Storage.
3. Increment to revoke all old tokens.

---

## 8. WebSocket Protocol

### Control Messages

Control messages are JSON strings.

```ts
type ClientControlMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | { type: "ping" };

type ServerControlMessage =
  | CreatedMessage
  | JoinedMessage
  | { type: "pong" }
  | { type: "error"; code: string; message: string }
  | { type: "peer-count"; count: number };
```

### Binary Frames

All Yjs protocol messages are sent as binary frames with a one-byte frame kind prefix.

```ts
export const enum FrameKind {
  SyncStep1 = 0,
  SyncStep2 = 1,
  DocUpdate = 2,
  Awareness = 3,
}
```

Frame layout:

```txt
byte 0: frame kind
byte 1..n: y-protocol payload
```

TypeScript helpers:

```ts
export type DecodedFrame = {
  kind: FrameKind;
  payload: Uint8Array;
};

export function encode_frame(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function decode_frame(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < 1) throw new Error("empty frame");
  return { kind: bytes[0] as FrameKind, payload: bytes.slice(1) };
}
```

### Permission Rules

| Frame | Read Peer | Write Peer | DO Behavior |
|-------|-----------|------------|-------------|
| `SyncStep1` | send/receive | send/receive | allowed |
| `SyncStep2` | receive only preferred, send allowed if harmless | send/receive | allowed |
| `DocUpdate` | receive only | send/receive | reject/drop from read peers |
| `Awareness` | send/receive | send/receive | allowed |

Server-side enforcement is authoritative. Client-side read-only mode is UX only.

### Snapshot Persistence

The DO maintains an in-memory `Y.Doc`.

On accepted write peer `DocUpdate`:

1. Apply update to in-memory doc.
2. Broadcast to all other peers.
3. Debounce persistence.

Persistence interval:

1. Save after 2 seconds of quiet.
2. Also save after every 100 accepted document updates.
3. Also save on last peer disconnect when possible.

Persisted snapshot:

```ts
const snapshot = Y.encodeStateAsUpdate(roomDoc);
await storage.put(YDOC_SNAPSHOT_KEY, snapshot);
await storage.put(LAST_COMPACTED_AT_KEY, Date.now());
```

---

## 9. Client WebSocket Provider

Create a provider module in the app.

Recommended file:

```txt
app/src/lib/collab_provider.ts
```

### Provider API

```ts
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

export type CollabPermission = "read" | "write";
export type CollabStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface CollabProviderOptions {
  room_id: string;
  token: string;
  doc: Y.Doc;
  awareness: Awareness;
  identity: UserIdentity;
  ws_url: string;
  initial_permission?: CollabPermission;
  on_status?: (status: CollabStatus) => void;
  on_permission?: (permission: CollabPermission) => void;
  on_error?: (message: string) => void;
}

export interface CollabProvider {
  status(): CollabStatus;
  permission(): CollabPermission | null;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

export function create_collab_provider(opts: CollabProviderOptions): CollabProvider;
```

### Provider Responsibilities

1. Open WebSocket to `/collab/ws/<room_id>`.
2. Send `join` control message after socket opens.
3. Decode `joined` response and apply snapshot to local doc.
4. Start Yjs sync protocol.
5. Listen for local Yjs updates and send `DocUpdate` only if permission is write.
6. Listen for local awareness updates and send `Awareness` frames.
7. Apply remote document updates to local doc.
8. Apply remote awareness updates to awareness instance.
9. Reconnect on abnormal close with exponential backoff.
10. Stop reconnecting after explicit `destroy()`.

### Yjs Sync Integration

Use `y-protocols/sync` and `lib0/encoding`/`lib0/decoding`.

Required behaviors:

1. On connect, send sync step 1.
2. On receiving sync step 1, respond with sync step 2.
3. On receiving sync step 2, apply it.
4. On local doc update, send doc update frame when writable.

Pseudo-code:

```ts
doc.on("update", (update, origin) => {
  if (origin === providerOrigin) return;
  if (permission !== "write") return;
  send_frame(FrameKind.DocUpdate, update);
});
```

### Awareness Integration

Use `y-protocols/awareness`.

```ts
awareness.setLocalStateField("user", {
  user_id: identity.user_id,
  name: identity.display_name,
  color: identity.color,
  color_hue: identity.color_hue,
  permission,
});
```

On awareness update:

```ts
const update = encodeAwarenessUpdate(awareness, changedClients);
send_frame(FrameKind.Awareness, update);
```

On remote awareness frame:

```ts
applyAwarenessUpdate(awareness, payload, providerOrigin);
```

### Reconnection

Backoff:

```ts
const delays = [500, 1000, 2000, 5000, 10000];
```

Rules:

1. Reconnect on network close unless closed by `destroy()`.
2. Do not reconnect on `4401`, `4403`, `4404`, or `4410`.
3. On reconnect, send same join token.
4. After reconnect, run sync protocol again.

---

## 10. Share Link Generation

Recommended file:

```txt
app/src/lib/collab_share.ts
```

### API

```ts
export interface CreatedRoomLinks {
  room_id: string;
  room_secret: string;
  write_url: string;
  read_url: string;
}

export async function create_room_links(project_id: string, project_name: string): Promise<CreatedRoomLinks>;

export async function create_share_url(
  room_id: string,
  room_secret_b64: string,
  permission: "r" | "w",
): Promise<string>;

export function parse_collab_url(url: URL): { room_id: string; token: string } | null;
```

### Room Creation Flow

Owner flow:

1. Generate `room_id`.
2. Generate `room_secret`.
3. Store owned room metadata in `localStorage`.
4. Connect provider in create mode or send `create` control message before normal join.
5. Send current `Y.encodeStateAsUpdate(store.ydoc())` as `initial_state`.
6. Generate write/read URLs locally.
7. Show copy buttons.

### Local Storage

```ts
type OwnedRoomsFile = {
  version: 1;
  rooms: OwnedRoom[];
};

type OwnedRoom = {
  room_id: string;
  project_id: string;
  room_secret: string;
  created_at: number;
  name: string;
};
```

Key:

```txt
eztex_owned_rooms
```

---

## 11. Anonymous Identity

Recommended file:

```txt
app/src/lib/identity.ts
```

### Types

```ts
export interface UserIdentity {
  user_id: string;
  display_name: string;
  color_hue: number;
  color: string;
  created_at: number;
}
```

### Storage

Key:

```txt
eztex_identity
```

### API

```ts
export function get_or_create_identity(): UserIdentity;
export function update_display_name(name: string): UserIdentity;
export function identity_color(hue: number): string;
```

### Name Generation

Generate stable friendly names such as:

```txt
Quick Fox
Calm Owl
Bold Lynx
Bright Heron
```

Use deterministic adjective/animal selection seeded from `user_id` so a fresh identity gets a consistent default name.

### Color Generation

```ts
function hash_to_hue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
  }
  return (Math.abs(hash) % 37) * 10;
}

function identity_color(hue: number): string {
  return `hsl(${hue}, 70%, 60%)`;
}
```

### UI Requirements

1. Identity is created silently on first use.
2. No signup modal.
3. When connected, show display name and color dot.
4. Allow inline display-name edit.
5. Persist name changes to localStorage and awareness.

---

## 12. Read-Only Mode

### Server Enforcement

The DO must reject or drop `DocUpdate` frames from read-only peers.

```ts
if (frame.kind === FrameKind.DocUpdate && peer.permission !== "write") {
  return;
}
```

The DO may still allow read peers to send:

1. `SyncStep1`.
2. `SyncStep2` if required by protocol.
3. `Awareness`.

### Client Enforcement

When permission is read:

1. Set editor read-only mode.
2. Disable file create/delete/rename UI.
3. Disable upload/merge actions.
4. Disable compile only if compile mutates project state; local compile from read-only source can remain allowed.
5. Provider must not send local doc updates.
6. Awareness should mark permission as `read`.

### CodeMirror Read-Only

Use CodeMirror facets/extension:

```ts
EditorState.readOnly.of(true)
EditorView.editable.of(false)
```

Implementation requirement:

1. Add a read-only signal to app state.
2. Pass read-only state into `Editor`.
3. Reconfigure editor state when permission changes.

### Store Mutations

For read-only remote rooms, UI should not call mutating store methods. Server enforcement is still required because clients are not trusted.

---

## 13. UI Requirements

### Share Button

Add collaboration controls to toolbar.

Minimum UI:

1. `Share` button.
2. If room inactive: create room and show links.
3. If room active: show connection status, copy write link, copy read link.
4. Show peer count.
5. Show current user identity name/color.

### Presence

Minimum presence UI:

1. Current connected peers count.
2. Optional list of names/colors.
3. Remote cursors rendered through `y-codemirror.next` awareness support.

### Join Flow UI

When opening `/c/<room_id>#...`:

1. Parse token.
2. Create or open local project mapped to room id.
3. Connect provider.
4. Show `Connecting...` state.
5. On success, show project editor.
6. On invalid token, show error with no editor mutation.
7. On read-only token, show read-only badge.

---

## 14. App Integration

### Store Requirements

Project store must expose:

```ts
ydoc(): Y.Doc;
awareness(): Awareness;
project_id(): string;
room_id?: () => string | undefined;
set_room_id?: (room_id: string) => void;
```

If missing, add minimal methods.

### Project Metadata

When a local project is attached to a room:

1. Store `room_id` in project metadata.
2. Store mapping in OPFS manifest/catalog if Wave 1 supports it.
3. Do not replace local `ProjectId` with `RoomId`.

### Provider Lifecycle

Provider should be owned at app/project runtime level.

Rules:

1. Create provider after project Yjs doc is loaded.
2. Destroy provider before project switch/reload.
3. Destroy provider on component cleanup.
4. Do not create multiple providers for the same project/room in one tab.

---

## 15. Acceptance Criteria

### Worker/DO

1. Existing `/bundle`, `/index.gz`, and `/formats/*` routes still work.
2. `wrangler deploy` succeeds.
3. `/collab/health` returns JSON health response.
4. WebSocket upgrade to `/collab/ws/<room_id>` works.
5. DO persists `room-meta` and `ydoc-snapshot`.
6. DO reconstructs peers from WebSocket attachments after hibernation.
7. DO alarm deletes inactive room storage after 7 days.

### Auth + Sharing

1. Owner can create a room from current project.
2. Owner can copy write link.
3. Owner can copy read link.
4. Invalid token is rejected.
5. Read token joins as read-only.
6. Write token joins as writer.
7. Token is in URL fragment, not query string.

### Collaboration

1. Two browsers can edit the same text file and converge.
2. Remote edits appear without reload.
3. File switching remains correct.
4. Remote cursors/presence appear for connected peers.
5. A late joiner receives current Yjs state from DO snapshot.
6. Joining after all peers disconnect still restores last persisted snapshot.

### Read-Only

1. Read-only editor cannot type.
2. Read-only UI cannot create/delete/rename/upload files.
3. If a malicious read-only client sends `DocUpdate`, DO drops it.
4. Read-only clients can still receive updates and send awareness.

### Persistence

1. DO persists compacted snapshot after edits.
2. Browser OPFS local project remains usable after reload.
3. Room reconnect syncs local and remote Yjs state without duplicating content.

### Build

1. `bun run build` succeeds in `app/`.
2. Worker syntax/type checks pass using project’s existing worker workflow.

---

## 16. Testing Plan

### Local App Build

```sh
cd app
bun run build
```

### Worker Development

Use Wrangler from `worker/`.

```sh
cd worker
wrangler dev
```

Do not use `npm` or `npx`; use existing project tooling or `bunx wrangler` if Wrangler is not installed.

### Manual Collaboration Matrix

1. Open owner tab.
2. Create room.
3. Copy write link.
4. Open write link in second browser/profile.
5. Edit same file from both sides.
6. Verify convergence.
7. Copy read link.
8. Open read link in third browser/profile.
9. Verify read-only cannot type.
10. Verify read-only sees updates.
11. Close all tabs.
12. Reopen read/write link.
13. Verify persisted snapshot loads.

### Token Tests

1. Change one character in signature; join fails.
2. Change permission prefix from `r` to `w`; join fails.
3. Use token for different room id; join fails.
4. Missing fragment; show helpful error.

### Hibernation Recovery Tests

1. Connect peers.
2. Idle long enough for hibernation in Wrangler/cloud environment if practical.
3. Send message after idle.
4. Verify DO constructor rebuilds peer attachments.
5. Verify no duplicate peers or lost permissions.

### Read-Only Malicious Test

Add a temporary debug action or test client that sends a `DocUpdate` frame after joining with read token.

Expected result:

1. DO does not apply update.
2. Other clients do not receive update.
3. Optional server log records rejected frame.

---

## 17. Deployment Notes

### Cloudflare Compatibility

Durable Object WebSocket hibernation requires the hibernation API:

1. Use `ctx.acceptWebSocket(server)` rather than `server.accept()`.
2. Use `ctx.getWebSockets()` in constructor.
3. Use `serializeAttachment()` and `deserializeAttachment()`.
4. Avoid timers that prevent hibernation.
5. Use alarms for cleanup instead of long `setTimeout`.

### Existing Worker Routes

Do not regress bundle serving.

Before deploy, verify:

1. `GET /health`
2. `GET /index.gz`
3. `GET /bundle` with Range header
4. `GET /formats/<known-format>`
5. `GET /collab/health`

### CORS And WebSocket Origins

Allowed app origins should include:

1. `http://localhost:5173`
2. `http://localhost:3000`
3. `https://eztex.pages.dev`
4. Any production custom domain when added.

WebSocket upgrade should validate `Origin` where possible. Reject unknown origins in production.

### Cleanup Alarm

Room cleanup policy:

1. When last peer disconnects, store `last_active_at = Date.now()`.
2. Schedule alarm for 7 days later.
3. On alarm, if peers exist, do nothing and clear alarm.
4. On alarm, if `Date.now() - last_active_at >= 7 days`, delete all room storage.
5. If room is closed by owner, delete storage immediately or mark closed and schedule deletion.

---

## 18. Files To Modify

### Worker

```txt
worker/wrangler.toml
worker/index.js
```

Optional split files if build setup supports it:

```txt
worker/collab_room.js
worker/collab_protocol.js
```

### App

Recommended new files:

```txt
app/src/lib/collab_provider.ts
app/src/lib/collab_protocol.ts
app/src/lib/collab_share.ts
app/src/lib/identity.ts
```

Likely modified files:

```txt
app/src/App.tsx
app/src/components/Editor.tsx
app/src/components/Toolbar.tsx
app/src/lib/project_store.ts
app/src/lib/project_persist.ts
app/src/lib/project_manager.ts
app/src/lib/register_commands.ts
```

---

## 19. Risk Mitigation

### Risk: DO Becomes Dumb Relay

Problem: late joiners cannot recover state if no peers are online.

Mitigation:

1. DO must maintain in-memory Y.Doc.
2. DO must persist compacted snapshot.
3. Join response must include current snapshot.

### Risk: Read-Only Bypass

Problem: malicious client sends Yjs update despite read-only UI.

Mitigation:

1. Server checks frame kind and peer permission.
2. Drop/reject `DocUpdate` from read peers.
3. Add explicit malicious client test.

### Risk: Hibernation Loses Peer State

Problem: DO memory resets during hibernation.

Mitigation:

1. Store room metadata in DO Storage.
2. Store per-WebSocket permission/identity in attachment.
3. Rebuild peer map from `ctx.getWebSockets()`.

### Risk: Snapshot Persistence Too Frequent

Problem: every keystroke writes DO Storage.

Mitigation:

1. Debounce snapshot writes.
2. Save after quiet period or update count threshold.
3. Save on last disconnect when practical.

### Risk: Token Leakage

Problem: capability token appears in logs or referrers.

Mitigation:

1. Keep token in URL fragment.
2. Do not put token in query string.
3. Send token in first WebSocket message.
4. Avoid logging token.

### Risk: Worker Bundle Routes Regress

Problem: collab routing breaks existing TeX bundle proxy.

Mitigation:

1. Add collab routes narrowly under `/collab/*`.
2. Preserve existing route order and fallback behavior.
3. Test bundle/index/formats before deploy.

---

## Final Implementation Guidance

Prefer minimal, explicit code.

Use WebSocket + Durable Objects only. Do not introduce WebRTC.

Treat the Durable Object as the room authority, not only as a relay.

Keep local project id and remote room id separate.

Enforce read-only permissions on the server even if the UI already disables editing.

Persist compacted Yjs snapshots in DO Storage so late joiners and post-hibernation reconnects work.

Keep existing app single-user and multi-project behavior unchanged when collaboration is not active.
