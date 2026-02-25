// register all commands -- called once from App.tsx during init
// single source of truth for all actions, keybindings, and command metadata

import { register_command, palette_open, set_palette_open, palette_filter, set_palette_filter, IS_MAC } from "./commands";
import { worker_client } from "./worker_client";
import type { ProjectStore } from "./project_store";
import type { LocalFolderSync } from "./local_folder_sync";
import { write_zip } from "./zip_utils";
import { clear_bundle_cache, reset_all_persistence } from "./project_persist";
import type { WatchController } from "./watch_controller";
import type { Accessor, Setter } from "solid-js";

export type CommandDeps = {
  store: ProjectStore;
  folder_sync: LocalFolderSync;
  watch: WatchController;
  files_visible: Accessor<boolean>;
  set_files_visible: Setter<boolean>;
  preview_visible: Accessor<boolean>;
  set_preview_visible: Setter<boolean>;
  split_dir: Accessor<"horizontal" | "vertical">;
  toggle_split: () => void;
  toggle_preview: () => void;
  show_logs: Accessor<boolean>;
  set_show_logs: Setter<boolean>;
  set_show_info_modal: Setter<boolean>;
  set_show_onboarding: Setter<boolean>;
  // editor access for vim toggle and focus
  get_editor_view: () => any | undefined;
  set_vim_enabled: Setter<boolean>;
  vim_enabled: Accessor<boolean>;
  // file input triggers
  trigger_file_upload: () => void;
  trigger_folder_upload: () => void;
  trigger_zip_upload: () => void;
};

let deps: CommandDeps | null = null;

