import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1 } from "y-protocols/sync";
import { createDecoder } from "lib0/decoding";
import { createEncoder, toUint8Array } from "lib0/encoding";
import { encode_frame, decode_frame, FrameKind } from "./collab_protocol";
import type { UserIdentity } from "./identity";
import { get_jjk_name } from "./jjk_names";

export type CollabPermission = "read" | "write";
export type CollabStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface CollabProviderOptions {
  room_id: string;
  token: string;
  room_secret?: string | null;
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

function base64url_encode(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64url_decode(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4;
  str = str.replace(/\-/g, "+").replace(/\_/g, "/") + "=".repeat(pad);
  const bytes = new Uint8Array(
    atob(str).split("").map((c) => c.charCodeAt(0)),
  );
  return bytes;
}

export interface CollabProvider {
  status(): CollabStatus;
  permission(): CollabPermission | null;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

export function create_collab_provider(opts: CollabProviderOptions): CollabProvider {
  let status: CollabStatus = "idle";
  let permission: CollabPermission | null = null;
  let ws: WebSocket | null = null;
  let reconnect_attempt = 0;
  let reconnect_timer: ReturnType<typeof setTimeout> | null = null;
  let presence_timer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

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

  function connect() {
    if (destroyed || ws) return;
    set_status("connecting");

    ws = new WebSocket(opts.ws_url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnect_attempt = 0;
      const is_owner = !!opts.room_secret && opts.token.startsWith("w.");
      if (is_owner) {
        ws!.send(JSON.stringify({
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
        }));
      }
      ws!.send(JSON.stringify({
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
      }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        handle_json(e.data);
      } else if (e.data instanceof ArrayBuffer) {
        handle_binary(new Uint8Array(e.data));
      }
    };

    ws.onclose = (e) => {
      ws = null;
      const non_reconnectable = [4401, 4403, 4404, 4410];
      if (destroyed || non_reconnectable.includes(e.code)) {
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

  function handle_json(raw: string) {
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
      set_status("connected");
      // start sync protocol
      send_sync_step1();
    } else if (msg.type === "created") {
      // wait for the follow-up join response before starting sync
    } else if (msg.type === "error") {
      set_status("error");
      opts.on_error?.(msg.message);
    } else if (msg.type === "peer-count") {
      opts.on_peer_count?.(msg.count);
    } else if (msg.type === "pong") {
      // ignore
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
    if (ws) {
      ws.close();
      ws = null;
    }
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
  };
}
