import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1 } from "y-protocols/sync";
import { createDecoder } from "lib0/decoding";
import { createEncoder, toUint8Array } from "lib0/encoding";
import { encode_frame, decode_frame, FrameKind } from "./collab_protocol";
import type { UserIdentity } from "./identity";
import { get_jjk_name } from "./jjk_names";
import { base64url_encode, base64url_decode } from "./crypto_utils";

export type CollabPermission = "read" | "write";
export type CollabStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "deleted" | "error";

export interface CollabProviderOptions {
  room_id: string;
  token: string;
  room_secret?: string | null;
  precomputed_blobs?: Record<string, string>;
  put_blobs?: (blobs: Record<string, string>) => Promise<void>;
  on_blob_available?: (hash: string) => void;
  on_blob_request?: (hash: string) => void;
  on_blob_response?: (hash: string, bytes: Uint8Array) => void;
  doc: Y.Doc;
  awareness: Awareness;
  identity: UserIdentity;
  ws_url: string;
  on_status?: (status: CollabStatus) => void;
  on_permission?: (permission: CollabPermission) => void;
  on_error?: (message: string) => void;
  on_peer_count?: (count: number) => void;
}

const PROVIDER_ORIGIN = "eztex:collab-provider";
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000, 15000, 30000];
const BLOB_CHUNK_BYTES = 192 * 1024;

export interface CollabProvider {
  status(): CollabStatus;
  permission(): CollabPermission | null;
  connect(): void;
  disconnect(): void;
  destroy(): void;
  send_blob_available(hash: string): void;
  send_blob_request(hash: string): void;
  send_blob_response(hash: string, bytes: Uint8Array): void;
}

