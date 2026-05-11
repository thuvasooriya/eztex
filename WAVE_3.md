# Wave 3: Agent Collaboration via WebSocket Peer

Task ID: `ses_1e9362f08ffe78oVgw2ByjnB5r`

Repository: `/Users/tony/arc/dev/eztex`

Implementation target: LLM agents join existing collaboration rooms as first-class WebSocket/Yjs peers, with safe write controls and a human review flow.

---

## Executive Summary

Wave 3 adds agent collaboration on top of the completed Wave 2 remote collaboration stack. The key architectural decision is to treat agents as collaboration peers first, not as a browser-hosted MCP server. An agent receives a room capability token, connects to the same Cloudflare Durable Object room as human collaborators, reads project state through Yjs sync, and proposes or applies edits through Yjs transactions.

This wave should not introduce a full MCP sidecar, WebRTC, accounts, or server-side compilation. The goal is a minimal but robust agent path that reuses existing room auth, Yjs sync, awareness, read-only/write permissions, and project persistence. The browser UI should show agent presence distinctly, support review-before-apply for large edits, and protect active user work from accidental overwrites.

Chosen as Wave 3 because:

1. Wave 2 remote rooms now provide the necessary transport, auth, and persistence.
2. Agent collaboration was the next planned high-impact dependency after remote collaboration.
3. It exercises the same distributed editing model as humans, reducing architectural branching.
4. Local folder bidirectional sync and Pierre polish can follow independently after the core agent path exists.

---

## 1. Scope

### In Scope

1. Agent identity type and awareness presence.
2. Agent WebSocket/Yjs collaborator protocol using existing Wave 2 room auth.
3. Agent-safe project read API over Yjs state.
4. Agent write API that applies Yjs transactions with origin labels.
5. Optional review mode for agent patches before applying to live project state.
6. Browser UI for agent sessions, pending changes, accept/reject actions, and compile-after-agent-change controls.
7. Server-side distinction for agent peers in Durable Object attachment metadata.
8. Rate limits and message-size limits for agent peers.
9. Basic agent client reference implementation for testing, preferably as a small TypeScript module/script.
10. Tests/manual verification for concurrent user + agent edits.

### Out Of Scope

1. Full MCP server or local sidecar.
2. Hosted MCP-over-HTTP service.
3. WebRTC.
4. User accounts or OAuth.
5. Agent billing, model provider integration, or prompt orchestration.
6. Server-side LaTeX compilation.
7. Local folder bidirectional sync.
8. Pierre library integration unless a tiny native diff fallback is insufficient.
9. Long-term audit log beyond Yjs transaction origins and current review UI.

### Numbered Phases

1. **Phase 3.1: Agent Peer Protocol**
   Extend Wave 2 room/control metadata to identify peers as `human` or `agent`, add agent attachment fields, and define agent capability expectations.

2. **Phase 3.2: Agent Client Adapter**
   Implement a reusable TypeScript client adapter that joins a room, syncs Yjs state, lists files, reads files, and submits edits.

3. **Phase 3.3: Agent Transaction Safety**
   Add base-state checks, transaction labels, size limits, and compile debounce integration.

4. **Phase 3.4: Review UI**
   Add pending agent change UI with accept/reject, per-file previews, and explicit apply to live Yjs doc.

5. **Phase 3.5: Verification + Hardening**
   Test concurrent human/agent edits, read-only agent rejection, reconnect behavior, and room persistence.

---

## 2. Existing Infrastructure

### Completed Waves

Wave 0:

1. Yjs CRDT project foundation.
2. CodeMirror `yCollab` editor binding.
3. BroadcastChannel same-origin multi-tab sync.

Wave 1:

1. Multi-project OPFS v2 persistence.
2. Project switcher UI.
3. URL routing with `?project=<project_id>`.

Wave 2:

