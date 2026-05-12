// agent-collab-smoke.ts
// Minimal CLI script to test agent collaboration.
// Joins a room with a write token, lists files, reads main.tex, proposes an edit.
//
// Usage:
//   bun run tools/agent-collab-smoke.ts <ws_url_with_token>
//
// Example:
//   bun run tools/agent-collab-smoke.ts "wss://eztex.thuva.workers.dev/collab/ws/r_abc123#w.sig"

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeSyncStep2 } from "y-protocols/sync";
import { createEncoder, toUint8Array } from "lib0/encoding";
import { createDecoder } from "lib0/decoding";

const url_arg = process.argv[2];
if (!url_arg) {
  console.error("Usage: bun run tools/agent-collab-smoke.ts <ws_url#token>");
  process.exit(1);
}

const hash_idx = url_arg.indexOf("#");
if (hash_idx < 0) {
  console.error("URL must include token after #");
  process.exit(1);
}

const ws_url_base = url_arg.slice(0, hash_idx);
const token = url_arg.slice(hash_idx + 1);

const room_id_match = ws_url_base.match(/\/collab\/ws\/(.+)$/);
if (!room_id_match) {
  console.error("URL must contain /collab/ws/<room_id>");
  process.exit(1);
}
const room_id = room_id_match[1];

