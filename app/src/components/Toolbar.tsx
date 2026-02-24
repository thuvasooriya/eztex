import { type Component, Show, For, onCleanup, onMount, createSignal, createEffect } from "solid-js";
import { worker_client, type LogEntry } from "../lib/worker_client";
import ProgressBar from "./ProgressBar";
import { create_watch_controller } from "../lib/watch_controller";
import { read_zip, write_zip } from "../lib/zip_utils";
import type { ProjectStore } from "../lib/project_store";
import { is_binary, is_text_ext } from "../lib/project_store";
import type { ProjectFiles } from "../lib/project_store";
import { save_pdf, clear_project, clear_bundle_cache } from "../lib/project_persist";
import type { LocalFolderSync, ConflictInfo } from "../lib/local_folder_sync";

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
};

const Logo: Component = () => (
  <span class="logo" aria-label="eztex">
    <svg class="logo-mark" viewBox="231 276 618 528" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#fefefe" d=" M 393.41 276.54 C 406.57 275.40 419.80 276.08 433.00 275.99 C 563.01 276.03 693.02 275.96 823.03 276.01 C 830.00 275.83 838.05 276.39 843.08 281.92 C 849.44 287.84 849.73 297.46 847.51 305.36 C 818.67 401.58 789.97 497.85 761.22 594.10 C 759.43 600.93 756.35 608.21 749.96 611.95 C 743.79 616.10 735.97 614.56 729.01 615.09 C 679.00 614.94 628.99 614.97 578.99 615.08 C 571.62 614.64 563.67 615.80 556.94 612.07 C 550.10 609.08 546.61 601.41 546.38 594.28 C 546.00 586.32 551.43 579.95 556.70 574.71 C 590.34 541.34 623.64 507.64 657.34 474.32 C 661.91 469.83 665.74 463.78 664.95 457.09 C 664.20 446.61 654.59 437.54 643.99 438.17 C 550.66 437.74 457.31 438.13 363.97 438.02 C 354.08 439.09 343.85 432.03 341.64 422.34 C 340.13 417.16 341.85 412.03 343.12 407.06 C 354.58 368.90 366.23 330.80 377.53 292.60 C 380.02 285.20 385.07 277.71 393.41 276.54 Z"/>
      <path fill="#fefefe" d=" M 337.43 465.61 C 348.92 464.51 360.48 464.99 372.00 464.96 C 415.34 465.04 458.67 465.02 502.01 464.92 C 510.52 465.29 520.76 463.78 527.31 470.68 C 535.87 477.84 536.35 492.50 528.21 500.19 C 497.85 530.83 467.21 561.20 436.74 591.74 C 430.02 598.69 422.30 604.84 417.12 613.13 C 411.72 623.83 418.68 637.83 429.86 641.16 C 435.15 642.17 440.61 641.88 445.99 642.09 C 537.67 641.96 629.35 641.92 721.03 642.07 C 733.95 642.73 743.25 657.57 738.56 669.58 C 729.17 702.75 719.39 735.82 710.01 769.00 C 707.04 778.45 705.64 788.64 700.04 797.03 C 695.02 803.04 686.43 804.45 679.03 804.01 C 537.34 803.97 395.65 804.04 253.97 803.98 C 248.28 804.31 242.28 802.91 237.96 799.05 C 231.84 794.00 229.86 785.20 231.64 777.66 C 261.09 679.78 290.60 581.89 319.99 483.99 C 321.81 475.29 328.01 466.49 337.43 465.61 Z"/>
    </svg>
    <span class="logo-tex">tex</span>
  </span>
);

const Toolbar: Component<Props> = (props) => {
  let zip_input_ref: HTMLInputElement | undefined;
  let folder_input_ref: HTMLInputElement | undefined;
  let file_input_ref: HTMLInputElement | undefined;
  let upload_btn_ref: HTMLDivElement | undefined;
  let download_btn_ref: HTMLDivElement | undefined;
  let logo_btn_ref: HTMLDivElement | undefined;

  const [show_upload_menu, set_show_upload_menu] = createSignal(false);
  const [show_download_menu, set_show_download_menu] = createSignal(false);
  const [show_logo_menu, set_show_logo_menu] = createSignal(false);
  const [show_logs, set_show_logs] = createSignal(false);
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

  // close logo menu on click outside
  createEffect(() => {
    if (!show_logo_menu()) return;
    const handler = (e: MouseEvent) => {
      if (logo_btn_ref && !logo_btn_ref.contains(e.target as Node)) {
        set_show_logo_menu(false);
      }
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  // close logs popover on click outside
  createEffect(() => {
    if (!show_logs()) return;
    const handler = (e: MouseEvent) => {
      if (compile_group_ref && !compile_group_ref.contains(e.target as Node)) {
        set_show_logs(false);
      }
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  // auto-scroll logs when new entries arrive and popover is open
  createEffect(() => {
    void worker_client.logs();
    if (show_logs() && log_ref) {
      requestAnimationFrame(() => { log_ref!.scrollTop = log_ref!.scrollHeight; });
    }
  });

  // auto-open logs on compile error
  createEffect(() => {
    if (worker_client.status() === "error") set_show_logs(true);
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
    set_show_logo_menu(false);
    await clear_project();
    await clear_bundle_cache();
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
        <div class="logo-menu-wrapper" ref={logo_btn_ref}>
          <button class="logo-btn" title="eztex menu" onClick={() => set_show_logo_menu(v => !v)}>
            <Logo />
          </button>
          <Show when={show_logo_menu()}>
            <div class="upload-dropdown logo-dropdown">
              <Show when={cache_bytes() > 0}>
                <button
                  class={`upload-dropdown-item ${clearing_cache() ? "clearing" : ""}`}
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
              <button class="upload-dropdown-item danger-item" onClick={handle_reset}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                </svg>
                Reset everything
              </button>
            </div>
          </Show>
        </div>
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
            <div class="compile-logs-popover">
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
            onClick={() => set_show_logs(v => !v)}
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
