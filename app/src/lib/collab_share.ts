import { get_share_room_url } from "./collab_config";
import type { RoomRegistry, RoomRecord } from "./room_registry";
import { base64url_encode, base64url_decode } from "./crypto_utils";

function room_record_to_owned_room(record: RoomRecord): OwnedRoom {
  return {
    room_id: record.room_id,
    project_id: record.project_id,
    room_secret: record.room_secret ?? "",
    created_at: record.created_at,
    name: record.name ?? "Shared Project",
  };
}

export type OwnedRoom = {
  room_id: string;
  project_id: string;
  room_secret: string;
  created_at: number;
  name: string;
};

export type OwnedRoomsFile = {
  version: 1;
  rooms: OwnedRoom[];
};

export type RoomsImportResult = {
  imported: number;
  skipped: number;
};

export type OwnedRoomLinks = {
  write_url: string;
  read_url: string;
};

export type DeleteRoomResult =
  | { ok: true; status: "deleted" | "already_deleted" | "not_found" }
  | { ok: false; status: "not_owner" | "forbidden" | "timeout" | "network_error"; message: string };

export async function create_share_token(
  room_secret_b64: string,
  room_id: string,
  permission: "r" | "w",
): Promise<string> {
  const secret = base64url_decode(room_secret_b64);
  const key = await crypto.subtle.importKey(
    "raw",
    secret.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`${room_id}:${permission}`);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return `${permission}.${base64url_encode(sig.slice(0, 16))}`;
}

function create_room_id(): string {
  return `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function create_room_secret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

export interface CreatedRoomLinks {
  room_id: string;
  room_secret_b64: string;
  write_url: string;
  read_url: string;
}

export async function create_room_links(
  registry: RoomRegistry,
  project_id: string,
  project_name: string,
): Promise<CreatedRoomLinks> {
  const room_id = create_room_id();
  const room_secret = create_room_secret();
  const room_secret_b64 = base64url_encode(room_secret);

  const write_token = await create_share_token(room_secret_b64, room_id, "w");
  const read_token = await create_share_token(room_secret_b64, room_id, "r");

  const base_url = get_share_room_url(room_id);
  const write_url = `${base_url}#${write_token}`;
  const read_url = `${base_url}#${read_token}`;

  await registry.put_room_record({
    room_id,
    project_id,
    role: "owner",
    room_secret: room_secret_b64,
    name: project_name,
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  return { room_id, room_secret_b64, write_url, read_url };
}

export function get_share_token_permission(token: string): "read" | "write" | null {
  const dot = token.indexOf(".");
  const prefix = dot >= 0 ? token.slice(0, dot) : token;
  if (prefix === "r") return "read";
  if (prefix === "w") return "write";
  return null;
}

export async function get_owned_room(registry: RoomRegistry, room_id: string): Promise<OwnedRoom | null> {
  const record = await registry.get_by_room_id(room_id);
  if (record && record.role === "owner") {
    return room_record_to_owned_room(record);
  }
  return null;
}

export async function bind_project_to_room(registry: RoomRegistry, project_id: string, room_id: string): Promise<void> {
  await registry.update_project_binding(room_id, project_id);
}

export async function close_room(registry: RoomRegistry, room_id: string): Promise<boolean> {
  const record = await registry.get_by_room_id(room_id);
  if (!record) return false;
  await registry.delete_room_record(room_id);
  return true;
}

export async function delete_room(registry: RoomRegistry, room_id: string, ws_url: string): Promise<DeleteRoomResult> {
  const owned = await get_owned_room(registry, room_id);
  if (!owned) {
    return { ok: false, status: "not_owner", message: "You do not own this room" };
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(ws_url);
    let resolved = false;

    const remove_owned_room = async () => {
      try {
        await registry.delete_room_record(room_id);
      } catch {
        // ignore registry errors
      }
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      ws.close();
      resolve({ ok: false, status: "timeout", message: "Delete request timed out" });
    }, 15000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "delete",
        room_id,
        room_secret: owned.room_secret,
      }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "deleted") {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          ws.close();
          void remove_owned_room();
          resolve({ ok: true, status: "deleted" });
        } else if (msg.type === "error") {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          ws.close();
          resolve({ ok: false, status: "forbidden", message: msg.message || "Delete failed" });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = (e) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (e.code === 4410 || e.code === 4404) {
        void remove_owned_room();
        resolve({ ok: true, status: e.code === 4410 ? "already_deleted" : "not_found" });
        return;
      }
      resolve({ ok: false, status: "network_error", message: `Connection closed (${e.code})` });
    };

    ws.onerror = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      ws.close();
      resolve({ ok: false, status: "network_error", message: "WebSocket error" });
    };
  });
}

