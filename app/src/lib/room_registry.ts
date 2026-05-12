import { get, put, remove, get_all } from "./storage_db";
import { get_share_room_url } from "./collab_config";
import { base64url_encode, base64url_decode } from "./crypto_utils";

export interface RoomRecord {
  room_id: string;
  project_id: string;
  role: "owner" | "guest";
  room_secret?: string;
  invite_token?: string;
  name?: string;
  created_at: number;
  updated_at: number;
}

function create_room_id(): string {
  return `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function create_room_secret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

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

export class RoomRegistry {
  async create_room(
    project_id: string,
    project_name: string,
  ): Promise<{ room_id: string; room_secret: string; write_url: string; read_url: string }> {
    const rid = create_room_id();
    const secret_bytes = create_room_secret();
    const room_secret = base64url_encode(secret_bytes);

    const write_token = await create_share_token(room_secret, rid, "w");
    const read_token = await create_share_token(room_secret, rid, "r");

    const base_url = get_share_room_url(rid);
    const write_url = `${base_url}#${write_token}`;
    const read_url = `${base_url}#${read_token}`;

    const now = Date.now();
    const record: RoomRecord = {
      room_id: rid,
      project_id,
      role: "owner",
      room_secret,
      name: project_name,
      created_at: now,
      updated_at: now,
    };
    await put("rooms", record, rid);

    return { room_id: rid, room_secret, write_url, read_url };
  }

  async get_by_room_id(room_id: string): Promise<RoomRecord | null> {
    return (await get<RoomRecord>("rooms", room_id)) ?? null;
  }

  async get_by_project_id(project_id: string): Promise<RoomRecord | null> {
    const all = await get_all<RoomRecord>("rooms");
    return all.find((r) => r.project_id === project_id) ?? null;
  }

  async update_project_binding(room_id: string, project_id: string): Promise<void> {
    const record = await this.get_by_room_id(room_id);
    if (!record) return;
    record.project_id = project_id;
    record.updated_at = Date.now();
    await put("rooms", record, room_id);
  }

  async delete_room_record(room_id: string): Promise<void> {
    await remove("rooms", room_id);
  }

  async delete_by_project_id(project_id: string): Promise<void> {
    const record = await this.get_by_project_id(project_id);
    if (record) {
      await remove("rooms", record.room_id);
    }
  }

  async get_all_rooms(): Promise<RoomRecord[]> {
    return get_all<RoomRecord>("rooms");
  }

  async put_room_record(record: RoomRecord): Promise<void> {
    await put("rooms", record, record.room_id);
  }

  async save_guest_room(room_id: string, project_id: string, invite_token: string): Promise<void> {
    const existing = await this.get_by_room_id(room_id);
    if (existing) return;
    const now = Date.now();
    const record: RoomRecord = {
      room_id,
      project_id,
      role: "guest",
      invite_token,
      created_at: now,
      updated_at: now,
    };
    await put("rooms", record, room_id);
  }

  async export_rooms(): Promise<string> {
    const all = await get_all<RoomRecord>("rooms");
    return JSON.stringify({ version: 2, rooms: all }, null, 2);
  }

  async import_rooms(json: string): Promise<{ imported: number; skipped: number }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Invalid backup JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Backup file must be an object");
    }

    const file = parsed as { version?: number; rooms?: unknown[] };
    if (file.version !== 2 || !Array.isArray(file.rooms)) {
      throw new Error("Unsupported backup format");
    }

    const existing = await get_all<RoomRecord>("rooms");
    const existing_ids = new Set(existing.map((r) => r.room_id));
    let imported = 0;
    let skipped = 0;

    for (const room of file.rooms) {
      if (!is_room_record(room)) {
        skipped++;
        continue;
      }
      if (existing_ids.has(room.room_id)) {
        skipped++;
        continue;
      }
      await put("rooms", room, room.room_id);
      existing_ids.add(room.room_id);
      imported++;
    }

    return { imported, skipped };
  }
}

function is_room_record(value: unknown): value is RoomRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RoomRecord>;
  return (
    typeof r.room_id === "string"
    && typeof r.project_id === "string"
    && (r.role === "owner" || r.role === "guest")
    && typeof r.created_at === "number"
    && typeof r.updated_at === "number"
  );
}
