// browser capability detection for File System Access API (local folder sync)

export function supports_folder_sync(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function get_browser_hint(): string | null {
  if (supports_folder_sync()) return null;
  return "Local folder sync requires Chrome or Edge.";
}
