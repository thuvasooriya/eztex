import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import { worker_client } from "../lib/worker_client";
import type { AppSettings } from "../lib/settings_store";
import logo_svg from "/logo.svg?raw";

type SettingsTab = "about" | "settings";

type Props = {
  show: boolean;
  on_close: () => void;
  active_tab: SettingsTab;
  on_tab_change: (tab: SettingsTab) => void;
  settings: AppSettings;
  on_update_setting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  on_clear_cache: () => void;
  on_reset_all: () => void;
  version_info: { version: string; commit: string; built: string };
  on_start_tour?: () => void;
};

function format_cache_size(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const SettingsModal: Component<Props> = (props) => {
  const [cache_bytes, set_cache_bytes] = createSignal(0);
  const [clearing_cache, set_clearing_cache] = createSignal(false);
  let estimate_opfs_timer: ReturnType<typeof setTimeout> | undefined;
  let mounted = true;

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
      try {
        const cache_dir = await root.getDirectoryHandle("eztex-cache");
        await walk(cache_dir);
      } catch { /* cache dir doesn't exist yet */ }
      if (mounted) set_cache_bytes(total);
    } catch {
      if (mounted) set_cache_bytes(0);
    }
  }

  async function handle_clear_cache() {
    set_clearing_cache(true);
    try {
      await props.on_clear_cache();
      await estimate_opfs();
    } finally {
      if (mounted) set_clearing_cache(false);
    }
  }

  onMount(() => {
    void estimate_opfs();
  });

  onCleanup(() => {
    mounted = false;
    if (estimate_opfs_timer !== undefined) clearTimeout(estimate_opfs_timer);
  });

  createEffect(() => {
    if (!props.show) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.on_close();
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  createEffect(() => {
    const s = worker_client.status();
    if (estimate_opfs_timer !== undefined) {
      clearTimeout(estimate_opfs_timer);
      estimate_opfs_timer = undefined;
    }
    if (s === "success" || s === "error") {
      estimate_opfs_timer = setTimeout(estimate_opfs, 300);
    }
  });

  return (
    <AnimatedShow when={props.show}>
      <div class="info-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.on_close(); }}>
        <div class="info-modal">
          <button class="info-modal-close" onClick={props.on_close} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <div class="settings-tabs" role="tablist" aria-label="Settings sections">
            <button class={`settings-tab ${props.active_tab === "settings" ? "active" : ""}`} role="tab" aria-selected={props.active_tab === "settings"} aria-label="Settings" onClick={() => props.on_tab_change("settings")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
            <button class={`settings-tab ${props.active_tab === "about" ? "active" : ""}`} role="tab" aria-selected={props.active_tab === "about"} aria-label="About" onClick={() => props.on_tab_change("about")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
            </button>
          </div>

          <Show when={props.active_tab === "settings"}>
            <div class="settings-content" role="tabpanel">
              <div class="settings-group-title">Safety</div>
              <div class="setting-row">
                <div class="setting-label">
                  <div class="setting-title">Warn before closing</div>
                  <div class="setting-desc">Show a browser confirmation when pending changes have not been saved.</div>
                </div>
                <label class="toggle-switch">
                  <input type="checkbox" checked={props.settings.warn_before_close} onChange={(e) => props.on_update_setting("warn_before_close", e.currentTarget.checked)} />
                  <span class="toggle-slider" />
                </label>
              </div>

              <div class="settings-group-title">Editor</div>
              <div class="setting-row">
                <div class="setting-label">
                  <div class="setting-title">Vim mode</div>
                  <div class="setting-desc">Use Vim keybindings in the editor.</div>
                </div>
                <label class="toggle-switch">
                  <input type="checkbox" checked={props.settings.vim_mode} onChange={(e) => props.on_update_setting("vim_mode", e.currentTarget.checked)} />
                  <span class="toggle-slider" />
                </label>
              </div>
              <div class="setting-row">
                <div class="setting-label">
                  <div class="setting-title">Word wrap</div>
                  <div class="setting-desc">Wrap long editor lines instead of scrolling horizontally.</div>
                </div>
                <label class="toggle-switch">
                  <input type="checkbox" checked={props.settings.word_wrap} onChange={(e) => props.on_update_setting("word_wrap", e.currentTarget.checked)} />
                  <span class="toggle-slider" />
                </label>
              </div>
              <div class="setting-row">
                <div class="setting-label">
                  <div class="setting-title">Editor font size</div>
                  <div class="setting-desc">Adjust editor and line-number text size.</div>
                </div>
                <select class="settings-select" value={props.settings.editor_font_size} onChange={(e) => props.on_update_setting("editor_font_size", e.currentTarget.value as "small" | "medium" | "large") }>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </div>

            </div>
          </Show>

          <Show when={props.active_tab === "about"}>
            <div class="settings-content about-content" role="tabpanel">
              <div class="info-modal-logo" innerHTML={logo_svg} />
              <div class="info-modal-name">eztex</div>
              <p class="info-modal-desc">A fast, local-first LaTeX editor that runs entirely in your browser. No server, no signup -- just open and write.</p>
              <div class="info-modal-links">
                <a class="info-modal-link" href="https://github.com/thuvasooriya/eztex" target="_blank" rel="noopener">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                  GitHub
                </a>
                <a class="info-modal-link donate" href="https://github.com/sponsors/thuvasooriya" target="_blank" rel="noopener">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                  Donate
                </a>
              </div>
              <Show when={props.version_info.version || props.version_info.commit || props.version_info.built}>
                <div class="info-modal-divider" />
                <div class="info-modal-desc">
                  <Show when={props.version_info.version}>Version {props.version_info.version}</Show>
                  <Show when={props.version_info.commit}> Commit {props.version_info.commit}</Show>
                  <Show when={props.version_info.built}> Built {props.version_info.built}</Show>
                </div>
              </Show>
              <div class="info-modal-divider" />
              <div class="info-modal-actions">
                <button class="info-modal-action" onClick={() => { props.on_close(); props.on_start_tour?.(); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>
                  </svg>
                  Start tutorial
                </button>
                <Show when={cache_bytes() > 0}>
                  <button
                    class={`info-modal-action ${clearing_cache() ? "clearing" : ""}`}
                    onClick={() => { void handle_clear_cache(); }}
                    disabled={clearing_cache()}
                    title="Clear cached bundles, format files, and compiled outputs. Projects and room data are preserved."
                    aria-label="Clear cached bundles, format files, and compiled outputs. Projects and room data are preserved."
                  >
                    <Show
                      when={!clearing_cache()}
                      fallback={
                        <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 12a9 9 0 11-6.2-8.6" />
                        </svg>
                      }
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </Show>
                    Clear cache ({format_cache_size(cache_bytes())})
                  </button>
                </Show>
                <button class="info-modal-action danger" onClick={props.on_reset_all}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                  </svg>
                  Reset everything
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </AnimatedShow>
  );
};

export default SettingsModal;
