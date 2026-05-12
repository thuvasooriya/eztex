import { get_share_room_url } from "./collab_config";

const OWNED_ROOMS_KEY = "eztex_owned_rooms";

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

function base64url_encode(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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

function base64url_decode(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4;
  str = str.replace(/\-/g, "+").replace(/\_/g, "/") + "=".repeat(pad);
  const bytes = new Uint8Array(
    atob(str).split("").map((c) => c.charCodeAt(0)),
  );
  return bytes;
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

  const owned = load_owned_rooms();
  owned.rooms.push({
    room_id,
    project_id,
    room_secret: room_secret_b64,
    created_at: Date.now(),
    name: project_name,
  });
  save_owned_rooms(owned);

  return { room_id, room_secret_b64, write_url, read_url };
}

export function load_owned_rooms(): OwnedRoomsFile {
  try {
    const raw = localStorage.getItem(OWNED_ROOMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.rooms)) {
        return parsed as OwnedRoomsFile;
      }
    }
  } catch {
    // fallthrough
  }
  return { version: 1, rooms: [] };
}

export function save_owned_rooms(owned: OwnedRoomsFile): void {
  localStorage.setItem(OWNED_ROOMS_KEY, JSON.stringify(owned));
}

export function get_share_token_permission(token: string): "read" | "write" | null {
  const dot = token.indexOf(".");
  const prefix = dot >= 0 ? token.slice(0, dot) : token;
  if (prefix === "r") return "read";
  if (prefix === "w") return "write";
  return null;
}

export function get_owned_room(room_id: string): OwnedRoom | null {
  const owned = load_owned_rooms();
  return owned.rooms.find((r) => r.room_id === room_id) ?? null;
}

export async function get_owned_room_links(room_id: string): Promise<OwnedRoomLinks | null> {
  const owned = get_owned_room(room_id);
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

export function export_rooms_backup(): string {
  const owned = load_owned_rooms();
  return JSON.stringify({ version: 1, rooms: owned.rooms }, null, 2);
}

export function import_rooms_backup(json: string): RoomsImportResult {
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

  const owned = load_owned_rooms();
  const existing_ids = new Set(owned.rooms.map((room) => room.room_id));
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
    owned.rooms.push(room);
    existing_ids.add(room.room_id);
    imported++;
  }

  if (imported > 0) {
    owned.rooms.sort((a, b) => b.created_at - a.created_at);
    save_owned_rooms(owned);
  }

  return { imported, skipped };
}

export function download_rooms_backup(): void {
  const blob = new Blob([export_rooms_backup()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eztex-rooms-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function load_rooms_backup_from_file(file: File): Promise<RoomsImportResult> {
  const text = await file.text();
  return import_rooms_backup(text);
}

export function parse_collab_url(url: URL): { room_id: string; token: string } | null {
  const match = url.pathname.match(/^\/c\/(.+)$/);
  if (!match) return null;
  const room_id = match[1];
  const hash = url.hash.slice(1);
  if (!hash || !hash.includes(".")) return null;
  return { room_id, token: hash };
}