1. Cloudflare Durable Object collaboration rooms.
2. HMAC read/write share links.
3. Client WebSocket provider.
4. Awareness/presence.
5. Read-only server/client enforcement.
6. DO Yjs snapshot persistence and hibernation recovery.

### App Capabilities Assumed

The app should expose or be able to expose:

```ts
store.ydoc(): Y.Doc;
store.awareness(): Awareness;
store.project_id(): ProjectId;
store.room_id(): RoomId | undefined;
store.get_ytext(path: string): Y.Text;
store.snapshot_files(): Promise<ProjectFiles>;
```

The Wave 2 provider should expose current collaboration state:

```ts
provider.status(): CollabStatus;
provider.permission(): "read" | "write" | null;
provider.room_id(): string;
provider.peer_id(): string;
```

If any of these exact methods differ, implement Wave 3 adapters rather than rewriting Wave 0-2 code.

---

## 3. Architecture Decision

### Decision: Agent As WebSocket Collaborator

Agent path:

```txt
Agent runtime
  -> WebSocket/Yjs provider
  -> Durable Object room authority
  -> shared Yjs project
  -> browser UI updates through existing editor/store bindings
```

Do not build this path:

```txt
Browser page -> MCP server hosted inside browser
```

A normal browser page cannot reliably host a local MCP server for desktop agents. MCP remains a future Wave 7 concern. Wave 3 should keep the tool contract compatible with future MCP, but the transport is the Wave 2 room protocol.

### Agent Modes

Wave 3 supports two modes:

1. **Direct Apply Mode**
   Agent writes directly to the shared Yjs document using write permission. Use for small edits and tests.

2. **Review Mode**
   Agent submits proposed changes into a local pending-change store. Human user accepts/rejects before live Yjs mutation. Use as default for multi-file or large edits.

Default: Review Mode for any agent change touching more than one file or replacing more than 500 characters.

---

## 4. Agent Identity And Awareness

### Identity Types

Extend Wave 2 identity shape.

```ts
export type PeerKind = "human" | "agent";

export interface UserIdentity {
  user_id: string;
  display_name: string;
  color_hue: number;
  color: string;
  created_at: number;
  kind?: PeerKind;
}

export interface AgentIdentity extends UserIdentity {
  kind: "agent";
  agent_id: string;
  agent_name: string;
  runtime?: "local" | "remote" | "test";
}
```

### Agent Identity Generation

Agent identities should be explicit, not silently reused from the human browser identity.

```ts
export function create_agent_identity(agent_name: string, runtime?: AgentIdentity["runtime"]): AgentIdentity;
```

Suggested defaults:

1. `display_name`: `agent_name`, e.g. `Claude`, `Codex`, `Local Agent`.
2. `kind`: `agent`.
3. `color_hue`: deterministic from `agent_id`.
4. `runtime`: `local` for local scripts, `test` for development fixtures.

### Awareness State

Agents publish awareness like humans, with additional fields.

```ts
awareness.setLocalStateField("user", {
  user_id: identity.user_id,
  name: identity.display_name,
  color: identity.color,
  color_hue: identity.color_hue,
  permission,
  kind: "agent",
  agent_id: identity.agent_id,
  runtime: identity.runtime,
});
```

Optional agent activity field:

```ts
awareness.setLocalStateField("agent", {
  status: "idle" | "reading" | "editing" | "waiting-review" | "compiling",
  label?: string,
  current_file?: string,
});
```

### UI Requirements

1. Agent peers must be visually distinct from human peers.
2. Presence list shows agent name and status.
3. Remote cursor labels should include agent name.
4. If an agent is in review mode, show `waiting review` status.

---

## 5. Durable Object Requirements

Wave 3 should minimally extend the Wave 2 Durable Object without changing its core room auth behavior.

### Peer Attachment

Extend peer attachment:

```ts
type PeerAttachment = {
  peer_id: string;
  permission: "read" | "write";
  identity: UserIdentity | AgentIdentity;
  kind: "human" | "agent";
  joined_at: number;
};
```

Rules:

