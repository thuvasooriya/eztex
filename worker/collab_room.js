import * as Y from "yjs";

const ROOM_META_KEY = "room-meta";
const YDOC_SNAPSHOT_KEY = "ydoc-snapshot";
const LAST_COMPACTED_AT_KEY = "last-compacted-at";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function base64url_encode(bytes) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64url_decode(str) {
  str += new Array(5 - (str.length % 4)).join("=");
  str = str.replace(/\-/g, "+").replace(/\_/g, "/");
  const bytes = new Uint8Array(
    atob(str).split("").map((c) => c.charCodeAt(0)),
  );
  return bytes;
}

async function hmac_truncated(secret_bytes, message_text) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret_bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = new TextEncoder().encode(message_text);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  return sig.slice(0, 16);
}

function constant_time_equal(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

async function verify_token(room_secret_b64, room_id, token) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [perm, sig_b64] = parts;
  if (perm !== "r" && perm !== "w") return null;

  try {
    const secret = base64url_decode(room_secret_b64);
    const expected = await hmac_truncated(secret, `${room_id}:${perm}`);
    const actual = base64url_decode(sig_b64);
    if (!constant_time_equal(actual, expected)) return null;
    return perm === "w" ? "write" : "read";
  } catch {
    return null;
  }
}

export const FrameKind = {
  SyncStep1: 0,
  SyncStep2: 1,
  DocUpdate: 2,
  Awareness: 3,
};

const MAX_AGENT_FRAME_BYTES = 512 * 1024;
const MAX_AGENT_UPDATES_PER_MINUTE = 120;

export class CollabRoom {
  constructor(state, env) {
    this.ctx = state;
    this.env = env;
    this.peers = new Map();
    this.room_meta = null;
    this.room_doc = null;
    this._pending_updates = 0;
    this._persist_timer = null;
    this._agent_update_timestamps = new Map();

    this.ctx.blockConcurrencyWhile(async () => {
      const meta = await this.ctx.storage.get(ROOM_META_KEY);
      this.room_meta = meta ?? null;

      const snapshot = await this.ctx.storage.get(YDOC_SNAPSHOT_KEY);
      this.room_doc = new Y.Doc();
      if (snapshot && snapshot.byteLength > 0) {
        Y.applyUpdate(this.room_doc, new Uint8Array(snapshot));
      }

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        if (attachment) {
          this.peers.set(ws, attachment);
        }
      }
    });
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const peer = this.peers.get(ws);

    if (typeof message === "string") {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        ws.close(4400, "Invalid JSON");
        return;
      }