export async function get_owned_room_links(registry: RoomRegistry, room_id: string): Promise<OwnedRoomLinks | null> {
  const owned = await get_owned_room(registry, room_id);
  if (!owned) return null;
  const write_token = await create_share_token(owned.room_secret, room_id, "w");
  const read_token = await create_share_token(owned.room_secret, room_id, "r");
  const base_url = get_share_room_url(room_id);
  return {
    write_url: `${base_url}#${write_token}`,
    read_url: `${base_url}#${read_token}`,
  };
}

function is_owned_room(value: unknown): value is OwnedRoom {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<OwnedRoom>;
  return (
    typeof room.room_id === "string"
    && typeof room.project_id === "string"
    && typeof room.room_secret === "string"
    && typeof room.created_at === "number"
    && typeof room.name === "string"
  );
}

export async function export_rooms_backup(registry: RoomRegistry): Promise<string> {
  const registry_rooms = await registry.get_all_rooms();
  const rooms = registry_rooms
    .filter(r => r.role === "owner")
    .map(room_record_to_owned_room)
    .sort((a, b) => b.created_at - a.created_at);
  return JSON.stringify({ version: 1, rooms }, null, 2);
}

export async function get_exportable_room_count(registry: RoomRegistry): Promise<number> {
  const registry_rooms = await registry.get_all_rooms();
  return registry_rooms.filter(r => r.role === "owner").length;
}

export async function import_rooms_backup(registry: RoomRegistry, json: string): Promise<RoomsImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid backup JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Backup file must be an object");
  }

  const file = parsed as Partial<OwnedRoomsFile>;
  if (file.version !== 1 || !Array.isArray(file.rooms)) {
    throw new Error("Unsupported backup format");
  }

  const existing = await registry.get_all_rooms();
  const existing_ids = new Set(existing.map((r) => r.room_id));
  let imported = 0;
  let skipped = 0;

  for (const room of file.rooms) {
    if (!is_owned_room(room)) {
      skipped++;
      continue;
    }
    if (existing_ids.has(room.room_id)) {
      skipped++;
      continue;
    }
    existing_ids.add(room.room_id);
    imported++;

    try {
      await registry.put_room_record({
        room_id: room.room_id,
        project_id: room.project_id,
        role: "owner",
        room_secret: room.room_secret,
        name: room.name,
        created_at: room.created_at,
        updated_at: Date.now(),
      });
    } catch {
      // ignore registry errors during import
    }
  }

  return { imported, skipped };
}

export async function download_rooms_backup(registry: RoomRegistry): Promise<void> {
  const blob = new Blob([await export_rooms_backup(registry)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eztex-rooms-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function load_rooms_backup_from_file(registry: RoomRegistry, file: File): Promise<RoomsImportResult> {
  const text = await file.text();
  return await import_rooms_backup(registry, text);
}

export function parse_collab_url(url: URL): { room_id: string; token: string } | null {
  const match = url.pathname.match(/^\/c\/(.+)$/);
  if (!match) return null;
  const room_id = match[1];
  const hash = url.hash.slice(1);
  if (!hash || !hash.includes(".")) return null;
  return { room_id, token: hash };
}