1. Human clients may omit `kind`; default to `human`.
2. Agent clients must send `kind: "agent"` in identity or join metadata.
3. Store attachment with `serializeAttachment()` so hibernation recovery preserves agent identity and permission.

### Join Message Extension

Wave 2 join:

```ts
type JoinRoomMessage = {
  type: "join";
  room_id: string;
  token: string;
  peer_id: string;
  identity: UserIdentity;
};
```

Wave 3 compatible extension:

```ts
type JoinRoomMessage = {
  type: "join";
  room_id: string;
  token: string;
  peer_id: string;
  identity: UserIdentity | AgentIdentity;
  peer_kind?: "human" | "agent";
  client_name?: string;
  client_version?: string;
};
```

### Agent Limits

Add server-side guardrails for agent peers.

```ts
const MAX_AGENT_FRAME_BYTES = 512 * 1024;
const MAX_AGENT_UPDATES_PER_MINUTE = 120;
```

Rules:

1. Reject oversized frames from any peer with close code `4400` or drop with error message.
2. Rate-limit agent document update frames more strictly than human frames.
3. Read-only agents follow same read-only rejection as humans.
4. Do not inspect or transform Yjs update contents server-side beyond frame type, size, permission, and rate.

### Server Error Message

```ts
type ServerErrorMessage = {
  type: "error";
  code: "rate_limited" | "frame_too_large" | "permission_denied" | "bad_request";
  message: string;
};
```

---

## 6. Agent Client Adapter

Recommended new file:

```txt
app/src/lib/agent_collaborator.ts
```

If an external test script is needed, add:

```txt
tools/agent-collab-smoke.ts
```

### API

```ts
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

export type AgentMode = "direct" | "review";

export interface AgentCollaboratorOptions {
  room_id: string;
  token: string;
  ws_url: string;
  identity: AgentIdentity;
  mode?: AgentMode;
  on_status?: (status: AgentStatus) => void;
  on_error?: (message: string) => void;
}

export type AgentStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reading"
  | "editing"
  | "waiting-review"
  | "closed"
  | "error";

export interface AgentCollaborator {
  doc: Y.Doc;
  awareness: Awareness;
  connect(): void;
  disconnect(): void;
  listFiles(): string[];
  readFile(path: string): string | Uint8Array | null;
  writeFile(path: string, content: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  applyPatch(path: string, patch: TextPatch, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  createFile(path: string, content: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  deleteFile(path: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  renameFile(from: string, to: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  snapshotFiles(): ProjectFiles;
}

export interface AgentWriteOptions {
  label?: string;
  base_state_vector?: string;
  mode?: AgentMode;
}

export type AgentWriteResult =
  | { ok: true; applied: true; transaction_id: string }
  | { ok: true; applied: false; review_id: string }
  | { ok: false; error: string };
```

### Tool Contract Compatibility

Keep method names compatible with future MCP tools:

```ts
type ExtexAgentTools = {
  listFiles(): string[];
  readFile(path: string): string | Uint8Array | null;
  writeFile(path: string, content: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  applyPatch(path: string, patch: TextPatch, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  createFile(path: string, content: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  deleteFile(path: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
  renameFile(from: string, to: string, opts?: AgentWriteOptions): Promise<AgentWriteResult>;
};
```

Do not implement MCP transport in Wave 3.

---

## 7. Project Model For Agent Reads/Writes

### Required Yjs Access Helpers

Agent code needs schema helpers, not ad hoc map mutation.

If not already exported, add helpers to `y_project_doc.ts` or a small wrapper:

```ts
export function list_project_paths(doc: Y.Doc): string[];
export function read_project_file(doc: Y.Doc, path: string): string | Uint8Array | null;
export function get_project_ytext(doc: Y.Doc, path: string): Y.Text | null;
export function create_or_get_project_ytext(doc: Y.Doc, path: string): Y.Text;
export function delete_project_file(doc: Y.Doc, path: string): boolean;
export function rename_project_file(doc: Y.Doc, from: string, to: string): boolean;
```

