import { type Component, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { worker_client } from "../lib/worker_client";
import { read_zip, write_zip } from "../lib/zip_utils";
import type { ProjectStore } from "../lib/project_store";

type Props = {
  store: ProjectStore;
  on_toggle_files?: () => void;
  on_toggle_preview?: () => void;
  files_visible?: boolean;
  preview_visible?: boolean;
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
  const [watch_enabled, set_watch_enabled] = createSignal(false);
  let compile_timeout: ReturnType<typeof setTimeout>;
  let skip_first = true;
  let zip_input_ref: HTMLInputElement | undefined;
  let folder_input_ref: HTMLInputElement | undefined;

  function handle_compile() {
    const files = { ...props.store.files };
    worker_client.compile({ files, main: props.store.main_file() });
  }

  // watch mode: auto-compile on content changes
  createEffect(() => {
    void props.store.get_content(props.store.current_file());
    if (skip_first) { skip_first = false; return; }
    if (!watch_enabled() || !worker_client.ready() || worker_client.compiling()) return;
    clearTimeout(compile_timeout);
    compile_timeout = setTimeout(handle_compile, 1500);
  });

  onCleanup(() => clearTimeout(compile_timeout));

  // file actions (moved from FilePanel)
  function handle_add() {
    const name = prompt("File name (e.g. chapter1.tex):");
    if (!name || name.trim() === "") return;
    props.store.add_file(name.trim());
  }

  async function handle_zip_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const files = await read_zip(file);
      if (Object.keys(files).length === 0) { alert("No .tex files found in zip."); return; }
      props.store.load_files(files);
    } catch (err: any) {
      alert("Failed to read zip: " + err.message);
    }
    input.value = "";
  }

  async function handle_folder_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file_list = input.files;
    if (!file_list || file_list.length === 0) return;
    const files: Record<string, string> = {};
    for (const file of Array.from(file_list)) {
      const path = file.webkitRelativePath || file.name;
      const parts = path.split("/");
      const name = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
      if (name.startsWith(".") || name.startsWith("__MACOSX")) continue;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      const text_exts = new Set(["tex", "sty", "cls", "bib", "bst", "def", "cfg", "txt", "md"]);
      if (!text_exts.has(ext)) continue;
      const content = await file.text();
      files[name] = content;
    }
    if (Object.keys(files).length === 0) { alert("No .tex files found in folder."); return; }
    props.store.load_files(files);
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

  return (
    <header class="toolbar">
      <div class="toolbar-left">
        <Logo />
        <div class="toolbar-divider" />
        <Show when={props.on_toggle_files}>
          <button
            class={`toolbar-toggle ${props.files_visible ? "active" : ""}`}
            onClick={props.on_toggle_files}
            title="Toggle file panel"
          >
            {/* panel-left icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </Show>
        <div class="toolbar-file-actions">
            <button class="toolbar-toggle" title="New file" onClick={handle_add}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button class="toolbar-toggle" title="Upload zip" onClick={() => zip_input_ref?.click()}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            <button class="toolbar-toggle" title="Upload folder" onClick={() => folder_input_ref?.click()}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
            </button>
            <button class="toolbar-toggle" title="Download zip" onClick={handle_download_zip}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        <input ref={zip_input_ref} type="file" accept=".zip" style={{ display: "none" }} onChange={handle_zip_upload} />
        <input ref={folder_input_ref} type="file" {...{ webkitdirectory: true } as any} style={{ display: "none" }} onChange={handle_folder_upload} />
      </div>
      <div class="toolbar-right">
        <Show when={props.on_toggle_preview}>
          <button
            class={`toolbar-toggle ${props.preview_visible ? "active" : ""}`}
            onClick={props.on_toggle_preview}
            title="Toggle preview"
          >
            {/* panel-right icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </Show>
        <button
          class={`toolbar-toggle watch ${watch_enabled() ? "active" : ""}`}
          onClick={() => set_watch_enabled(!watch_enabled())}
          title={watch_enabled() ? "Disable auto-compile" : "Enable auto-compile"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          class="toolbar-btn primary"
          onClick={handle_compile}
          disabled={!worker_client.ready() || worker_client.compiling()}
        >
          <Show
            when={!worker_client.compiling()}
            fallback={<span class="compile-spinner" />}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </Show>
          {worker_client.compiling() ? "Compiling..." : "Compile"}
        </button>
      </div>
    </header>
  );
};

export default Toolbar;