const agent_id = `agent_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

const doc = new Y.Doc();
const awareness = new Awareness(doc);

const PROVIDER_ORIGIN = "eztex:agent-smoke";
const FrameKind = { SyncStep1: 0, SyncStep2: 1, DocUpdate: 2, Awareness: 3 };

let permission: string | null = null;

function base64url_decode(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4;
  str = str.replace(/\-/g, "+").replace(/\_/g, "/") + "=".repeat(pad);
  return new Uint8Array(atob(str).split("").map((c) => c.charCodeAt(0)));
}

function send_frame(ws: WebSocket, kind: number, payload: Uint8Array) {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  ws.send(frame);
}

function send_sync_step1(ws: WebSocket) {
  const encoder = createEncoder();
  writeSyncStep1(encoder, doc);
  send_frame(ws, FrameKind.SyncStep1, toUint8Array(encoder));
}

// Yjs helpers (minimal versions matching y_project_doc schema)
const Y_PATHS = "paths";
const Y_FILE_META = "file_meta";
const Y_TEXTS = "texts";

function list_paths(): string[] {
  return Array.from((doc.getMap(Y_PATHS) as Y.Map<string>).keys());
}

function read_file(path: string): string | null {
  const paths = doc.getMap(Y_PATHS) as Y.Map<string>;
  const fid = paths.get(path);
  if (!fid) return null;
  const texts = doc.getMap(Y_TEXTS) as Y.Map<Y.Text>;
  const ytext = texts.get(fid);
  return ytext?.toString() ?? null;
}

function write_file(path: string, content: string) {
  const paths = doc.getMap(Y_PATHS) as Y.Map<string>;
  const texts = doc.getMap(Y_TEXTS) as Y.Map<Y.Text>;
  const file_meta = doc.getMap(Y_FILE_META) as Y.Map<Y.Map<unknown>>;

  doc.transact(() => {
    let fid = paths.get(path);
    if (!fid) {
      fid = `f_${crypto.randomUUID().replaceAll("-", "")}`;
      paths.set(path, fid);
      const meta = new Y.Map<unknown>();
      meta.set("id", fid);
      meta.set("path", path);
      meta.set("kind", "text");
      meta.set("created_at", Date.now());
      meta.set("updated_at", Date.now());
      file_meta.set(fid, meta);
      const ytext = new Y.Text();
      ytext.insert(0, content);
      texts.set(fid, ytext);
    } else {
      const ytext = texts.get(fid);
      if (ytext) {
        ytext.delete(0, ytext.length);
        ytext.insert(0, content);
      }
    }
  }, { kind: "agent", label: "smoke-test", transaction_id: `txn_${Date.now()}` });
}

// connect
console.log(`Connecting to ${ws_url_base} as agent...`);
const ws = new WebSocket(ws_url_base);
ws.binaryType = "arraybuffer";

ws.onopen = () => {
  console.log("WebSocket open, sending join...");
  ws.send(JSON.stringify({
    type: "join",
    room_id,
    token,
    peer_id: agent_id,
    identity: {
      user_id: agent_id,
      display_name: "Smoke Agent",
      color_hue: 180,
      color: "hsl(180, 70%, 60%)",
      kind: "agent",
      agent_id,
      runtime: "test",
    },
    peer_kind: "agent",
    client_name: "eztex-agent-smoke",
  }));
};

ws.onmessage = (e) => {
  if (typeof e.data === "string") {
    const msg = JSON.parse(e.data);
    console.log("[json]", msg.type, msg);

    if (msg.type === "joined") {
      permission = msg.permission;
      console.log(`Permission: ${permission}`);
      if (msg.snapshot) {
        const bytes = base64url_decode(msg.snapshot);
        Y.applyUpdate(doc, bytes, PROVIDER_ORIGIN);
        console.log("Snapshot applied");
      }
      send_sync_step1(ws);

      // wait for sync, then do operations
      setTimeout(() => {
        console.log("\n--- Agent Operations ---");
        const paths = list_paths();
        console.log(`Files: ${paths.join(", ")}`);

        const main = read_file("main.tex");
        if (main !== null) {
          console.log(`\nmain.tex (${main.length} chars):`);
          console.log(main.slice(0, 200) + (main.length > 200 ? "..." : ""));

          if (permission === "write") {
            const edited = main + "\n% agent smoke test edit\n";
            write_file("main.tex", edited);
            console.log("\nApplied edit to main.tex");
          } else {
            console.log("\nRead-only: skipping write");
          }
        }

        console.log("\n--- Done. Press Ctrl+C to exit. ---");
      }, 2000);
    } else if (msg.type === "error") {
      console.error("Server error:", msg.message);
    }
  } else if (e.data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(e.data);
    if (bytes.length < 1) return;
    const kind = bytes[0];
    const payload = bytes.slice(1);

    if (kind === FrameKind.SyncStep1) {
      const encoder = createEncoder();
      writeSyncStep2(encoder, doc);
      send_frame(ws, FrameKind.SyncStep2, toUint8Array(encoder));
    } else if (kind === FrameKind.SyncStep2) {
      const decoder = createDecoder(payload);
      (readSyncMessage as any)(decoder, doc, PROVIDER_ORIGIN);
    } else if (kind === FrameKind.DocUpdate) {
      Y.applyUpdate(doc, payload, PROVIDER_ORIGIN);
    } else if (kind === FrameKind.Awareness) {
      applyAwarenessUpdate(awareness, payload, PROVIDER_ORIGIN);
    }
  }
};

ws.onclose = (e) => {
  console.log(`WebSocket closed: ${e.code} ${e.reason}`);
  process.exit(0);
};

ws.onerror = (e) => {
  console.error("WebSocket error", e);
};

// broadcast awareness updates
awareness.setLocalStateField("user", {
  user_id: agent_id,
  name: "Smoke Agent",
  color: "hsl(180, 70%, 60%)",
  color_hue: 180,
  permission: "write",
  kind: "agent",
  agent_id,
  runtime: "test",
});

awareness.setLocalStateField("agent", { status: "idle" });

doc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === PROVIDER_ORIGIN) return;
  if (permission !== "write") return;
  send_frame(ws, FrameKind.DocUpdate, update);
});

awareness.on("change", ({ added, updated, removed }: any) => {
  const changedClients = added.concat(updated).concat(removed);
  const update = encodeAwarenessUpdate(awareness, changedClients);
  send_frame(ws, FrameKind.Awareness, update);
});