### Text Edits

For full file replacement:

```ts
doc.transact(() => {
  const ytext = create_or_get_project_ytext(doc, path);
  ytext.delete(0, ytext.length);
  ytext.insert(0, content);
}, { kind: "agent", label, transaction_id });
```

For patch application:

```ts
export type TextPatch = {
  from: number;
  to: number;
  insert: string;
}[];
```

Apply patches from end to start to preserve offsets:

```ts
for (const change of [...patch].sort((a, b) => b.from - a.from)) {
  ytext.delete(change.from, change.to - change.from);
  ytext.insert(change.from, change.insert);
}
```

### Binary Files

Wave 3 agent writes are text-first.

Rules:

1. Agents may read binary metadata and binary bytes if already in project snapshot.
2. Agents must not create or modify binary files in Wave 3 unless the existing BlobStore API is already safe and content-addressed.
3. Agent `writeFile()` with `Uint8Array` should return `{ ok: false, error: "binary writes not supported in Wave 3" }`.

### Base State Checks

Agent writes should include an optional state vector.

```ts
export function encode_state_vector_base64(doc: Y.Doc): string;
export function has_state_advanced_since(doc: Y.Doc, base_state_vector: string): boolean;
```

Rules:

1. If `base_state_vector` is missing, allow small direct edits but route large edits to review mode.
2. If doc advanced since `base_state_vector`, route to review mode or return conflict.
3. Never overwrite concurrent human edits blindly in direct mode.

---

## 8. Review Mode

### Purpose

Review mode lets an agent propose changes without immediately mutating the live shared document.

### Pending Change Types

Recommended new file:

```txt
app/src/lib/agent_review.ts
```

Types:

```ts
export type AgentReviewStatus = "pending" | "accepted" | "rejected" | "stale";

export interface AgentReviewChange {
  path: string;
  before: string;
  after: string;
  patch?: TextPatch;
}

export interface AgentReview {
  id: string;
  agent_id: string;
  agent_name: string;
  label: string;
  created_at: number;
  base_state_vector: string;
  status: AgentReviewStatus;
  changes: AgentReviewChange[];
}
```

### Review Store API

```ts
export interface AgentReviewStore {
  reviews(): AgentReview[];
  pending(): AgentReview[];
  add(review: AgentReview): void;
  accept(id: string, doc: Y.Doc): AgentWriteResult;
  reject(id: string): void;
  mark_stale(id: string): void;
  clear_completed(): void;
}
```

### Accept Behavior

When accepting a review:

1. Check base state vector if possible.
2. If target files changed, mark stale and ask user to re-run agent or force apply.
3. Apply each change in one Yjs transaction.
4. Transaction origin should be `{ kind: "agent-review", review_id, agent_id, label }`.
5. Trigger normal provider broadcast through Yjs update flow.

### Reject Behavior

Reject only updates review state. It must not mutate project Yjs document.

### UI Requirements

1. Show badge/count for pending agent reviews.
2. Show list of changed files.
3. Show before/after text preview.
4. Provide Accept and Reject buttons.
5. Provide Accept All only if all changes are non-stale.
6. Keep UI minimal; do not adopt Pierre libraries in Wave 3 unless already present.

---

## 9. Browser UI Integration

### Agent Panel

Add a minimal agent panel or modal reachable from toolbar or command palette.

Required information:

1. Connected agent peers.
2. Agent status from awareness.
3. Pending reviews.
4. Last agent error.

Required actions:

1. Copy current room write link for agent.
2. Toggle direct/review default for future agent edits if local policy supports it.
3. Accept/reject pending reviews.

### Commands

Add commands if command palette exists:

```ts
agent.copyWriteLink
agent.showPanel
agent.acceptReview
agent.rejectReview
agent.clearCompletedReviews
```

### Compile Integration

Rules:

1. Accepted agent edits should notify the existing watch controller.
2. Direct agent edits should follow normal Yjs/store change path and trigger watch if enabled.
3. Do not auto-run full compile for every agent transaction.
4. Debounce compile exactly like human edits.

---

## 10. Security And Safety

### Permission Model

Agent permissions are still room capability permissions.

Rules:

1. Agent with read token cannot write.
2. Agent with write token can write, subject to server frame limits.
3. Client-side review mode is not a security boundary.
4. DO read-only enforcement remains authoritative.

### Agent Token Handling

1. Agent receives a normal write or read share link.
2. Token remains in URL fragment where possible.
3. Do not log tokens.
4. Do not persist third-party agent tokens in app localStorage unless user explicitly saves an owned room secret.

### Message Limits

Client and server should enforce:

```ts
const MAX_AGENT_REVIEW_FILES = 20;
const MAX_AGENT_REVIEW_CHARS = 200_000;
const MAX_AGENT_DIRECT_REPLACE_CHARS = 500;
```

Large changes must use review mode.

---

## 11. Files To Modify Or Create

### App New Files

```txt
app/src/lib/agent_identity.ts
app/src/lib/agent_collaborator.ts
app/src/lib/agent_review.ts
app/src/components/AgentPanel.tsx
```

Optional test/smoke file:

```txt
tools/agent-collab-smoke.ts
```

### App Modified Files

```txt
app/src/lib/y_project_doc.ts
app/src/lib/project_store.ts
app/src/lib/collab_provider.ts
app/src/lib/collab_protocol.ts
app/src/components/Toolbar.tsx
app/src/components/Editor.tsx
app/src/App.tsx
app/src/lib/register_commands.ts
app/src/lib/commands.ts
```

### Worker Modified Files

```txt
worker/index.js
worker/wrangler.toml
```

Worker changes should be minimal if Wave 2 already added collab room support. Expected edits:

1. Extend peer attachment type.
2. Accept `peer_kind`/agent identity in join message.
3. Add frame-size/rate guardrails for agent peers.
4. Include agent kind in peer list/status messages if such messages exist.

---

## 12. Implementation Order

### Step 1: Review Wave 2 Interfaces, 0.5 day

Confirm current names for:

1. `collab_provider.ts`.
2. `collab_protocol.ts`.
3. `identity.ts`.
4. `store.awareness()`.
5. DO join message and peer attachment.

Do not rewrite Wave 2. Add small adapters where names differ.

### Step 2: Agent Identity + Awareness, 0.5 day

Add `agent_identity.ts` and UI display support for `kind: "agent"` peers.

### Step 3: DO Agent Metadata + Limits, 0.5-1 day

Extend join metadata, attachment restore, and guardrails.

Verify existing human collab still works.

### Step 4: Agent Collaborator Adapter, 1-1.5 days

Implement `agent_collaborator.ts` using the existing Wave 2 provider/protocol helpers where possible.

Do not duplicate WebSocket protocol code if a reusable provider already exists.

### Step 5: Project Read/Write Helpers, 0.5-1 day

Add schema-safe Yjs file operations and base-state helpers.

### Step 6: Review Store + UI, 1-1.5 days

Implement pending reviews, preview, accept, reject, and command palette hooks.

### Step 7: Smoke Script And Manual Tests, 0.5-1 day

Add a minimal test client or dev-only path that joins a room and applies/proposes an edit.

### Step 8: Build And Regression Verification, 0.5 day

Run app build and existing manual collaboration checks.

---

## 13. Acceptance Criteria

### Build

1. `bun run build` succeeds in `app/`.
2. Worker deploy/dev workflow still starts.
3. Existing Wave 0-2 manual flows still work.

### Agent Presence

1. Agent can join a room with a write token.
2. Agent appears in awareness/presence UI as an agent, not a human.
3. Agent status updates are visible.

### Agent Reads

1. Agent can list project files.
2. Agent can read current text file contents.
3. Agent receives remote human edits through Yjs sync.

