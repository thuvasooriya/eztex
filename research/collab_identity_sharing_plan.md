# Collaborative Identity & Sharing Architecture for eztex

Addendum to `collab_architecture_plan.md`. Addresses two gaps: user identity model and project sharing via links.

---

## Section 1: User Identity Model

### Recommended approach: anonymous persistent identity via localStorage UUID

No accounts. No email. No passwords. No server-side user database.

A user is a `{ user_id, display_name, color }` triple stored in `localStorage`. That's it.

**Rationale:**

This is a LaTeX editor for developers and academics. The target users have zero tolerance for signup flows that block them from editing. The collaborative model is "share a link, start editing together" -- identical to an Etherpad or a throwaway Google Doc. Real accounts add: a user table, password hashing or OAuth integration, session tokens, account recovery, GDPR compliance -- all for a tool where the user's identity matters only as a colored cursor label.

The identity exists to answer two questions:
1. "Which cursor is mine vs. theirs?" (awareness)
2. "Who generated this share link?" (ownership for permission tokens)

Both are satisfied by a client-side UUID.

**Tradeoffs:**

| Aspect | Anonymous UUID | Real accounts |
|--------|---------------|---------------|
| Time to collaborate | 0 seconds (no modal) | 30+ seconds (signup/login) |
| Server complexity | None | Auth service, user DB, session management |
| Cross-device identity | No (each browser is a new user) | Yes |
| Permission strength | Cryptographic tokens (strong enough) | Server-verified identity (strongest) |
| "Remember me" | localStorage (cleared on data wipe) | Server-side session |

Cross-device identity is the only real loss. An academic opening eztex on their laptop and phone would appear as two users. This is acceptable -- Overleaf requires login for this, but eztex is positioned as the zero-friction alternative.

### Identity data structure

```typescript
// stored in localStorage key: "eztex_identity"
interface UserIdentity {
  user_id: string;       // crypto.randomUUID(), generated once
  display_name: string;  // user-chosen or auto-generated
  color_hue: number;     // deterministic from user_id, stored for consistency
  created_at: number;    // unix timestamp
}
```

**Identity generation (first visit):**

```typescript
function get_or_create_identity(): UserIdentity {
  const stored = localStorage.getItem("eztex_identity");
  if (stored) {
    try { return JSON.parse(stored); } catch {}
  }
  const user_id = crypto.randomUUID();
  const identity: UserIdentity = {
    user_id,
    display_name: generate_name(),  // e.g. "Eager Otter" or "User 7f3a"
    color_hue: hash_to_hue(user_id),
    created_at: Date.now(),
  };
  localStorage.setItem("eztex_identity", JSON.stringify(identity));
  return identity;
}
```

