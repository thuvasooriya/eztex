function trim_trailing_slash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function get_collab_http_origin(): string {
  const configured = import.meta.env.VITE_COLLAB_ORIGIN?.trim();
  if (configured) {
    return trim_trailing_slash(configured);
  }

  if (typeof window === "undefined") return "";
  if (import.meta.env.DEV && (window.location.port === "5173" || window.location.port === "5174")) {
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }
  return window.location.origin;
}

export function get_share_origin(): string {
  const configured = import.meta.env.VITE_SHARE_ORIGIN?.trim();
  if (configured) {
    return trim_trailing_slash(configured);
  }

  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export function get_collab_ws_url(room_id: string): string {
  const url = new URL(`/collab/ws/${room_id}`, get_collab_http_origin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function get_share_room_url(room_id: string): string {
  return new URL(`/c/${room_id}`, get_share_origin()).toString();
}