### Direct Agent Writes

1. Agent can apply a small edit to a text file.
2. Human editor updates in real time.
3. Existing watch/compile debounce sees the edit.
4. Concurrent human edits are not overwritten blindly.

### Review Mode

1. Agent can submit a pending review.
2. UI shows changed files and before/after preview.
3. Accept applies changes to live Yjs doc.
4. Reject leaves live Yjs doc unchanged.
5. Stale review is detected when base state changed.

### Permissions

1. Read-only agent cannot write.
2. DO rejects read-only agent `DocUpdate` frames.
3. Oversized agent updates are rejected or forced into review mode.

### Regression

1. Human remote collaboration still works.
2. Share links still work.
3. Read-only human mode still works.
4. Multi-project routing still works.
5. Local compile still works.

---

## 14. Testing Plan

### Manual Happy Path

1. Open project as human owner.
2. Start/share collaboration room.
3. Start agent smoke client with write link.
4. Verify agent appears in presence list.
5. Agent reads `main.tex`.
6. Agent proposes a one-line change in review mode.
7. Human accepts.
8. Editor updates and watch compile triggers if enabled.

### Concurrent Edit Test

1. Human types in `main.tex`.
2. Agent attempts edit with stale base state.
3. Expected: direct apply is blocked or converted to stale review.

### Read-Only Agent Test

1. Start agent with read link.
2. Agent reads project.
3. Agent attempts write.
4. Expected: client returns error and server rejects any malicious update.

### Large Edit Test

1. Agent replaces more than 500 chars.
2. Expected: change enters review mode by default.
3. Human can accept/reject.

### Regression Test

1. Two human browsers edit same room.
2. Read-only human browser joins.
3. Agent joins and leaves.
4. Human collaboration remains stable.

---

## 15. Deployment Notes

### Worker

Wave 3 worker changes are schema/guardrail extensions only. They must not alter room HMAC validation semantics or existing bundle proxy routes.

Before deploy, verify:

1. `/bundle` range requests still work.
2. `/index.gz` still works.
3. `/formats/*` still works.
4. `/collab/ws/<room_id>` still accepts human clients.
5. Agent clients can join after deploy.

### App

Agent UI should be inert unless collaboration is active. Users who never use collaboration should not see new required setup steps.

### Version Compatibility

Agent join message extension must be backward compatible with Wave 2 human clients:

1. Missing `peer_kind` means `human`.
2. Missing agent fields must not fail human join.
3. Older clients should continue to receive document updates.

---

## 16. Risks And Mitigations

### Risk: Agent Overwrites Human Work

Mitigation:

1. Use base state vectors.
2. Default large changes to review mode.
3. Detect stale reviews.
4. Apply accepted reviews in one labeled transaction.

### Risk: Agent Path Forks From Human Collab Path

Mitigation:

1. Reuse Wave 2 provider/protocol helpers.
2. Keep agents as Yjs peers.
3. Do not invent a second document transport.

### Risk: Review UI Becomes Too Large

Mitigation:

1. Implement text-only before/after preview.
2. Avoid Pierre dependencies in Wave 3.
3. Defer rich diffs to polish wave.

### Risk: Server Rate Limit Breaks Humans

Mitigation:

1. Apply new strict limits only to `kind: "agent"` peers.
2. Keep existing human frame behavior unchanged.

### Risk: Hidden Security Assumption

Mitigation:

1. Treat client review mode as UX only.
2. Keep DO permission enforcement authoritative.
3. Never trust peer kind for granting permission; permission still comes from token.

---

## Final Implementation Guidance

Keep Wave 3 minimal and focused.

Build the smallest useful agent collaboration path:

1. Agent joins room.
2. Agent appears in presence.
3. Agent reads files.
4. Agent proposes or applies text edits safely.
5. Human can review large edits.

Do not implement MCP transport, local folder sync, WebRTC, or rich diff libraries in this wave.

Do not break Waves 0-2.