**Deterministic color from user_id** (adapted from Excalidraw's approach):

```typescript
function hash_to_hue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
  }
  // 37 hue buckets * 10 degrees = 370 possible hues across the spectrum
  return (Math.abs(hash) % 37) * 10;
}

function identity_color(hue: number): string {
  return `hsl(${hue}, 70%, 60%)`;
}
```

**Auto-generated display names:**

Use a deterministic adjective-animal generator seeded by the last 4 hex chars of the UUID. Examples: "Quick Fox", "Calm Owl", "Bold Lynx". This avoids the "Anonymous Capybara #4871" pattern that feels throwaway. If the user edits their name, it persists in localStorage.

### The user modal: when and what

**When it appears:** Never automatically. The identity is created silently on first visit.

**Where the user edits their name:** In the `CollabToolbar` component. When collaboration is active (user is in a room), the toolbar shows a small presence indicator with the user's name and colored dot. Clicking the name opens an inline edit field (not a modal). This is the Figma pattern: you don't need a modal, you just let them click their name to change it.

```
+------------------------------------------------------------------+
|  [ez]tex  |  [files] [+] [upload] [download]     [Share] [Build] |
|                                                                   |
|  (collab active)  [*] Quick Fox  |  2 collaborators              |
|                   ^^^ click to edit name                         |
+------------------------------------------------------------------+
```

**Fields:**
- Display name (editable inline, 1-20 chars, stored in localStorage)
- Color dot (auto-assigned, not editable -- prevents two users picking the same color)

**No email, no avatar, no profile picture.** If we later need accounts, we add them as a separate layer on top of this identity. The UUID-based identity continues to work for anonymous users.

### Where identity lives in the architecture

```
Layer               | Identity role
--------------------|-----------------------------------------------
localStorage        | Source of truth: user_id, display_name, color_hue
Yjs awareness       | Broadcasts {user_id, display_name, color_hue, cursor}
                    | to all peers. This is how cursors get names/colors.
collab_provider.ts  | Sends user_id in the "join" message to the DO.
CollabRoom DO       | Stores user_id per WebSocket in its in-memory peer map.
                    | Used ONLY for peer list display -- NOT for permission
                    | checks (permissions are token-based, see Section 2).
CF Worker router    | Validates permission token from URL before upgrading
                    | to WebSocket. Does NOT need to know who the user is,
                    | only whether the token grants read or write access.
```

**Key principle:** Identity is purely informational at every layer except token generation. The DO does not enforce "only user X can edit" -- it enforces "only tokens with write permission can send yjs-update messages." The token is bound to an action (read/write), not to a user. See Section 2 for details.

### How identity integrates with Yjs awareness

The existing plan describes awareness carrying `{ cursor, username, color }`. We refine this:

```typescript
// Set on connect and whenever the user changes their name
awareness.setLocalStateField("user", {
  user_id: identity.user_id,
  name: identity.display_name,
  color_hue: identity.color_hue,
  permission: "write" | "read",  // from the token used to connect
});

// Cursor updates (set on every selection change)
awareness.setLocalStateField("cursor", {
  anchor: selection.anchor,
  head: selection.head,
});
```

The `y-codemirror.next` awareness extension renders remote cursors using the `user.name` and `user.color_hue`. Read-only viewers are rendered with a dimmed/dashed cursor style to distinguish them from editors.

### Ownership model for projects

**Who owns a project?** The user who created the room.

**How is ownership stored?** It isn't stored on any server. Ownership is embedded in the share link token. When a user creates a room and generates share links, the share links are signed with a secret that only the room creator's browser knows. The "owner" is whoever holds the room secret (stored in localStorage alongside the room metadata).

```typescript
// stored in localStorage key: "eztex_rooms"
interface OwnedRoom {
  room_id: string;
  room_secret: string;   // 32-byte random, base64url encoded
  created_at: number;
  display_name: string;  // room label, e.g. "My Thesis"
}
```

**What happens when the owner goes offline?**

Nothing changes. The room continues to function because:
1. The DO is stateless -- it doesn't know or care who the "owner" is
2. All peers have the Yjs document state -- no single point of failure
3. Share links remain valid because they are self-validating tokens (no server lookup)
4. The "owner" privilege is only relevant for generating NEW share links, which requires the room secret

If the owner closes their browser and clears localStorage, they lose the ability to generate new share links. Existing links continue to work. The document continues to exist as long as any peer has it (and Phase 3 IndexedDB persistence means it survives tab closes).

**Ownership transfer:** Not implemented in v1. If needed later, the owner could share the room secret with another user via an encrypted channel (or we add a "transfer ownership" action that sends the room secret through the DO to a specific peer). This is a future concern.

---

## Section 2: Sharing Architecture

### Recommended sharing modes for v1

**Ship these two modes:**

1. **Editable link (default)** -- Anyone with the link can edit. This is the "Google Doc with link sharing" model. Zero friction, maximum utility for the target audience (collaborators on a paper).

2. **Read-only link** -- Anyone with the link can view and compile locally, but cannot edit. For sharing a draft with a reviewer.

**Defer to later:**

- **User-ID-gated links** (only specific users can edit) -- Requires the DO to maintain an allowlist, which contradicts the no-storage constraint. Could be done with capability tokens that embed a user_id claim, but the complexity is not justified for v1. Academics sharing a paper typically want "everyone with the link can edit."
- **Password-protected rooms** -- Similar complexity, similar deferral reasoning.
- **Expiring links** -- Easy to add later (add `exp` field to token), but not needed for v1.

### Share link structure

**URL format:**

```
https://eztex.app/c/{room_id}#{permission}.{signature}
```

Examples:
```
https://eztex.app/c/a1b2c3d4#w.kH9xPq2mN7vR3sT5
https://eztex.app/c/a1b2c3d4#r.Ym4nB8cF6jK1pL0w
```

**Anatomy:**

| Part | Description |
|------|-------------|
| `/c/{room_id}` | Path segment, routed by the app. `room_id` is a short random ID (8-12 chars, base62). |
| `#` | Fragment separator. Everything after `#` is NEVER sent to the server in HTTP requests. |
| `w` or `r` | Permission: `w` = write (edit), `r` = read-only. |
| `.` | Separator between permission and signature. |
| `{signature}` | HMAC-SHA256 truncated to 128 bits, base64url encoded. Signs `room_id + ":" + permission`. |

**Why the hash fragment:**

The permission and signature live after `#` so they are never sent to Cloudflare in the HTTP request. The CF Worker sees only `/c/a1b2c3d4` and returns the SPA. The SPA JavaScript reads `window.location.hash`, extracts the permission and signature, and includes them when opening the WebSocket connection (as a query parameter or in the first message).

This means:
- Server logs never contain permission tokens
- CDN/proxy caches never see the token
- The token is visible only to the browser and the DO (via WebSocket message)

### Permission enforcement mechanism

**The core constraint:** The DO has no persistent storage and cannot look up permissions in a database.

**Solution: HMAC-signed capability tokens verified by the CF Worker.**

The system uses a shared HMAC secret stored as a Cloudflare Worker environment secret (`ROOM_HMAC_SECRET`). This secret is available to both the CF Worker (router) and the Durable Object (since DOs run within the worker context).

**Token creation (client-side):**

Wait -- if the secret is server-side, how does the client create tokens?

The client doesn't create tokens directly. The flow is:

1. Room creator's browser calls a token-generation endpoint on the CF Worker
2. The CF Worker signs the token with the HMAC secret
3. The CF Worker returns the signed token to the browser
4. The browser constructs the share URL with the token in the hash fragment

```
POST /api/token
Body: { room_id: "a1b2c3d4", permission: "w", room_secret: "..." }

Response: { token: "w.kH9xPq2mN7vR3sT5" }
```

**But wait -- how does the CF Worker know the caller is the room owner?**

The room owner proves ownership by presenting the `room_secret` (the 32-byte random value generated when the room was created). The CF Worker flow:

1. Owner creates a room: browser generates `room_id` + `room_secret`
2. Owner registers the room: `POST /api/room { room_id, room_secret_hash }` -- the CF Worker stores `SHA-256(room_secret)` as a tag on the Durable Object (using WebSocket attachment metadata, NOT persistent storage)

Actually, this introduces state. Let me rethink.

**Revised approach: fully stateless HMAC tokens.**

The room creator generates the HMAC tokens themselves, but needs the server's HMAC secret to do so. This is a chicken-and-egg problem. Let's solve it differently:

**The room secret IS the HMAC key.**

Each room has its own HMAC key (the `room_secret`), generated by the room creator's browser. The room creator can produce share tokens because they hold the room secret. The CF Worker/DO does NOT need the room secret to validate tokens -- instead, we use a different scheme:

**Final approach: Ed25519 room keypair (simplest self-validating model)**

Actually, asymmetric crypto is overkill. Let me simplify further.

**ACTUAL final approach: the room secret is the validation key, passed to DO on first connect.**

Here's the clean design:

1. **Room creator** generates:
   - `room_id`: 8 chars, base62 random
   - `room_secret`: 32 bytes, crypto.getRandomValues, base64url encoded

2. **Room creator connects** to the DO with a special "owner" token that includes the room_secret hash. The DO stores `sha256(room_secret)` in its in-memory state.

3. **Room creator generates share links** locally:
   - `token = base64url(HMAC-SHA256(room_secret, room_id + ":" + permission))`
   - No server call needed. The browser has the room_secret.

4. **Recipient opens share link:**
   - Browser extracts `permission` and `token` from the URL hash
   - Browser connects to DO WebSocket: `wss://eztex.app/ws/{room_id}?perm={permission}&token={token}`
   - DO receives the connection. It has `sha256(room_secret)` in memory (from the owner's initial connection). It recomputes `HMAC-SHA256(room_secret, room_id + ":" + permission)` -- wait, it doesn't have `room_secret`, only the hash.

This still doesn't work without the DO knowing the room_secret. Let me accept the simplest correct design:

**SIMPLEST CORRECT DESIGN: DO holds room_secret in memory, validates HMAC.**

```
1. Owner creates room:
   - Browser generates room_id + room_secret
   - Browser stores both in localStorage
   - Browser connects to DO: first message is { type: "create", room_id, room_secret }
   - DO stores room_secret in memory (Map<room_id, room_secret>)
   - This is IN-MEMORY ONLY. When DO evicts, room_secret is lost.

2. Owner generates share link:
   - token = HMAC-SHA256(room_secret, room_id + ":" + permission)
   - URL: https://eztex.app/c/{room_id}#{permission}.{base64url(token)}
   - All computed client-side. No server call.

3. Recipient opens link:
   - Connects to DO WebSocket
   - First message: { type: "join", permission, token }
   - DO verifies: recompute HMAC-SHA256(room_secret, room_id + ":" + permission)
   - If match: accept connection with stated permission
   - If no match: reject WebSocket

4. DO restarts/evicts and loses room_secret:
   - Next owner reconnect: first message includes room_secret again
   - DO re-stores it. Existing share tokens continue to validate.
   - If owner never reconnects: the DO cannot validate tokens.
     Recipients who were already connected stay connected (DO preserves
     WebSocket state across hibernation). New recipients cannot join
     until the owner reconnects.
```

**The "DO loses room_secret" edge case:**

This happens when: all peers disconnect, DO hibernates, DO evicts (minutes to hours later), then a new recipient tries to join before the owner.

Mitigation: The owner's browser auto-reconnects (Phase 3 reconnection logic). As long as the owner has a tab open, the DO has the room_secret. If the owner closes their tab, the room is effectively orphaned until the owner returns. This is acceptable for v1 -- the room is only useful when people are actively editing.

For hardening in the future: store the room_secret in a Cloudflare KV binding (breaking the no-storage constraint, but only for this one value). This is a one-line change and can be deferred.

**HMAC implementation in the browser (Web Crypto API):**

```typescript
async function create_share_token(
  room_secret: string,  // base64url encoded 32 bytes
  room_id: string,
  permission: "r" | "w"
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64url_decode(room_secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = new TextEncoder().encode(`${room_id}:${permission}`);
  const sig = await crypto.subtle.sign("HMAC", key, message);
  // truncate to 128 bits (16 bytes) for shorter URLs
  const truncated = new Uint8Array(sig).slice(0, 16);
  return `${permission}.${base64url_encode(truncated)}`;
}
```

**HMAC verification in the DO:**

```typescript
async function verify_share_token(
  room_secret: string,
  room_id: string,
  permission: string,
  token_sig: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64url_decode(room_secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const message = new TextEncoder().encode(`${room_id}:${permission}`);
  const sig_bytes = base64url_decode(token_sig);
  // recompute full HMAC and compare first 16 bytes
  const full_sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message)
  );
  const truncated = full_sig.slice(0, 16);
  // constant-time comparison
  if (truncated.length !== sig_bytes.length) return false;
  let diff = 0;
  for (let i = 0; i < truncated.length; i++) {
    diff |= truncated[i] ^ sig_bytes[i];
  }
  return diff === 0;
}
```

**Security notes:**
- 128-bit HMAC truncation provides 2^128 brute-force resistance -- more than sufficient
- The room_secret never leaves the owner's browser and the DO's memory
- Share tokens are not time-limited in v1 (adding `exp` field is trivial later)
- A compromised share link cannot be used to generate new share links with different permissions (HMAC is not invertible)
- The DO performs constant-time comparison to prevent timing attacks

### Read-only Yjs client design

**The problem:** In read-only mode, the client should receive all Yjs document updates (to see the live document) but should NOT be able to modify the document.

**Enforcement layers:**

1. **Server-side (DO):** The DO tracks each peer's permission (`"r"` or `"w"`) from the validated token. When a read-only peer sends a `yjs-update` message, the DO drops it silently. This is the authoritative enforcement.

2. **Client-side (provider):** The custom `collab_provider.ts` skips registering the `doc.on('update', sendUpdate)` handler when permission is `"r"`. This prevents the client from even attempting to send local edits. However, client-side enforcement alone is insufficient (a modified client could bypass it), so the DO must also enforce.

3. **Client-side (editor):** CodeMirror is set to read-only mode, preventing the user from typing. See next subsection.

**What the read-only provider does:**

```typescript
class CollabProvider {
  private permission: "r" | "w";

  connect(doc: Y.Doc, permission: "r" | "w") {
    this.permission = permission;

    // ALWAYS listen for remote updates (both read and write)
    // (applied via the WebSocket/DataChannel message handler)

    // ONLY register the local update broadcaster for write permission
    if (permission === "w") {
      doc.on("update", (update, origin) => {
        if (origin !== this) {  // don't echo back received updates
          this.broadcast_update(update);
        }
      });
    }

    // Awareness: ALWAYS send awareness updates (both read and write)
    // Read-only viewers should still show their presence
    awareness.on("update", ({ added, updated, removed }) => {
      this.broadcast_awareness(awareness.encodeUpdate([...added, ...updated, ...removed]));
    });
  }
}
```

**DO-side enforcement:**

```typescript
// In CollabRoom.webSocketMessage handler:
async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
  const peer = this.peers.get(ws);
  if (!peer) return;

  if (typeof msg === "string") {
    const parsed = JSON.parse(msg);
    switch (parsed.type) {
      case "yjs-update":
        // DROP updates from read-only peers
        if (peer.permission === "r") return;
        this.broadcast_binary(msg, ws);
        break;
      case "awareness":
        // Allow awareness from all peers (read-only viewers show presence)
        this.broadcast_binary(msg, ws);
        break;
      // ... signal messages unchanged
    }
  }
}
```

**Yjs sync protocol messages and read-only:**

The Yjs sync protocol has three message types (from `y-protocols/sync.js`):
- `messageYjsSyncStep1` (type 0): state vector request -- read-only clients SHOULD send this (to receive the document)
- `messageYjsSyncStep2` (type 1): state diff response -- read-only clients SHOULD receive this (initial sync)
- `messageYjsUpdate` (type 2): incremental update -- read-only clients MUST NOT send this, but SHOULD receive

The DO can parse the first byte of binary Yjs messages to distinguish sync steps from updates:
- Allow types 0 and 1 from read-only clients (they need to sync)
- Drop type 2 from read-only clients (they cannot write)

In practice, since we wrap Yjs binary messages in our own JSON protocol (`{ type: "yjs-update" }` vs `{ type: "yjs-sync" }`), the DO can make this decision at the wrapper level without parsing Yjs internals.

### Read-only CodeMirror integration

**CodeMirror 6 has a `readOnly` facet** in `@codemirror/state`:

```typescript
import { EditorState, Compartment } from "@codemirror/state";

const read_only_compartment = new Compartment();

// Initial setup
const state = EditorState.create({
  extensions: [
    read_only_compartment.of(EditorState.readOnly.of(permission === "r")),
    // ... other extensions including y-codemirror
  ],
});
```

**Critical question: does `y-codemirror.next` still apply remote updates when the editor is read-only?**

Yes. Based on reading the `y-codemirror.next` source (`y-sync.js`):

- Remote Yjs changes are applied via a Yjs text observer (`this._ytext.observe(...)`) that calls `view.dispatch({ changes, annotations: [ySyncAnnotation.of(this.conf)] })`. This dispatch is NOT blocked by `readOnly` because it is a programmatic dispatch with the `ySyncAnnotation`, not a user input transaction.
- Local CodeMirror changes are pushed to Yjs via the `update()` method, which checks `if (!update.docChanged || ...)`. When the editor is read-only, no local changes are generated, so this path is never triggered.

**Result:** The `y-codemirror.next` binding works correctly in read-only mode without modification. Remote changes flow in; no local changes flow out.

**Dynamic read-only toggling** (for future use, e.g., if permission changes mid-session):

```typescript
// To toggle read-only at runtime:
view.dispatch({
  effects: read_only_compartment.reconfigure(
    EditorState.readOnly.of(true)
  ),
});
```

### Awareness behavior for read-only viewers

Read-only viewers SHOULD be visible in the presence list and SHOULD show their cursor position to editors. Rationale:
- The editor wants to know "is anyone watching my document right now?"
- A reviewer (read-only) scrolling through the document provides useful context to the editor
- Hiding read-only viewers would make them invisible, which is creepy

**Visual distinction:** Read-only viewer cursors/names are rendered with a modified style:
- Cursor line: dashed instead of solid
- Name label: includes a "(viewing)" suffix or a small eye icon
- Color: same deterministic color as if they were editing (no special color treatment)

```typescript
// In awareness rendering (y-codemirror.next configuration):
awareness.setLocalStateField("user", {
  user_id: identity.user_id,
  name: identity.display_name,
  color_hue: identity.color_hue,
  permission: "r",  // <-- used by cursor renderer to style differently
});
```

**Can a read-only viewer trigger their own local compile?** Yes. Compilation is entirely local (tectonic WASM in a Web Worker). The read-only viewer has the full Yjs document content and can compile at will. The compile button should be available in read-only mode.

### Share link generation UI

The "Share" button in the toolbar opens a small popover (not a modal):

```
+------------------------------------------+
|  Share this project                       |
|                                           |
|  [Copy edit link]      [Copy view link]   |
|                                           |
|  Anyone with the edit link can edit.      |
|  Anyone with the view link can only read. |
+------------------------------------------+
```

Two buttons. Each copies a URL to the clipboard. No further configuration needed for v1.

The owner's browser generates both tokens (one with `permission: "w"`, one with `permission: "r"`) using the room_secret from localStorage, and constructs the full URLs.

If the user is NOT the room owner (they joined via a share link), the Share button is hidden or shows only the link they already have.

### Who generates share links and how (summary)

1. Room creator's browser generates `room_id` and `room_secret` (32 bytes, `crypto.getRandomValues`)
2. Both stored in `localStorage` under `eztex_rooms` key
3. Owner connects to DO, sends `room_secret` in the first message
4. Owner clicks "Share" -> browser computes HMAC tokens for both permissions
5. URLs constructed with token in hash fragment
6. Recipient opens URL -> extracts token from hash -> sends to DO on connect -> DO validates with stored room_secret

No server-side token generation endpoint needed. No database. No KV store. The only server-side state is the room_secret held in the DO's memory for the duration of the room's lifetime.

---

## Section 3: Updated Architecture Additions

### New/modified components in the Layer Breakdown

| Layer | Component | Lives In | Notes |
|-------|-----------|----------|-------|
| **Identity** | `identity_store.ts` | Main thread (localStorage) | Generates/persists user_id, name, color. New file. |
| **Sharing** | `share_tokens.ts` | Main thread (Web Crypto) | HMAC token creation/verification. New file. |
| **Sharing UI** | `SharePopover.tsx` | Main thread (SolidJS) | Share button popover with copy-link buttons. New component. |
| **Presence UI** | Inline in `CollabToolbar.tsx` | Main thread (SolidJS) | User name display, edit-in-place, peer list. Updated. |
| **Permission gate** | In `collab_provider.ts` | Main thread | Controls whether local Yjs updates are broadcast. Updated. |
| **DO auth** | In `collab_room.js` | Cloudflare edge | Validates HMAC tokens on join, enforces r/w on messages. Updated. |
| **Read-only mode** | In `Editor.tsx` | Main thread | CodeMirror readOnly facet, driven by connection permission. Updated. |

### Updated data flow: sharing lifecycle

```
1. OWNER creates a room
   |
   +-- Browser: room_id = random_base62(8)
   +-- Browser: room_secret = crypto.getRandomValues(32 bytes)
   +-- Browser: store { room_id, room_secret } in localStorage
   +-- Browser: connect WS to /ws/{room_id}
   +-- Browser -> DO: { type: "create", room_secret }
   +-- DO: store room_secret in memory, mark this WS as owner + write permission
   |
2. OWNER clicks "Share" -> "Copy edit link"
   |
   +-- Browser: token = HMAC-SHA256(room_secret, room_id + ":w")[:16]
   +-- Browser: url = "https://eztex.app/c/{room_id}#w.{base64url(token)}"
   +-- Browser: navigator.clipboard.writeText(url)
   |
3. RECIPIENT opens the link
   |
   +-- Browser: SPA loads from /c/{room_id} (CF Worker serves index.html)
   +-- Browser: parse hash -> permission = "w", token_sig = "..."
   +-- Browser: connect WS to /ws/{room_id}
   +-- Browser -> DO: { type: "join", peer_id, name, permission: "w", token: "..." }
   +-- DO: verify HMAC-SHA256(room_secret, room_id + ":w")[:16] == token
   +-- DO: if valid -> accept, add peer with write permission
   +-- DO: if invalid -> close WebSocket with code 4001
   |
4. POST-JOIN (write permission)
   |
   +-- Yjs sync step 1/2 exchange (same as base plan)
   +-- Local edits -> Yjs updates -> broadcast to peers (same as base plan)
   +-- Awareness broadcasts include permission field
   |
5. POST-JOIN (read permission)
   |
   +-- Yjs sync step 1/2 exchange (receives full document)
   +-- Local edits blocked by CodeMirror readOnly facet
   +-- collab_provider skips doc.on('update') registration
   +-- DO drops any yjs-update messages from this peer (defense in depth)
   +-- Awareness broadcasts include permission: "r"
   +-- Local compile works normally (reads from Yjs doc)
```

### New/updated signaling protocol messages

```typescript
// Updated Client -> DO messages
type ClientMsg =
  | { type: "create"; room_secret: string }                    // NEW: room creation
  | { type: "join"; peer_id: string; name: string;
      permission: "r" | "w"; token: string }                   // UPDATED: adds permission + token
  | { type: "signal"; to: string; data: RTCSignalData }        // unchanged
  | { type: "awareness"; data: Uint8Array }                    // unchanged
  | { type: "yjs-update"; data: Uint8Array }                   // unchanged (DO enforces permission)
  | { type: "yjs-sync"; data: Uint8Array }                     // NEW: separated from yjs-update
                                                                // for sync step 1/2 (allowed for read-only)

// Updated DO -> Client messages
type ServerMsg =
  | { type: "peers"; peers: Array<{ id: string; name: string;
      permission: "r" | "w" }> }                               // UPDATED: includes permission
  | { type: "peer-join"; peer: { id: string; name: string;
      permission: "r" | "w" } }                                // UPDATED: includes permission
  | { type: "peer-leave"; peer_id: string }                    // unchanged
  | { type: "signal"; from: string; data: RTCSignalData }      // unchanged
  | { type: "awareness"; from: string; data: Uint8Array }      // unchanged
  | { type: "yjs-update"; from: string; data: Uint8Array }     // unchanged
  | { type: "yjs-sync"; from: string; data: Uint8Array }       // NEW
  | { type: "error"; code: number; message: string }           // NEW: auth failures etc.
```

### Updated DO implementation sketch

```typescript
export class CollabRoom {
  state: DurableObjectState;
  peers: Map<WebSocket, { id: string; name: string; permission: "r" | "w" }> = new Map();
  room_secret: string | null = null;  // held in memory only

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const parsed = JSON.parse(msg as string);

    switch (parsed.type) {
      case "create": {
        // First peer to create sets the room_secret
        if (!this.room_secret) {
          this.room_secret = parsed.room_secret;
        }
        // Owner joins with implicit write permission
        this.peers.set(ws, { id: parsed.peer_id, name: parsed.name, permission: "w" });
        this.broadcast_peer_list();
        break;
      }
      case "join": {
        // Validate HMAC token
        if (!this.room_secret) {
          // No owner has connected yet -- reject
          ws.close(4002, "Room not initialized");
          return;
        }
        const valid = await verify_share_token(
          this.room_secret, this.room_id, parsed.permission, parsed.token
        );
        if (!valid) {
          ws.close(4001, "Invalid token");
          return;
        }
        this.peers.set(ws, { id: parsed.peer_id, name: parsed.name, permission: parsed.permission });
        this.broadcast_peer_list();
        break;
      }
      case "yjs-update": {
        const peer = this.peers.get(ws);
        if (!peer || peer.permission === "r") return;  // drop silently
        this.broadcast_to_others(ws, msg);
        break;
      }
      case "yjs-sync": {
        // Sync steps allowed from all peers (needed for initial doc load)
        this.broadcast_to_others(ws, msg);
        break;
      }
      case "awareness": {
        // Awareness allowed from all peers
        this.broadcast_to_others(ws, msg);
        break;
      }
      // ... signal messages unchanged
    }
  }
}
```

---

## Section 4: Implementation Phases (Addendum)

### How identity/sharing items map to existing phases

**Phase 0 (Yjs integration, no networking) -- add:**
- Create `identity_store.ts`: generate and persist anonymous UUID identity
- Wire identity into the `y-codemirror.next` awareness configuration (name + color)
- No sharing in Phase 0 (single-user)

**Phase 1 (WebSocket relay via DO) -- add:**
- Create `share_tokens.ts`: HMAC token generation and verification using Web Crypto
- Update DO protocol: add `create`/`join` with token validation
- Add `SharePopover.tsx` component: generates edit + read-only links
- Add read-only detection: parse URL hash on page load, pass permission to `collab_provider.ts`
- Add CodeMirror read-only facet when permission is "r"
- Update `collab_provider.ts`: skip `doc.on('update')` for read-only
- Update DO: drop `yjs-update` messages from read-only peers
- Add presence display in `CollabToolbar.tsx`: peer count, names, edit-name-in-place
- Separate `yjs-sync` from `yjs-update` in the protocol (read-only needs sync, not update)

**Phase 2 (WebRTC P2P) -- add:**
- WebRTC DataChannel connections should carry the permission level
- Write peers get bidirectional DataChannels
- Read-only peers get receive-only DataChannels (the write peer doesn't listen for Yjs updates from them)
- This is mostly transparent -- the `collab_provider` already knows the permission

**Phase 3 (Resilience) -- add:**
- Owner reconnection: on reconnect, re-send `room_secret` to DO (restores token validation)
- Handle the "DO evicted, owner not back yet" case gracefully (show "waiting for room owner" message to new joiners)
- Store `eztex_rooms` data in IndexedDB alongside Yjs persistence (more durable than localStorage)

### New tasks summary

| Task | Phase | Effort | Dependencies |
|------|-------|--------|-------------|
| `identity_store.ts` | 0 | Quick (1-2 hours) | None |
| Identity in awareness config | 0 | Quick (30 min) | identity_store.ts |
| `share_tokens.ts` | 1 | Short (3-4 hours) | None |
| DO token validation | 1 | Short (2-3 hours) | share_tokens.ts |
| `SharePopover.tsx` | 1 | Short (2-3 hours) | share_tokens.ts |
| Read-only provider logic | 1 | Short (1-2 hours) | collab_provider.ts |
| Read-only CM facet | 1 | Quick (30 min) | Editor.tsx |
| DO read-only enforcement | 1 | Short (1 hour) | DO update |
| Protocol split (sync vs update) | 1 | Short (1-2 hours) | Protocol design |
| Presence UI in toolbar | 1 | Short (2-3 hours) | identity_store.ts |
| WebRTC permission-aware channels | 2 | Short (1-2 hours) | Phase 2 base |
| Owner reconnection logic | 3 | Short (1-2 hours) | Phase 3 base |

**Total added effort:** ~2-3 days spread across phases 0-3. The identity/sharing work roughly doubles the Phase 1 effort (from 2-3 days to 4-5 days).

### Honest assessment: does this meaningfully complicate the base architecture?

**Moderately, but it's manageable.**

The base architecture is clean: stateless DO, Yjs sync, WebRTC upgrade. Adding identity and sharing introduces:

1. **HMAC token management** -- new crypto code, but it's ~100 lines of well-understood Web Crypto API usage. No external dependencies.

2. **Permission state in the DO** -- the DO now tracks permission per peer and makes routing decisions (drop vs forward). This is ~30 lines of logic on top of the existing message handler.

3. **Room secret lifecycle** -- the DO holds a secret in memory that must survive hibernation (via WebSocket attachment tags) and be re-provisioned if the DO evicts. This is the trickiest part and the main source of edge cases.

4. **Read-only mode** -- surprisingly simple. CodeMirror's readOnly facet works out of the box with y-codemirror.next. The provider change is one `if` statement.

The biggest risk is not complexity but **the room_secret lifecycle**. If we get this wrong, share links break silently. The mitigation is clear error messages ("Room not available -- the owner may need to reconnect") and eventual KV persistence if the edge case proves annoying in practice.

---

## Section 5: Open Questions

### Decisions requiring more information

1. **Should the owner link differ from the edit link?**
   Currently, the owner connects with `{ type: "create", room_secret }` and everyone else connects with `{ type: "join", token }`. The owner's URL is just `https://eztex.app/c/{room_id}` with the room_secret in localStorage. But what if the owner opens the link on a different device? They'd need a special "owner link" that embeds the room_secret. Is this needed, or is single-device ownership acceptable for v1?

   **Recommendation:** Single-device ownership for v1. The owner link is just the room URL. The room_secret stays in localStorage. If needed later, add an "owner link" that embeds the room_secret (encrypted or raw) for multi-device ownership.

2. **What happens when the room has zero connected peers for an extended period?**
   The DO evicts, room_secret is lost, and share links become temporarily unusable until the owner reconnects. Should we add a KV store for room_secret persistence? This breaks the "no cloud storage" principle but solves a real usability issue.

   **Recommendation:** Defer KV persistence. In practice, a room with zero peers is a room nobody is using. When the owner comes back, they reconnect and the room_secret is re-provisioned. If user feedback shows this is a problem, add KV with a 30-day TTL.

3. **Should read-only viewers be able to fork the project?**
   A read-only viewer has the full Yjs document. They could "fork" it into a new room where they are the owner. This is a nice feature for reviewers who want to suggest edits. Should we support this?

   **Recommendation:** Not in v1, but keep the architecture compatible. Forking is just "create new room, load Yjs state from existing doc." The identity/sharing model doesn't need changes.

4. **Do users actually want/need read-only links?**
   For academic collaboration, the common case is "everyone edits." Read-only is useful for sharing with a supervisor who should only review, but many supervisors would want to make edits too. Is read-only v1-critical or can it be deferred?

   **Recommendation:** Implement it in v1 because the incremental cost is low (most of the sharing infrastructure is shared) and it rounds out the feature. But if time-constrained, it's the first thing to cut.

### Weakest points of this design

1. **Room secret in DO memory is fragile.** If the DO evicts and the owner isn't connected, the room is unusable until the owner returns. This is the single biggest weakness. Mitigation: auto-reconnect (Phase 3) makes owner absence short-lived in practice.

2. **No revocation of share links.** Once a share link is generated, it works forever (until the DO evicts and the owner doesn't come back). There's no way to "revoke" a link without changing the room_secret (which invalidates ALL links). This is acceptable for a collaborative editor among known collaborators, but would be a problem for a public-facing tool.

3. **Client-side identity is trivially spoofable.** A malicious user can change their localStorage UUID and display_name to impersonate another user's cursor. This only affects awareness display (colored cursors/names), not permissions. The HMAC tokens are the real access control, and those are not spoofable.

4. **No audit trail.** There's no record of who edited what. Yjs stores the operations but doesn't associate them with user IDs (unless you use Yjs's attribution manager, which is experimental). For academic collaboration, this might matter (e.g., tracking contributions).

5. **Single-room model.** The current design assumes one room per project, one project per eztex session. Multi-project rooms or project switching within a collab session is not designed. This is fine for v1 but will need revisiting.