export function init_commands(d: CommandDeps): void {
  deps = d;

  // -- Compile --

  register_command({
    id: "compile.run",
    label: "Compile Document",
    description: "Run tectonic to compile the project",
    keywords: ["build", "typeset", "latex", "pdf"],
    category: "Compile",
    keybinding: "Cmd+Enter",
    when: () => Object.keys(deps!.store.files).length > 0,
    action: () => {
      const files = { ...deps!.store.files };
      worker_client.compile({ files, main: deps!.store.main_file() });
    },
  });

  register_command({
    id: "compile.toggle_watch",
    label: "Toggle Watch Mode",
    description: "Auto-compile on file changes",
    keywords: ["auto", "live", "recompile"],
    category: "Compile",
    keybinding: "Cmd+Shift+W",
    when: () => Object.keys(deps!.store.files).length > 0,
    action: () => deps!.watch.toggle(),
  });

  register_command({
    id: "compile.clear_cache",
    label: "Clear Compile Cache",
    description: "Delete cached WASM bundles from OPFS",
    keywords: ["reset", "storage"],
    category: "Compile",
    action: () => {
      worker_client.clear_cache();
      clear_bundle_cache().catch(() => {});
    },
  });

  register_command({
    id: "compile.toggle_logs",
    label: "Toggle Compile Logs",
    description: "Show or hide the compilation log output",
    keywords: ["output", "console", "errors"],
    category: "Compile",
    keybinding: "Cmd+Shift+L",
    action: () => deps!.set_show_logs((v) => !v),
  });

  register_command({
    id: "compile.clear_logs",
    label: "Clear Compile Logs",
    keywords: ["reset", "output"],
    category: "Compile",
    action: () => worker_client.clear_logs(),
  });

  // -- File Management --

  register_command({
    id: "file.new",
    label: "New File",
    description: "Create a new file in the project",
    keywords: ["create", "add"],
    category: "File",
    action: () => {
      const existing = deps!.store.file_names();
      let name = "untitled.tex";
      if (existing.includes(name)) {
        let i = 1;
        while (existing.includes(`untitled-${i}.tex`)) i++;
        name = `untitled-${i}.tex`;
      }
      deps!.store.add_file(name, "");
    },
  });

  register_command({
    id: "file.upload",
    label: "Upload Files",
    description: "Upload files from your computer",
    keywords: ["import", "open"],
    category: "File",
    action: () => deps!.trigger_file_upload(),
  });

  register_command({
    id: "file.upload_folder",
    label: "Upload Folder",
    description: "Upload an entire folder",
    keywords: ["import", "directory"],
    category: "File",
    action: () => deps!.trigger_folder_upload(),
  });

  register_command({
    id: "file.upload_zip",
    label: "Import ZIP",
    description: "Import a project from a ZIP archive",
    keywords: ["upload", "archive"],
    category: "File",
    action: () => deps!.trigger_zip_upload(),
  });

  // -- Navigate --

  register_command({
    id: "nav.goto_file",
    label: "Go to File",
    description: "Quick-open a file by name",
    keywords: ["open", "switch", "quick"],
    category: "Navigate",
    keybinding: "Cmd+P",
    when: () => Object.keys(deps!.store.files).length > 0,
    action: () => {
      if (palette_open() && palette_filter().startsWith("> ")) {
        set_palette_open(false);
        set_palette_filter("");
      } else {
        set_palette_filter("> ");
        set_palette_open(true);
      }
    },
  });

  register_command({
    id: "nav.goto_line",
    label: "Go to Line",
    description: "Jump to a specific line number",
    keywords: ["line", "number", "jump"],
    category: "Navigate",
    keybinding: "Cmd+G",
    action: () => {
      if (palette_open() && palette_filter().startsWith(": ")) {
        set_palette_open(false);
        set_palette_filter("");
      } else {
        set_palette_filter(": ");
        set_palette_open(true);
      }
    },
  });

  register_command({
    id: "nav.next_diagnostic",
    label: "Next Diagnostic",
    description: "Jump to the next error or warning",
    keywords: ["error", "warning", "problem"],
    category: "Navigate",
    keybinding: "F8",
    when: () => worker_client.diagnostics().length > 0,
    action: () => {
      const diags = worker_client.diagnostics();
      if (diags.length === 0) return;
      // jump to first diagnostic with a location
      const d = diags.find((d) => d.file && d.line);
      if (d && d.file && d.line) {
        deps!.store.set_current_file(d.file);
        worker_client.request_goto(d.file, d.line);
      }
    },
  });

  register_command({
    id: "nav.prev_diagnostic",
    label: "Previous Diagnostic",
    description: "Jump to the previous error or warning",
    keywords: ["error", "warning", "problem"],
    category: "Navigate",
    keybinding: "Shift+F8",
    when: () => worker_client.diagnostics().length > 0,
    action: () => {
      const diags = worker_client.diagnostics();
      if (diags.length === 0) return;
      // jump to last diagnostic with a location
      const d = [...diags].reverse().find((d) => d.file && d.line);
      if (d && d.file && d.line) {
        deps!.store.set_current_file(d.file);
        worker_client.request_goto(d.file, d.line);
      }
    },
  });

  // -- Layout --

  register_command({
    id: "layout.toggle_files",
    label: "Toggle File Panel",
    description: "Show or hide the file sidebar",
    keywords: ["sidebar", "explorer", "tree"],
    category: "View",
    keybinding: "Cmd+B",
    action: () => deps!.set_files_visible((v) => !v),
  });

  register_command({
    id: "layout.toggle_preview",
    label: "Toggle Preview",
    description: "Show or hide the PDF preview",
    keywords: ["pdf", "output", "viewer"],
    category: "View",
    keybinding: "Cmd+Shift+E",
    action: () => deps!.toggle_preview(),
  });

  register_command({
    id: "layout.toggle_split",
    label: "Toggle Split Direction",
    description: "Switch between side-by-side and stacked layout",
    keywords: ["horizontal", "vertical", "layout"],
    category: "View",
    when: () => deps!.preview_visible(),
    action: () => deps!.toggle_split(),
  });

  register_command({
    id: "layout.focus_editor",
    label: "Focus Editor",
    description: "Move focus to the code editor",
    keywords: ["cursor", "type"],
    category: "View",
    action: () => {
      const view = deps!.get_editor_view();
      if (view) view.focus();
    },
  });

  // -- SyncTeX --

  register_command({
    id: "sync.forward",
    label: "Sync Editor to PDF",
    description: "Jump to the current cursor position in the PDF",
    keywords: ["synctex", "forward", "jump"],
    category: "Navigate",
    keybinding: "Cmd+Shift+.",
    when: () => worker_client.pdf_url() !== null,
    action: () => {
      const view = deps!.get_editor_view();
      if (!view) return;
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      worker_client.sync_forward(deps!.store.current_file(), line);
    },
  });

  // -- Project --

  register_command({
    id: "project.download_zip",
    label: "Export Project as ZIP",
    description: "Download the entire project as a ZIP file",
    keywords: ["save", "archive", "backup"],
    category: "Project",
    when: () => Object.keys(deps!.store.files).length > 0,
    action: async () => {
      const blob = await write_zip(deps!.store.files);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "project.zip";
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  register_command({
    id: "project.download_pdf",
    label: "Download PDF",
    description: "Download the compiled PDF output",
    keywords: ["save", "export"],
    category: "Project",
    keybinding: "Cmd+Shift+D",
    when: () => worker_client.pdf_url() !== null,
    action: () => {
      const url = worker_client.pdf_url();
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.download = "output.pdf";
      a.click();
    },
  });

  register_command({
    id: "project.open_folder",
    label: "Open Local Folder",
    description: "Connect a local folder for file sync",
    keywords: ["sync", "directory", "filesystem"],
    category: "Project",
    when: () => deps!.folder_sync.is_supported() && !deps!.folder_sync.state().active,
    action: () => { deps!.folder_sync.open_folder(); },
  });

  register_command({
    id: "project.reset",
    label: "Reset Everything",
    description: "Delete all project files and cached bundles",
    keywords: ["clear", "destroy", "wipe"],
    category: "Project",
    action: async () => {
      if (!confirm("Reset everything? This deletes all project files and cached bundles.")) return;
      worker_client.clear_cache();
      await reset_all_persistence();
      window.location.reload();
    },
  });

  // -- Sync to Disk --

  register_command({
    id: "sync.to_disk",
    label: "Sync to Disk",
    description: "Save changes to the connected local folder",
    keywords: ["save", "filesystem"],
    category: "Project",
    keybinding: "Cmd+S",
    when: () => deps!.folder_sync.state().active,
    action: () => { deps!.folder_sync.sync_now(); },
  });

  // -- Help --

  register_command({
    id: "help.about",
    label: "About eztex",
    description: "Show version and project info",
    keywords: ["info", "version"],
    category: "Help",
    action: () => deps!.set_show_info_modal(true),
  });

  register_command({
    id: "help.keyboard_shortcuts",
    label: "Keyboard Shortcuts",
    description: "Show all keyboard shortcuts",
    keywords: ["keys", "bindings", "hotkeys"],
    category: "Help",
    keybinding: "Cmd+/",
    action: () => {
      // open palette so user can see all commands and their keybindings
      set_palette_open(true);
      set_palette_filter("");
    },
  });

  register_command({
    id: "help.toggle_vim",
    label: "Toggle Vim Mode",
    description: "Enable or disable Vim keybindings in the editor",
    keywords: ["vi", "modal", "emulation"],
    category: "Help",
    action: () => deps!.set_vim_enabled((v) => !v),
  });

  register_command({
    id: "help.start_tour",
    label: "Start Tutorial",
    description: "Show the onboarding tour",
    keywords: ["guide", "help", "tutorial"],
    category: "Help",
    action: () => deps!.set_show_onboarding(true),
  });

  register_command({
    id: "palette.open",
    label: "Command Palette",
    description: "Open the command palette",
    keywords: ["search", "commands"],
    category: "View",
    keybinding: IS_MAC ? "Cmd+K" : "Cmd+Shift+K",
    action: () => {
      if (palette_open()) {
        set_palette_open(false);
        set_palette_filter("");
      } else {
        set_palette_filter("");
        set_palette_open(true);
      }
    },
  });
}