export function create_collab_provider(opts: CollabProviderOptions): CollabProvider {
  let status: CollabStatus = "idle";
  let permission: CollabPermission | null = null;
  let ws: WebSocket | null = null;
  let reconnect_attempt = 0;
  let reconnect_timer: ReturnType<typeof setTimeout> | null = null;
  let presence_timer: ReturnType<typeof setInterval> | null = null;
  let full_sync_timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let create_pending = false;
  let terminal_error = false;
  const incoming_blob_chunks = new Map<string, { total: number; chunks: Array<Uint8Array | undefined>; received: number }>();

  function touch_presence() {
    opts.awareness.setLocalStateField("last_active_at", Date.now());
  }

  function set_status(s: CollabStatus) {
    status = s;
    opts.on_status?.(s);
  }

  function set_permission(p: CollabPermission) {
    permission = p;
    opts.on_permission?.(p);
    const name = get_jjk_name(opts.identity.user_id);
    opts.awareness.setLocalStateField("user", {
      user_id: opts.identity.user_id,
      name,
      color: opts.identity.color,
      color_hue: opts.identity.color_hue,
      permission: p,
      kind: opts.identity.kind ?? "human",
    });
    touch_presence();
    if (opts.awareness.getLocalState()?.edit_count == null) {
      opts.awareness.setLocalStateField("edit_count", 0);
    }
    if (!presence_timer) {
      presence_timer = setInterval(() => touch_presence(), 30000);
    }
  }

  function build_join_msg(): string {
    return JSON.stringify({
      type: "join",
      room_id: opts.room_id,
      token: opts.token,
      peer_id: opts.identity.user_id,
      identity: {
        user_id: opts.identity.user_id,
        display_name: opts.identity.display_name,
        color_hue: opts.identity.color_hue,
        color: opts.identity.color,
      },
    });
  }

  function send_json(msg: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore send failures; normal reconnect handles socket closure
    }
  }

  function send_blob_available(hash: string) {
    send_json({ type: "blob-available", hash });
  }

  function send_blob_request(hash: string) {
    send_json({ type: "blob-request", hash });
  }

  function send_blob_response(hash: string, bytes: Uint8Array) {
    const total = Math.max(1, Math.ceil(bytes.byteLength / BLOB_CHUNK_BYTES));
    for (let index = 0; index < total; index++) {
      const start = index * BLOB_CHUNK_BYTES;
      const chunk = bytes.slice(start, Math.min(bytes.byteLength, start + BLOB_CHUNK_BYTES));
      send_json({
        type: "blob-chunk",
        hash,
        index,
        total,
        data: base64url_encode(chunk),
      });
    }
  }

  function handle_blob_chunk(msg: any) {
    if (typeof msg.hash !== "string" || typeof msg.data !== "string") return;
    if (!Number.isInteger(msg.index) || !Number.isInteger(msg.total)) return;
    if (msg.index < 0 || msg.total < 1 || msg.index >= msg.total) return;

    let entry = incoming_blob_chunks.get(msg.hash);
    if (!entry || entry.total !== msg.total) {
      entry = { total: msg.total, chunks: new Array(msg.total), received: 0 };
      incoming_blob_chunks.set(msg.hash, entry);
    }
    if (entry.chunks[msg.index] !== undefined) return;

    let chunk: Uint8Array;
    try {
      chunk = base64url_decode(msg.data);
    } catch {
      return;
    }

    entry.chunks[msg.index] = chunk;
    entry.received++;
    if (entry.received !== entry.total) return;

    incoming_blob_chunks.delete(msg.hash);
    const total_bytes = entry.chunks.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0);
    const bytes = new Uint8Array(total_bytes);
    let offset = 0;
    for (const part of entry.chunks) {
      if (!part) return;
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    opts.on_blob_response?.(msg.hash, bytes);
  }

  function connect() {
    if (destroyed || ws) return;
    terminal_error = false;
    set_status("connecting");

    const join_msg = build_join_msg();

    let create_msg: string | null = null;
    const is_owner = !!opts.room_secret && opts.token.startsWith("w.");
    if (is_owner) {
      const msg: Record<string, unknown> = {
        type: "create",
        room_id: opts.room_id,
        room_secret: opts.room_secret,
        initial_state: base64url_encode(Y.encodeStateAsUpdate(opts.doc)),
        peer_id: opts.identity.user_id,
        identity: {
          user_id: opts.identity.user_id,
          display_name: opts.identity.display_name,
          color_hue: opts.identity.color_hue,
          color: opts.identity.color,
        },
      };
      if (opts.precomputed_blobs) {
        msg.blobs = opts.precomputed_blobs;
      }
      create_msg = JSON.stringify(msg);
    }

    ws = new WebSocket(opts.ws_url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnect_attempt = 0;
      if (create_msg) {
        create_pending = true;
        ws!.send(create_msg);
        return;
      }
      ws!.send(join_msg);
    };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        void handle_json(e.data);
      } else if (e.data instanceof ArrayBuffer) {
        handle_binary(new Uint8Array(e.data));
      }
    };

    ws.onclose = (e) => {
      const was_creating = create_pending;
      ws = null;
      create_pending = false;
      incoming_blob_chunks.clear();
      if (destroyed) return;
      if (terminal_error) return;
      if (was_creating) {
        terminal_error = true;
        set_status("error");
        opts.on_error?.(`Room creation connection closed (${e.code})`);
        return;
      }
      if (e.code === 4410) {
        set_status("deleted");
        return;
      }
      const non_reconnectable = [4400, 4401, 4403, 4404, 4410];
      if (non_reconnectable.includes(e.code)) {
        set_status(e.code === 4403 ? "error" : "closed");
        return;
      }
      schedule_reconnect();
    };

    ws.onerror = () => {
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }

  async function handle_json(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "joined") {
      permission = msg.permission;
      set_permission(msg.permission);
      if (msg.snapshot && typeof msg.snapshot === "string") {
        const snapshot_bytes = base64url_decode(msg.snapshot);
        Y.applyUpdate(opts.doc, snapshot_bytes, PROVIDER_ORIGIN);
      }
      if (msg.blobs && opts.put_blobs) {
        await opts.put_blobs(msg.blobs as Record<string, string>);
      }
      set_status("connected");
      // start sync protocol
      send_sync_step1();
    } else if (msg.type === "room-deleted") {
      set_status("deleted");
      ws?.close(4410, "Room deleted");
    } else if (msg.type === "created") {
      if (create_pending && ws?.readyState === WebSocket.OPEN) {
        create_pending = false;
        ws.send(build_join_msg());
      }
    } else if (msg.type === "error") {
      if (msg.code === "create_failed") {
        terminal_error = true;
        set_status("error");
        opts.on_error?.(msg.message);
        ws?.close(4400, "Create failed");
        return;
      }
      set_status("error");
      opts.on_error?.(msg.message);
    } else if (msg.type === "peer-count") {
      opts.on_peer_count?.(msg.count);
    } else if (msg.type === "pong") {
      // ignore
    } else if (msg.type === "blob-available") {
      if (typeof msg.hash === "string") opts.on_blob_available?.(msg.hash);
    } else if (msg.type === "blob-request") {
      if (typeof msg.hash === "string") opts.on_blob_request?.(msg.hash);
    } else if (msg.type === "blob-response") {
      if (typeof msg.hash === "string" && typeof msg.data === "string") {
        try {
          opts.on_blob_response?.(msg.hash, base64url_decode(msg.data));
        } catch {
          // ignore malformed blob payloads
        }
      }
    } else if (msg.type === "blob-chunk") {
      handle_blob_chunk(msg);
    }
  }

  function handle_binary(bytes: Uint8Array) {
    try {
      const frame = decode_frame(bytes);
      if (frame.kind === FrameKind.SyncStep1 || frame.kind === FrameKind.SyncStep2) {
        const decoder = createDecoder(frame.payload);
        const encoder = createEncoder();
        readSyncMessage(decoder, encoder, opts.doc, PROVIDER_ORIGIN);
        const reply = toUint8Array(encoder);
        if (frame.kind === FrameKind.SyncStep1 && reply.length > 0) {
          send_frame(FrameKind.SyncStep2, reply);
        }
      } else if (frame.kind === FrameKind.DocUpdate) {
        Y.applyUpdate(opts.doc, frame.payload, PROVIDER_ORIGIN);
      } else if (frame.kind === FrameKind.Awareness) {
        applyAwarenessUpdate(opts.awareness, frame.payload, PROVIDER_ORIGIN);
      }
    } catch {
      // ignore malformed frames
    }
  }

  function send_sync_step1() {
    const encoder = createEncoder();
    writeSyncStep1(encoder, opts.doc);
    const bytes = toUint8Array(encoder);
    send_frame(FrameKind.SyncStep1, bytes);
  }

  function schedule_full_state_sync() {
    if (full_sync_timer) {
      clearTimeout(full_sync_timer);
    }
    full_sync_timer = setTimeout(() => {
      full_sync_timer = null;
      if (permission !== "write") return;
      send_frame(FrameKind.DocUpdate, Y.encodeStateAsUpdate(opts.doc));
    }, 500);
  }

  function send_frame(kind: FrameKind, payload: Uint8Array) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encode_frame(kind, payload));
    } catch {
      // ignore
    }
  }

  const doc_update_handler = (update: Uint8Array, origin: unknown) => {
    if (origin === PROVIDER_ORIGIN) return;
    if (permission !== "write") return;
    send_frame(FrameKind.DocUpdate, update);
    schedule_full_state_sync();
  };

  const awareness_handler = ({ added, updated, removed }: any) => {
    const changedClients = added.concat(updated).concat(removed);
    const update = encodeAwarenessUpdate(opts.awareness, changedClients);
    send_frame(FrameKind.Awareness, update);
  };

  opts.doc.on("update", doc_update_handler);
  opts.awareness.on("change", awareness_handler);

  function schedule_reconnect() {
    if (destroyed) return;
    set_status("reconnecting");
    const delay = RECONNECT_DELAYS[Math.min(reconnect_attempt, RECONNECT_DELAYS.length - 1)];
    reconnect_attempt++;
    reconnect_timer = setTimeout(() => {
      reconnect_timer = null;
      connect();
    }, delay);
  }

  function disconnect() {
    if (reconnect_timer) {
      clearTimeout(reconnect_timer);
      reconnect_timer = null;
    }
    if (presence_timer) {
      clearInterval(presence_timer);
      presence_timer = null;
    }
    if (full_sync_timer) {
      clearTimeout(full_sync_timer);
      full_sync_timer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    incoming_blob_chunks.clear();
    opts.awareness.setLocalStateField("cursor", null);
    opts.awareness.setLocalStateField("cursor_file", null);
    opts.awareness.setLocalStateField("cursor_line", null);
    set_status("idle");
  }

  function destroy() {
    destroyed = true;
    disconnect();
    opts.doc.off("update", doc_update_handler);
    opts.awareness.off("change", awareness_handler);
  }

  return {
    status: () => status,
    permission: () => permission,
    connect,
    disconnect,
    destroy,
    send_blob_available,
    send_blob_request,
    send_blob_response,
  };
}
