export async function compute_hash(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url_encode(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function base64url_decode(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4;
  str = str.replace(/\-/g, "+").replace(/\_/g, "/") + "=".repeat(pad);
  return new Uint8Array(atob(str).split("").map((c) => c.charCodeAt(0)));
}

export function fnv1a_hash_sync(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