      if (parsed.type === "create") {
        await this._handle_create(ws, parsed);
      } else if (parsed.type === "join") {
        await this._handle_join(ws, parsed);
      } else if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      return;
    }

    if (message instanceof ArrayBuffer) {
      const bytes = new Uint8Array(message);
      if (bytes.length < 1) return;

      if (bytes.length > MAX_AGENT_FRAME_BYTES) {
        if (peer && peer.kind === "agent") {
          ws.send(JSON.stringify({ type: "error", code: "frame_too_large", message: `Frame exceeds ${MAX_AGENT_FRAME_BYTES} byte limit` }));
          return;
        }
      }

      const kind = bytes[0];
      const payload = bytes.slice(1);

      if (kind === FrameKind.DocUpdate) {
        if (!peer || peer.permission !== "write") {
          if (peer) {
            ws.send(JSON.stringify({ type: "error", code: "permission_denied", message: "Read-only peers cannot write" }));
          }
          return;
        }
        if (peer.kind === "agent") {
          if (!this._check_agent_rate(peer.peer_id)) {
            ws.send(JSON.stringify({ type: "error", code: "rate_limited", message: "Agent update rate exceeded" }));
            return;
          }
        }
        this._apply_update(payload);
        this._broadcast_binary(bytes, ws);
      } else if (kind === FrameKind.SyncStep1 || kind === FrameKind.SyncStep2) {
        this._broadcast_binary(bytes, ws);
      } else if (kind === FrameKind.Awareness) {
        this._broadcast_binary(bytes, ws);
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.peers.delete(ws);
    if (this.peers.size === 0) {
      await this._schedule_cleanup();
    }
  }

  async webSocketError(ws, error) {
    this.peers.delete(ws);
    if (this.peers.size === 0) {
      await this._schedule_cleanup();
    }
  }

  async alarm() {
    const meta = await this.ctx.storage.get(ROOM_META_KEY);
    if (!meta) return;
    if (this.peers.size > 0) return;
    const inactive = Date.now() - (meta.last_active_at ?? 0);
    if (inactive >= SEVEN_DAYS_MS) {
      await this.ctx.storage.deleteAll();
    }
  }

  async _handle_create(ws, msg) {
    const { room_id, room_secret, peer_id, identity, initial_state } = msg;

    if (this.room_meta) {
      if (this.room_meta.room_secret !== room_secret) {
        ws.close(4409, "Room already exists with different secret");
        return;
      }
    } else {
      const now = Date.now();
      this.room_meta = {
        version: 1,
        room_id,
        room_secret,
        created_at: now,
        updated_at: now,
        last_active_at: now,
        owner_peer_id: peer_id,
      };
      await this.ctx.storage.put(ROOM_META_KEY, this.room_meta);
    }

    const attachment = {
      peer_id,
      permission: "write",
      identity,
      kind: "human",
      joined_at: Date.now(),
    };
    ws.serializeAttachment(attachment);
    this.peers.set(ws, attachment);

    if (initial_state && initial_state.byteLength > 0) {
      const bytes = new Uint8Array(initial_state);
      Y.applyUpdate(this.room_doc, bytes);
      await this._persist_snapshot();
    }

    ws.send(JSON.stringify({ type: "created", room_id, snapshot_applied: true }));
  }

  async _handle_join(ws, msg) {
    const { room_id, token, peer_id, identity, peer_kind, client_name } = msg;

    if (!this.room_meta) {
      ws.close(4404, "Room not found");
      return;
    }
    if (this.room_meta.closed) {
      ws.close(4410, "Room closed");
      return;
    }

    const permission = await verify_token(this.room_meta.room_secret, room_id, token);
    if (!permission) {
      ws.close(4403, "Invalid token");
      return;
    }

    const kind = peer_kind === "agent" ? "agent" : "human";
    const attachment = {
      peer_id,
      permission,
      identity,
      kind,
      client_name: client_name ?? null,
      joined_at: Date.now(),
    };
    ws.serializeAttachment(attachment);
    this.peers.set(ws, attachment);

    this.room_meta.last_active_at = Date.now();
    await this.ctx.storage.put(ROOM_META_KEY, this.room_meta);

    const snapshot = Y.encodeStateAsUpdate(this.room_doc);
    ws.send(JSON.stringify({
      type: "joined",
      room_id,
      permission,
      snapshot: base64url_encode(snapshot),
    }));

    this._broadcast_peer_count();
  }

  _apply_update(update_bytes) {
    Y.applyUpdate(this.room_doc, update_bytes);
    this._pending_updates++;
    if (this._pending_updates >= 100) {
      this._debounced_persist(0);
    } else {
      this._debounced_persist(2000);
    }
  }

  _debounced_persist(delay_ms) {
    if (this._persist_timer) {
      clearTimeout(this._persist_timer);
    }
    this._persist_timer = setTimeout(() => {
      this._persist_timer = null;
      this._persist_snapshot();
    }, delay_ms);
  }

  async _persist_snapshot() {
    this._pending_updates = 0;
    const snapshot = Y.encodeStateAsUpdate(this.room_doc);
    await this.ctx.storage.put(YDOC_SNAPSHOT_KEY, snapshot);
    await this.ctx.storage.put(LAST_COMPACTED_AT_KEY, Date.now());
  }

  _broadcast_binary(bytes, exclude_ws) {
    for (const [ws] of this.peers) {
      if (ws === exclude_ws) continue;
      try {
        ws.send(bytes);
      } catch {
        // ignore send errors
      }
    }
  }

  _broadcast_peer_count() {
    const msg = JSON.stringify({ type: "peer-count", count: this.peers.size });
    for (const [ws] of this.peers) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }

  async _schedule_cleanup() {
    if (this.room_meta) {
      this.room_meta.last_active_at = Date.now();
      await this.ctx.storage.put(ROOM_META_KEY, this.room_meta);
    }
    await this.ctx.storage.setAlarm(Date.now() + SEVEN_DAYS_MS);
  }

  _check_agent_rate(peer_id) {
    const now = Date.now();
    const window_start = now - 60000;
    let timestamps = this._agent_update_timestamps.get(peer_id);
    if (!timestamps) {
      timestamps = [];
      this._agent_update_timestamps.set(peer_id, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0] < window_start) {
      timestamps.shift();
    }
    if (timestamps.length >= MAX_AGENT_UPDATES_PER_MINUTE) {
      return false;
    }
    timestamps.push(now);
    return true;
  }
}
