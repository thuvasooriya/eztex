import { type Component, Show, For, onCleanup, onMount, createSignal, createEffect, untrack } from "solid-js";
import { worker_client, type LogEntry } from "../lib/worker_client";
import ProgressBar from "./ProgressBar";
import { create_watch_controller } from "../lib/watch_controller";
import { read_zip, write_zip } from "../lib/zip_utils";
import type { ProjectStore } from "../lib/project_store";
import { is_binary, is_text_ext } from "../lib/project_store";
import type { ProjectFiles } from "../lib/project_store";
import { save_pdf, clear_bundle_cache, reset_all_persistence } from "../lib/project_persist";
import type { LocalFolderSync, ConflictInfo } from "../lib/local_folder_sync";
import logo_svg from "/logo.svg?raw";

type Props = {
  store: ProjectStore;
  on_toggle_files?: () => void;
  on_toggle_preview?: () => void;
  on_toggle_split?: () => void;
  files_visible?: boolean;
  preview_visible?: boolean;
  split_dir?: "horizontal" | "vertical";
  swap_mode?: boolean;
  folder_sync?: LocalFolderSync;
  on_upload_conflicts?: (conflicts: ConflictInfo[]) => void;
  reconnect_folder?: string | null;
  on_reconnect?: () => void;
  on_dismiss_reconnect?: () => void;
  on_start_tour?: () => void;
};

const Logo: Component = () => (
  <span class="logo" aria-label="eztex" innerHTML={logo_svg} />
);

