import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeSyncStep2 } from "y-protocols/sync";
import { createEncoder, toUint8Array } from "lib0/encoding";
import { createDecoder } from "lib0/decoding";
import {
  list_project_paths,
  read_project_file,
  get_project_ytext,
  create_or_get_project_ytext,
  delete_project_file,
  rename_project_file,
  has_state_advanced_since,
} from "./y_project_doc";
import type { TextPatch } from "./agent_review";
import type { AgentWriteResult } from "./agent_review";
import type { AgentIdentity } from "./agent_identity";
import type { ProjectFiles } from "./project_store";
import { base64url_decode } from "./crypto_utils";

export type AgentMode = "direct" | "review";
export type AgentStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reading"
  | "editing"
  | "waiting-review"
  | "closed"
  | "error";

export interface AgentWriteOptions {
  label?: string;
  base_state_vector?: string;
  mode?: AgentMode;
}

export interface AgentCollaboratorOptions {
  room_id: string;
  token: string;
  ws_url: string;
  identity: AgentIdentity;
  mode?: AgentMode;
  on_status?: (status: AgentStatus) => void;
  on_error?: (message: string) => void;
}

const MAX_AGENT_DIRECT_REPLACE_CHARS = 500;
const PROVIDER_ORIGIN = "eztex:agent-collab";

const FrameKind = { SyncStep1: 0, SyncStep2: 1, DocUpdate: 2, Awareness: 3 };

export interface AgentCollaborator {
  doc: Y.Doc;
  awareness: Awareness;
  connect(): void;
  disconnect(): void;
  listFiles(): string[];
  readFile(path: string): string | null;
  writeFile(path: string, content: string, opts?: AgentWriteOptions): AgentWriteResult;
  applyPatch(path: string, patch: TextPatch, opts?: AgentWriteOptions): AgentWriteResult;
  createFile(path: string, content: string, opts?: AgentWriteOptions): AgentWriteResult;
  deleteFile(path: string, opts?: AgentWriteOptions): AgentWriteResult;
  renameFile(from: string, to: string, opts?: AgentWriteOptions): AgentWriteResult;
  snapshotFiles(): ProjectFiles;
  destroy(): void;
}

