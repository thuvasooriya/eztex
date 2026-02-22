import { type Component, createSignal, onMount, createEffect, Show } from "solid-js";
import { worker_client } from "../lib/worker_client";
import { clear_bundle_cache } from "../lib/project_persist";

const CachePill: Component = () => {
  const [cache_bytes, set_cache_bytes] = createSignal(0);
  const [clearing, set_clearing] = createSignal(false);

  function format_size(bytes: number): string {
    if (bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function estimate_opfs() {
    try {
      const root = await navigator.storage.getDirectory();
      let total = 0;
      async function walk(dir: FileSystemDirectoryHandle) {
        for await (const [, handle] of (dir as any).entries()) {
          if (handle.kind === "file") {
            const file = await (handle as FileSystemFileHandle).getFile();
            total += file.size;
          } else if (handle.kind === "directory") {
            await walk(handle as FileSystemDirectoryHandle);
          }
        }
      }
      // only measure eztex-cache, not project files
      try {
        const cache_dir = await root.getDirectoryHandle("eztex-cache");
        await walk(cache_dir);
      } catch {
        // cache dir doesn't exist yet
      }
      set_cache_bytes(total);
    } catch {
      set_cache_bytes(0);
    }
  }

  onMount(estimate_opfs);

  // re-estimate after compile finishes
  createEffect(() => {
    const s = worker_client.status();
    if (s === "success" || s === "error") {
      setTimeout(estimate_opfs, 300);
    }
  });

  async function handle_clear() {
    set_clearing(true);
    try {
      worker_client.clear_cache();
      await clear_bundle_cache();
    } catch { /* noop */ }
    await estimate_opfs();
    set_clearing(false);
  }

  const threshold = 10 * 1024 * 1024; // 10 MB

  return (
    <Show when={cache_bytes() >= threshold || clearing()}>
      <div class="cache-pill-container">
        <button
          class={`cache-pill ${clearing() ? "clearing" : ""}`}
          onClick={handle_clear}
          disabled={clearing()}
          title="Clear OPFS cache"
        >
          <Show
            when={!clearing()}
            fallback={
              <svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 11-6.2-8.6" />
              </svg>
            }
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </Show>
          <span class="cache-pill-label">Cache {format_size(cache_bytes())}</span>
        </button>
      </div>
    </Show>
  );
};

export default CachePill;