const Toolbar: Component<Props> = (props) => {
  let zip_input_ref: HTMLInputElement | undefined;
  let folder_input_ref: HTMLInputElement | undefined;
  let file_input_ref: HTMLInputElement | undefined;
  let upload_btn_ref: HTMLDivElement | undefined;
  let download_btn_ref: HTMLDivElement | undefined;

  const [show_upload_menu, set_show_upload_menu] = createSignal(false);
  const [show_download_menu, set_show_download_menu] = createSignal(false);
  const [show_info_modal, set_show_info_modal] = createSignal(false);
  const [show_logs, set_show_logs] = createSignal(false);
  const [logs_pinned, set_logs_pinned] = createSignal(false);
  const [logs_auto_opened, set_logs_auto_opened] = createSignal(false);
  let compile_group_ref: HTMLDivElement | undefined;
  let log_ref: HTMLDivElement | undefined;

  // cache state (moved from CachePill)
  const [cache_bytes, set_cache_bytes] = createSignal(0);
  const [clearing_cache, set_clearing_cache] = createSignal(false);

  function format_cache_size(bytes: number): string {
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
      try {
        const cache_dir = await root.getDirectoryHandle("eztex-cache");
        await walk(cache_dir);
      } catch { /* cache dir doesn't exist yet */ }
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

  async function handle_clear_cache() {
    set_clearing_cache(true);
    try {
      worker_client.clear_cache();
      await clear_bundle_cache();
    } catch { /* noop */ }
    await estimate_opfs();
    set_clearing_cache(false);
  }

  // close upload menu on click outside
  createEffect(() => {
    if (!show_upload_menu()) return;
    const handler = (e: MouseEvent) => {
      if (upload_btn_ref && !upload_btn_ref.contains(e.target as Node)) {
        set_show_upload_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // close download menu on click outside
  createEffect(() => {
    if (!show_download_menu()) return;
    const handler = (e: MouseEvent) => {
      if (download_btn_ref && !download_btn_ref.contains(e.target as Node)) {
        set_show_download_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // close info modal on Escape
  createEffect(() => {
    if (!show_info_modal()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") set_show_info_modal(false);
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  // close logs popover on click outside (interceptor overlay handles iframe clicks)
  function dismiss_logs() {
    if (logs_pinned()) return;
    set_show_logs(false);
    set_logs_auto_opened(false);
  }

  function handle_copy_logs() {
    const text = worker_client.logs().map(e => e.msg).join("\n");
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function handle_clear_logs() {
    worker_client.clear_logs();
  }

  // auto-scroll logs when new entries arrive and popover is open
  createEffect(() => {
    void worker_client.logs();
    if (show_logs() && log_ref) {
      requestAnimationFrame(() => { log_ref!.scrollTop = log_ref!.scrollHeight; });
    }
  });

  // auto-open logs on compile error, auto-close on resolution
  // edge-triggered: only opens on transition TO error, not while error persists
  let prev_log_status: string | undefined;
  createEffect(() => {
    const s = worker_client.status();
    const was = prev_log_status;
    prev_log_status = s;
    if (s === "error" && was !== "error") {
      if (!untrack(show_logs) && !untrack(logs_pinned)) {
        set_logs_auto_opened(true);
        set_show_logs(true);
      }
    } else if ((s === "success" || s === "idle") && was === "error") {
      if (untrack(logs_auto_opened) && !untrack(logs_pinned)) {
        set_show_logs(false);
        set_logs_auto_opened(false);
      }
    }
  });

  // compile success flash
  let status_btn_ref: HTMLButtonElement | undefined;
  createEffect(() => {
    if (worker_client.status() === "success" && status_btn_ref) {
      status_btn_ref.classList.remove("flash-success");
      void status_btn_ref.offsetWidth;
      status_btn_ref.classList.add("flash-success");
    }
  });

  function log_class(entry: LogEntry): string {
    if (entry.cls.includes("error")) return "log-line log-error";
    if (entry.cls.includes("warn")) return "log-line log-warn";
    if (entry.cls.includes("info")) return "log-line log-info";
    return "log-line";
  }

  function status_color(): string {
    const s = worker_client.status();
    if (s === "loading" || s === "compiling") return "var(--yellow)";
    if (s === "success") return "var(--green)";
    if (s === "error") return "var(--red)";
    return "var(--fg-dim)";
  }

  // watch controller -- imperative state machine, no SolidJS reactive scheduling
  const watch = create_watch_controller({
    get_files: () => props.store.files,
    get_main: () => props.store.main_file(),
    is_ready: () => worker_client.ready() && !worker_client.compiling(),
    compile: (req) => worker_client.compile(req),
    cancel_and_recompile: (req) => worker_client.cancel_and_recompile(req),
  });

  // wire imperative callbacks (not reactive effects)
  props.store.on_change(() => watch.notify_change());
  worker_client.on_compile_done(() => {
    watch.notify_compile_done();
    // persist PDF to OPFS (and synced folder if active) after successful compile
    const url = worker_client.pdf_url();
    if (url) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          save_pdf(bytes).catch(() => {});
          if (props.folder_sync?.state().active) {
            props.folder_sync.write_pdf(bytes).catch(() => {});
          }
        })
        .catch(() => {});
    }
    // persist synctex is now handled by worker_client on parse completion
  });

  onCleanup(() => watch.cleanup());

  function handle_compile() {
    const files = { ...props.store.files };
    worker_client.compile({ files, main: props.store.main_file() });
  }

  // compare content for equality (handles both string and Uint8Array)
  function content_equal(a: string | Uint8Array, b: string | Uint8Array): boolean {
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) { if (a[i] !== b[i]) return false; }
      return true;
    }
    return false;
  }

  // merge uploaded files into existing project with conflict detection
  // if the project only has default content, replace entirely (load_files)
  // otherwise, merge non-conflicting files and report conflicts
  function merge_or_load(incoming: ProjectFiles) {
    const existing_names = props.store.file_names();
    const is_default_project = existing_names.length === 1 && existing_names[0] === "main.tex";

    if (is_default_project) {
      props.store.load_files(incoming);
      return;
    }

    const non_conflicting: ProjectFiles = {};
    const conflicts: ConflictInfo[] = [];

    for (const [name, content] of Object.entries(incoming)) {
      const existing = props.store.files[name];
      if (existing === undefined) {
        non_conflicting[name] = content;
      } else if (content_equal(existing, content)) {
        // same content, skip
      } else {
        conflicts.push({
          path: name,
          eztex_content: existing,
          disk_content: content,
          eztex_hash: "",
          disk_hash: "",
        });
      }
    }

    if (Object.keys(non_conflicting).length > 0) {
      props.store.merge_files(non_conflicting);
    }

    if (conflicts.length > 0 && props.on_upload_conflicts) {
      props.on_upload_conflicts(conflicts);
    }
  }

  async function handle_zip_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const files = await read_zip(file);
      if (Object.keys(files).length === 0) { alert("No .tex files found in zip."); return; }
      merge_or_load(files);
    } catch (err: any) {
      alert("Failed to read zip: " + err.message);
    }
    input.value = "";
  }

  async function handle_folder_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file_list = input.files;
    if (!file_list || file_list.length === 0) return;
    const files: ProjectFiles = {};
    for (const file of Array.from(file_list)) {
      const path = file.webkitRelativePath || file.name;
      const parts = path.split("/");
      const name = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
      if (name.startsWith(".") || name.startsWith("__MACOSX")) continue;
      if (is_binary(name)) {
        const buf = await file.arrayBuffer();
        files[name] = new Uint8Array(buf);
      } else if (is_text_ext(name)) {
        files[name] = await file.text();
      }
    }
    if (Object.keys(files).length === 0) { alert("No supported files found in folder."); return; }
    merge_or_load(files);
    input.value = "";
  }

  async function handle_file_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file_list = input.files;
    if (!file_list || file_list.length === 0) return;
    const files: ProjectFiles = {};
    for (const file of Array.from(file_list)) {
      const name = file.name;
      if (name.startsWith(".")) continue;
      if (is_binary(name)) {
        const buf = await file.arrayBuffer();
        files[name] = new Uint8Array(buf);
      } else if (is_text_ext(name)) {
        files[name] = await file.text();
      }
    }
    if (Object.keys(files).length === 0) { alert("No supported files found."); return; }
    merge_or_load(files);
    input.value = "";
  }

  async function handle_download_zip() {
    const blob = await write_zip(props.store.files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "project.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handle_reset() {
    if (!confirm("Reset everything? This deletes all project files and cached bundles.")) return;
    set_show_info_modal(false);
    worker_client.clear_cache();
    await reset_all_persistence();
    window.location.reload();
  }

  function handle_download_pdf() {
    const url = worker_client.pdf_url();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.pdf";
    a.click();
  }

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        <button class="logo-btn" title="About eztex" onClick={() => set_show_info_modal(true)}>
          <Logo />
        </button>
        <Show when={show_info_modal()}>
          <div class="info-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) set_show_info_modal(false); }}>
            <div class="info-modal">
              <button class="info-modal-close" onClick={() => set_show_info_modal(false)} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
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
              <div class="info-modal-divider" />
              <div class="info-modal-actions">
                <button class="info-modal-action" onClick={() => { set_show_info_modal(false); props.on_start_tour?.(); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>
                  </svg>
                  Start tutorial
                </button>
                <Show when={cache_bytes() > 0}>
                  <button
                    class={`info-modal-action ${clearing_cache() ? "clearing" : ""}`}
                    onClick={handle_clear_cache}
                    disabled={clearing_cache()}
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
                <button class="info-modal-action danger" onClick={handle_reset}>
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
          </div>
        </Show>
        <div class="toolbar-divider" />
        <Show when={props.on_toggle_files}>
          <button
            class={`toolbar-toggle ${props.files_visible ? "active" : ""}`}
            onClick={props.on_toggle_files}
            title="Toggle file panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </Show>
        <div class="toolbar-file-actions">
            <div class="upload-menu-wrapper" ref={upload_btn_ref}>
              <button class="toolbar-toggle" title="Upload files or folder" onClick={() => set_show_upload_menu(v => !v)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="17,8 12,3 7,8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
              <Show when={show_upload_menu()}>
                <div class="upload-dropdown">
                  <button class="upload-dropdown-item" onClick={() => { file_input_ref?.click(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    Upload Files
                  </button>
                  <button class="upload-dropdown-item" onClick={() => { folder_input_ref?.click(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    Upload Folder
                  </button>
                  <button class="upload-dropdown-item" onClick={() => { zip_input_ref?.click(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/>
                    </svg>
                    Import Zip
                  </button>
                  <Show when={props.folder_sync?.is_supported() && !props.folder_sync?.state().active}>
                    <div class="upload-dropdown-divider" />
                    <button class="upload-dropdown-item" onClick={() => { props.folder_sync?.open_folder(); set_show_upload_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-sync-icon lucide-folder-sync"><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/><path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/><path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/>
                    </svg>
                      Open Folder
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
            <div class="upload-menu-wrapper" ref={download_btn_ref}>
              <button class="toolbar-toggle" title="Download" onClick={() => set_show_download_menu(v => !v)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7,10 12,15 17,10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
              <Show when={show_download_menu()}>
                <div class="upload-dropdown">
                  <Show when={worker_client.pdf_url()}>
                    <button class="upload-dropdown-item" onClick={() => { handle_download_pdf(); set_show_download_menu(false); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                      </svg>
                      Download PDF
                    </button>
                  </Show>
                  <button class="upload-dropdown-item" onClick={() => { handle_download_zip(); set_show_download_menu(false); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></svg>
                    Export Zip
                  </button>
                </div>
              </Show>
            </div>
          </div>
        <input ref={zip_input_ref} type="file" accept=".zip" style={{ display: "none" }} onChange={handle_zip_upload} />
        <input ref={file_input_ref} type="file" multiple accept=".tex,.bib,.sty,.cls,.png,.jpg,.jpeg,.gif,.webp,.svg,.ttf,.otf,.woff,.woff2,.pdf" style={{ display: "none" }} onChange={handle_file_upload} />
        <input ref={folder_input_ref} type="file" {...{ webkitdirectory: true } as any} style={{ display: "none" }} onChange={handle_folder_upload} />
      </div>

      {/* center: reconnect pill (reusable notification area) */}
      <Show when={props.reconnect_folder}>
        <div class="toolbar-center-pill">
          <button class="reconnect-pill-btn" onClick={props.on_reconnect}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Reconnect
          </button>
          <span class="reconnect-pill-text">to <strong>{props.reconnect_folder}/</strong></span>
          <button class="reconnect-pill-dismiss" onClick={props.on_dismiss_reconnect}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </Show>

      <div class="toolbar-right">
        <div class="compile-group" ref={compile_group_ref}>
          <Show when={show_logs()}>
            <div class="click-interceptor" onMouseDown={dismiss_logs} />
            <div class="compile-logs-popover">
              <div class="popover-action-bar">
                <button
                  class={`icon-btn popover-pin ${logs_pinned() ? "active" : ""}`}
                  title={logs_pinned() ? "Unpin" : "Pin open"}
                  onClick={() => set_logs_pinned(v => !v)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill={logs_pinned() ? "currentColor" : "none"} stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>
                </button>
                <button class="icon-btn" title="Copy all" onClick={handle_copy_logs}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button class="icon-btn" title="Clear log" onClick={handle_clear_logs}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
              <div class="compile-logs-scroll" ref={log_ref}>
                <For each={worker_client.logs()}>
                  {(entry) => <div class={log_class(entry)}>{entry.msg}</div>}
                </For>
                <Show when={worker_client.logs().length === 0}>
                  <div class="log-empty">No logs yet.</div>
                </Show>
              </div>
            </div>
          </Show>
          <button
            ref={status_btn_ref}
            class={`compile-group-status ${show_logs() ? "expanded" : ""}`}
            onClick={() => { set_show_logs(v => !v); set_logs_auto_opened(false); }}
            title="Show compilation logs"
            style={{ color: status_color() }}
          >
            <span class="compile-group-text">{worker_client.status_text()}</span>
            <Show when={worker_client.last_elapsed()}>
              <span class="compile-group-elapsed">{worker_client.last_elapsed()}</span>
            </Show>
          </button>
          <button
            class={`compile-group-watch ${watch.enabled() ? "active" : ""} ${watch.dirty() ? "dirty" : ""}`}
            onClick={() => watch.toggle()}
            title={watch.enabled() ? "Disable auto-compile" : "Enable auto-compile"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-icon lucide-eye"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button
            class="compile-group-play"
            onClick={handle_compile}
            disabled={!worker_client.ready() || worker_client.compiling()}
            title="Compile"
          >
            <Show
              when={!worker_client.compiling()}
              fallback={<span class="compile-spinner" />}
            >
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>
            </Show>
          </button>
        </div>
        <Show when={props.on_toggle_split}>
          <button
            class={`toolbar-toggle${props.swap_mode ? " muted" : ""}`}
            onClick={props.on_toggle_split}
            title={props.split_dir === "horizontal" ? "Switch to stacked layout" : "Switch to side-by-side layout"}
          >
            <Show
              when={props.split_dir === "horizontal"}
              fallback={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                </svg>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </Show>
          </button>
        </Show>
        <Show when={props.on_toggle_preview}>
          <button
            class={`toolbar-toggle ${props.preview_visible ? "active" : ""}`}
            onClick={props.on_toggle_preview}
            title={props.swap_mode
              ? (props.preview_visible ? "Show editor" : "Show PDF")
              : "Toggle preview"
            }
          >
            <Show
              when={props.swap_mode}
              fallback={
                <Show
                  when={props.split_dir === "vertical"}
                  fallback={
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                  }
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="3" y1="15" x2="21" y2="15" />
                  </svg>
                </Show>
              }
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polyline points="17 1 21 5 17 9" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <polyline points="7 23 3 19 7 15" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
            </Show>
          </button>
        </Show>
      </div>
      <ProgressBar />
    </header>
  );
};

export default Toolbar;
