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

function base64url_encode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
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
  str += new Array(5 - (str.length % 4)).join("=");
  str = str.replace(/\-/g, "+").replace(/\_/g, "/");
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
  ws_origin: string,
): Promise<CreatedRoomLinks> {
  const room_id = create_room_id();
  const room_secret = create_room_secret();
  const room_secret_b64 = base64url_encode(room_secret);

  const write_token = await create_share_token(room_secret_b64, room_id, "w");
  const read_token = await create_share_token(room_secret_b64, room_id, "r");

  const base_url = `${ws_origin}/c/${room_id}`;
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

export function get_owned_room(room_id: string): OwnedRoom | null {
  const owned = load_owned_rooms();
  return owned.rooms.find((r) => r.room_id === room_id) ?? null;
}

export function parse_collab_url(url: URL): { room_id: string; token: string } | null {
  const match = url.pathname.match(/^\/c\/(.+)$/);
  if (!match) return null;
  const room_id = match[1];
  const hash = url.hash.slice(1);
  if (!hash || !hash.includes(".")) return null;
  return { room_id, token: hash };
}