export function create_agent_collaborator(opts: AgentCollaboratorOptions): AgentCollaborator {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  let ws: WebSocket | null = null;
  let permission: "read" | "write" | null = null;
  const defaultMode: AgentMode = opts.mode ?? "review";
  let destroyed = false;

  const reconnect_delays = [500, 1000, 2000, 5000, 10000];
  let reconnect_attempt = 0;
  let reconnect_timer: ReturnType<typeof setTimeout> | null = null;

  function set_status(s: AgentStatus) {
    opts.on_status?.(s);
  }

  awareness.setLocalStateField("user", {
    user_id: opts.identity.user_id,
    name: opts.identity.display_name,
    color: opts.identity.color,
    color_hue: opts.identity.color_hue,
    permission: "write",
    kind: "agent",
    agent_id: opts.identity.agent_id,
    runtime: opts.identity.runtime,
  });

  awareness.setLocalStateField("agent", { status: "idle" });

  function connect() {
    if (destroyed || ws) return;
    set_status("connecting");

    ws = new WebSocket(opts.ws_url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnect_attempt = 0;
      ws!.send(
        JSON.stringify({
          type: "join",
          room_id: opts.room_id,
          token: opts.token,
          peer_id: opts.identity.user_id,
          identity: {
            user_id: opts.identity.user_id,
            display_name: opts.identity.display_name,
            color_hue: opts.identity.color_hue,
            color: opts.identity.color,
            kind: "agent",
            agent_id: opts.identity.agent_id,
            runtime: opts.identity.runtime,
          },
          peer_kind: "agent",
          client_name: "eztex-agent",
        }),
      );
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
      if (msg.snapshot && typeof msg.snapshot === "string") {
        const snapshot_bytes = base64url_decode(msg.snapshot);
        Y.applyUpdate(doc, snapshot_bytes, PROVIDER_ORIGIN);
      }
      set_status("connected");
      send_sync_step1();
    } else if (msg.type === "created") {
      set_status("connected");
      send_sync_step1();
    } else if (msg.type === "error") {
      set_status("error");
      opts.on_error?.(msg.message);
    }
  }

  function handle_binary(bytes: Uint8Array) {
    if (bytes.length < 1) return;
    const kind = bytes[0];
    const payload = bytes.slice(1);
    try {
      if (kind === FrameKind.SyncStep1) {
        const encoder = createEncoder();
        writeSyncStep2(encoder, doc);
        const reply = toUint8Array(encoder);
        send_frame(FrameKind.SyncStep2, reply);
      } else if (kind === FrameKind.SyncStep2) {
        const decoder = createDecoder(payload);
        (readSyncMessage as any)(decoder, doc, PROVIDER_ORIGIN);
      } else if (kind === FrameKind.DocUpdate) {
        Y.applyUpdate(doc, payload, PROVIDER_ORIGIN);
      } else if (kind === FrameKind.Awareness) {
        applyAwarenessUpdate(awareness, payload, PROVIDER_ORIGIN);
      }
    } catch {
      // ignore malformed frames
    }
  }

  function send_sync_step1() {
    const encoder = createEncoder();
    writeSyncStep1(encoder, doc);
    const bytes = toUint8Array(encoder);
    send_frame(FrameKind.SyncStep1, bytes);
  }

  function send_frame(kind: number, payload: Uint8Array) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    try {
      ws.send(frame);
    } catch {
      // ignore
    }
  }

  function schedule_reconnect() {
    if (destroyed) return;
    set_status("connecting");
    const delay = reconnect_delays[Math.min(reconnect_attempt, reconnect_delays.length - 1)];
    reconnect_attempt++;
    reconnect_timer = setTimeout(() => {
      reconnect_timer = null;
      connect();
    }, delay);
  }

  const doc_update_handler = (update: Uint8Array, origin: unknown) => {
    if (origin === PROVIDER_ORIGIN) return;
    if (permission !== "write") return;
    send_frame(FrameKind.DocUpdate, update);
  };

  const awareness_handler = ({ added, updated, removed }: any) => {
    const changedClients = added.concat(updated).concat(removed);
    const update = encodeAwarenessUpdate(awareness, changedClients);
    send_frame(FrameKind.Awareness, update);
  };

  doc.on("update", doc_update_handler);
  awareness.on("change", awareness_handler);

  function disconnect() {
    if (reconnect_timer) {
      clearTimeout(reconnect_timer);
      reconnect_timer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    set_status("closed");
  }

  function destroy() {
    destroyed = true;
    disconnect();
    doc.off("update", doc_update_handler);
    awareness.off("change", awareness_handler);
    awareness.destroy();
    doc.destroy();
  }

  function listFiles(): string[] {
    return list_project_paths(doc);
  }

  function readFile(path: string): string | null {
    const content = read_project_file(doc, path);
    if (content === null) return null;
    if (typeof content === "string") return content;
    return null;
  }

  function writeFile(path: string, content: string, wOpts?: AgentWriteOptions): AgentWriteResult {
    if (permission !== "write") return { ok: false, error: "read-only" };
    const mode = wOpts?.mode ?? defaultMode;
    const label = wOpts?.label ?? "write";

    if (mode === "review" || content.length > MAX_AGENT_DIRECT_REPLACE_CHARS) {
      return {
        ok: true,
        applied: false,
        review_id: `rev_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      };
    }

    if (wOpts?.base_state_vector && has_state_advanced_since(doc, wOpts.base_state_vector)) {
      return { ok: false, error: "conflict: document changed since base state" };
    }

    const transaction_id = `txn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const origin = { kind: "agent" as const, label, transaction_id };

    doc.transact(() => {
      const ytext = create_or_get_project_ytext(doc, path);
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    }, origin);

    return { ok: true, applied: true, transaction_id };
  }

  function applyPatch(path: string, patch: TextPatch, pOpts?: AgentWriteOptions): AgentWriteResult {
    if (permission !== "write") return { ok: false, error: "read-only" };
    if (patch.length === 0) return { ok: true, applied: true, transaction_id: "" };

    const mode = pOpts?.mode ?? defaultMode;
    const label = pOpts?.label ?? "patch";
    const totalInsert = patch.reduce((s, p) => s + p.insert.length, 0);

    if (mode === "review" || totalInsert > MAX_AGENT_DIRECT_REPLACE_CHARS) {
      return {
        ok: true,
        applied: false,
        review_id: `rev_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      };
    }

    if (pOpts?.base_state_vector && has_state_advanced_since(doc, pOpts.base_state_vector)) {
      return { ok: false, error: "conflict: document changed since base state" };
    }

    const transaction_id = `txn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const origin = { kind: "agent" as const, label, transaction_id };

    doc.transact(() => {
      const ytext = get_project_ytext(doc, path);
      if (!ytext) return;
      const sorted = [...patch].sort((a, b) => b.from - a.from);
      for (const change of sorted) {
        ytext.delete(change.from, change.to - change.from);
        ytext.insert(change.from, change.insert);
      }
    }, origin);

    return { ok: true, applied: true, transaction_id };
  }

  function createFile(path: string, content: string, cOpts?: AgentWriteOptions): AgentWriteResult {
    if (permission !== "write") return { ok: false, error: "read-only" };
    const existing = get_project_ytext(doc, path);
    if (existing) return { ok: false, error: "file already exists" };
    return writeFile(path, content, cOpts);
  }

  function deleteFile(path: string, dOpts?: AgentWriteOptions): AgentWriteResult {
    if (permission !== "write") return { ok: false, error: "read-only" };
    const label = dOpts?.label ?? "delete";
    const transaction_id = `txn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const origin = { kind: "agent" as const, label, transaction_id };

    const ok = delete_project_file(doc, path);
    if (!ok) return { ok: false, error: "file not found" };

    doc.transact(() => {}, origin);
    return { ok: true, applied: true, transaction_id };
  }

  function renameFile(from: string, to: string, rOpts?: AgentWriteOptions): AgentWriteResult {
    if (permission !== "write") return { ok: false, error: "read-only" };
    const label = rOpts?.label ?? "rename";
    const transaction_id = `txn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const origin = { kind: "agent" as const, label, transaction_id };

    const ok = rename_project_file(doc, from, to);
    if (!ok) return { ok: false, error: "rename failed" };

    doc.transact(() => {}, origin);
    return { ok: true, applied: true, transaction_id };
  }

  function snapshotFiles(): ProjectFiles {
    const result: ProjectFiles = {};
    for (const path of list_project_paths(doc)) {
      const content = read_project_file(doc, path);
      if (content !== null) {
        result[path] = content;
      }
    }
    return result;
  }

  return {
    doc,
    awareness,
    connect,
    disconnect,
    listFiles,
    readFile,
    writeFile,
    applyPatch,
    createFile,
    deleteFile,
    renameFile,
    snapshotFiles,
    destroy,
  };
}
