import { get_jjk_name } from "./jjk_names";

export interface UserIdentity {
  user_id: string;
  display_name: string;
  color_hue: number;
  color: string;
  created_at: number;
  kind?: "human" | "agent";
}

const STORAGE_KEY = "eztex_identity";

function hash_to_hue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
  }
  return (Math.abs(hash) % 37) * 10;
}

export function identity_color(hue: number): string {
  return `hsl(${hue}, 70%, 60%)`;
}

function generate_name(id: string): string {
  return get_jjk_name(id);
}

function create_identity(): UserIdentity {
  const user_id = crypto.randomUUID();
  const color_hue = hash_to_hue(user_id);
  const identity: UserIdentity = {
    user_id,
    display_name: generate_name(user_id),
    color_hue,
    color: identity_color(color_hue),
    created_at: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function get_or_create_identity(): UserIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.user_id && parsed.display_name) {
        if (!parsed.color) {
          parsed.color = identity_color(parsed.color_hue ?? hash_to_hue(parsed.user_id));
        }
        return parsed as UserIdentity;
      }
    }
  } catch {
    // fallthrough
  }
  return create_identity();
}

export function update_display_name(name: string): UserIdentity {
  const identity = get_or_create_identity();
  identity.display_name = name.trim() || identity.display_name;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
