import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import { worker_client } from "../lib/worker_client";
import { read_zip, write_zip } from "../lib/zip_utils";
import type { ProjectStore } from "../lib/project_store";
import { is_binary, is_text_ext, type ProjectFiles } from "../lib/project_store";
import { ProjectRepository } from "../lib/project_repository";
import type { ConflictInfo, LocalFolderSync } from "../lib/local_folder_sync";
import { show_alert_modal, show_choice_modal, show_input_modal } from "../lib/modal_store";

type Props = {
  store: ProjectStore;
  folder_sync: () => LocalFolderSync | null;
  on_upload_conflicts?: (conflicts: ConflictInfo[]) => void;
  on_switch_project?: (id: string) => Promise<void>;
  register_file_triggers?: (file_fn: () => void, folder_fn: () => void, zip_fn: () => void) => void;
  register_project_actions: (import_fn: () => void, export_fn: () => void) => void;
};

const ToolbarFileActions: Component<Props> = (props) => {
  const repo = new ProjectRepository();
  const [show_upload_menu, set_show_upload_menu] = createSignal(false);
  const [show_download_menu, set_show_download_menu] = createSignal(false);
  let zip_input_ref: HTMLInputElement | undefined;
  let folder_input_ref: HTMLInputElement | undefined;
  let file_input_ref: HTMLInputElement | undefined;
  let upload_btn_ref: HTMLDivElement | undefined;
  let download_btn_ref: HTMLDivElement | undefined;

  onMount(() => {
    props.register_file_triggers?.(
      () => file_input_ref?.click(),
      () => folder_input_ref?.click(),
      () => zip_input_ref?.click(),
    );
    props.register_project_actions(
      () => zip_input_ref?.click(),
      () => { void handle_download_zip(); },
    );
  });

  createEffect(() => {
    if (!show_upload_menu()) return;
    const handler = (e: MouseEvent) => {
      if (upload_btn_ref && !upload_btn_ref.contains(e.target as Node)) set_show_upload_menu(false);
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  createEffect(() => {
    if (!show_download_menu()) return;
    const handler = (e: MouseEvent) => {
      if (download_btn_ref && !download_btn_ref.contains(e.target as Node)) set_show_download_menu(false);
    };
    document.addEventListener("click", handler);
    onCleanup(() => document.removeEventListener("click", handler));
  });

  function content_equal(a: string | Uint8Array, b: string | Uint8Array): boolean {
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) { if (a[i] !== b[i]) return false; }
      return true;
    }
    return false;
  }

  async function merge_or_load(incoming: ProjectFiles) {
    const choice = await show_choice_modal({
      title: "Import Files",
      message: "How would you like to import these files?",
      options: [
        { label: "Create new project", value: "new", variant: "primary" },
        { label: "Merge with current", value: "merge", variant: "default" },
        { label: "Replace current", value: "replace", variant: "danger" },
      ],
    });

    if (choice === "new") {
      const name = await show_input_modal({ title: "New Project", message: "Enter a name for the imported project.", placeholder: "Project name", default_value: "Imported Project" });
      if (name === null) return;
      handle_import_as_new_project(incoming, name.trim() || "Imported Project");
      return;
    }
    if (choice === "replace") { props.store.load_files(incoming); return; }
    if (choice === null) return;

    const non_conflicting: ProjectFiles = {};
    const conflicts: ConflictInfo[] = [];
    for (const [name, content] of Object.entries(incoming)) {
      const existing = props.store.files[name];
      if (existing === undefined) non_conflicting[name] = content;
      else if (!content_equal(existing, content)) conflicts.push({ path: name, eztex_content: existing, disk_content: content, eztex_hash: "", disk_hash: "" });
    }
    if (Object.keys(non_conflicting).length > 0) props.store.merge_files(non_conflicting);
    if (conflicts.length > 0 && props.on_upload_conflicts) props.on_upload_conflicts(conflicts);
  }

  async function handle_import_as_new_project(incoming: ProjectFiles, project_name: string) {
    const record = await repo.create_project(project_name);
    const id = record.id;
    const { create_y_project_doc, encode_snapshot: enc_snap, get_or_create_text_file, create_binary_file_ref, set_project_metadata } = await import("../lib/y_project_doc");
    const { compute_hash } = await import("../lib/crypto_utils");
    const yp = create_y_project_doc(id, project_name);
    for (const [path, content] of Object.entries(incoming)) {
      if (content instanceof Uint8Array) {
        const hash = await compute_hash(content);
        await repo.save_blob(id, hash, content);
        create_binary_file_ref(yp, path, hash, content.length);
      } else {
        get_or_create_text_file(yp, path, content);
      }
    }

    let detected_main: string | undefined;
    const tex_files = Object.entries(incoming).filter(([name, content]) => typeof content === "string" && name.endsWith(".tex"));
    const files_with_documentclass = tex_files.filter(([, content]) => (content as string).includes("\\documentclass"));
    if (files_with_documentclass.length === 1) detected_main = files_with_documentclass[0][0];
    else if (files_with_documentclass.length > 1) {
      const choice = await show_choice_modal({
        title: "Select Entry File",
        message: "Which .tex file is the main entry point for compilation?",
        options: files_with_documentclass.map(([name]) => ({ label: name, value: name, variant: "default" as const })),
      });
      if (choice) detected_main = choice;
    } else if (tex_files.length > 0) detected_main = tex_files[0][0];
    else detected_main = Object.keys(incoming)[0] || "main.tex";

    set_project_metadata(yp, { main_file: detected_main });
    await repo.save_snapshot(id, enc_snap(yp.doc));
    await repo.update_main_file(id, detected_main ?? "main.tex");
    yp.doc.destroy();
    if (props.on_switch_project) await props.on_switch_project(id);
  }

  async function handle_zip_upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const files = await read_zip(file);
      if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No .tex files found in zip." }); return; }
      merge_or_load(files);
    } catch (err: any) {
      await show_alert_modal({ title: "Import Error", message: "Failed to read zip: " + err.message });
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
      if (is_binary(name)) files[name] = new Uint8Array(await file.arrayBuffer());
      else if (is_text_ext(name)) files[name] = await file.text();
    }
    if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No supported files found in folder." }); return; }
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
      if (is_binary(name)) files[name] = new Uint8Array(await file.arrayBuffer());
      else if (is_text_ext(name)) files[name] = await file.text();
    }
    if (Object.keys(files).length === 0) { await show_alert_modal({ title: "Import Error", message: "No supported files found." }); return; }
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

  async function handle_download_pdf() {
    await props.store.flush_dirty_blobs();
    const missing = await props.store.missing_blob_paths();
    if (missing.length > 0) {
      await props.store.request_missing_blobs();
      await show_alert_modal({
        title: "Waiting for Binary Files",
        message: `Still syncing binary file data for: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`,
      });
      return;
    }
    const ok = await worker_client.compile_and_wait({ files: { ...props.store.files }, main: props.store.main_file(), mode: "full" });
    if (!ok) return;
    const url = worker_client.pdf_url();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "output.pdf";
    a.click();
  }

  return (
    <>
      <div class="toolbar-file-actions">
        <div class="upload-menu-wrapper" ref={upload_btn_ref}>
          <button class="toolbar-toggle" title="Upload files or folder" onClick={() => set_show_upload_menu(v => !v)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </button>
          <AnimatedShow when={show_upload_menu()}>
            <div class="upload-dropdown">
              <button class="upload-dropdown-item" onClick={() => { file_input_ref?.click(); set_show_upload_menu(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>Upload Files</button>
              <button class="upload-dropdown-item" onClick={() => { folder_input_ref?.click(); set_show_upload_menu(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>Upload Folder</button>
            </div>
          </AnimatedShow>
        </div>
        <div class="upload-menu-wrapper" ref={download_btn_ref}>
          <button class="toolbar-toggle" title="Download" disabled={!worker_client.pdf_url()} onClick={() => set_show_download_menu(v => !v)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <AnimatedShow when={show_download_menu()}>
            <div class="upload-dropdown">
              <Show when={worker_client.pdf_url()}>
                <button class="upload-dropdown-item" onClick={() => { void handle_download_pdf(); set_show_download_menu(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Download PDF</button>
              </Show>
            </div>
          </AnimatedShow>
        </div>
      </div>
      <input ref={zip_input_ref} type="file" accept=".zip" style={{ display: "none" }} onChange={handle_zip_upload} />
      <input ref={file_input_ref} type="file" multiple accept=".tex,.bib,.sty,.cls,.png,.jpg,.jpeg,.gif,.webp,.svg,.ttf,.otf,.woff,.woff2,.pdf" style={{ display: "none" }} onChange={handle_file_upload} />
      <input ref={folder_input_ref} type="file" {...{ webkitdirectory: true } as any} style={{ display: "none" }} onChange={handle_folder_upload} />
    </>
  );
};

export default ToolbarFileActions;
