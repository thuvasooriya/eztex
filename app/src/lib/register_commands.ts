// register all commands -- called once from App.tsx during init
// single source of truth for all actions, keybindings, and command metadata

import { register_command, palette_open, set_palette_open, palette_filter, set_palette_filter, IS_MAC } from "./commands";
import type { EditorView } from "@codemirror/view";
import { worker_client } from "./worker_client";
import type { ProjectStore } from "./project_store";
import type { LocalFolderSync } from "./local_folder_sync";
import { write_zip } from "./zip_utils";
import { clear_bundle_cache, reset_all_persistence } from "./project_persist";
import type { WatchController } from "./watch_controller";
import type { AgentReviewStore } from "./agent_review";
import type { Accessor, Setter } from "solid-js";
import { show_input_modal, show_confirm_modal, show_alert_modal } from "./modal_store";

type ProjectCommandDeps = {
  store: ProjectStore;
  folder_sync: LocalFolderSync;
};

type CompileCommandDeps = {
  watch: WatchController;
  show_logs: Accessor<boolean>;
  set_show_logs: Setter<boolean>;
};

type LayoutCommandDeps = {
  files_visible: Accessor<boolean>;
  set_files_visible: Setter<boolean>;
  preview_visible: Accessor<boolean>;
  set_preview_visible: Setter<boolean>;
  split_dir: Accessor<"horizontal" | "vertical">;
  toggle_split: () => void;
  toggle_preview: () => void;
  set_show_info_modal: Setter<boolean>;
  set_show_onboarding: Setter<boolean>;
};

type EditorCommandDeps = {
  get_editor_view: () => EditorView | undefined;
  set_vim_enabled: Setter<boolean>;
  vim_enabled: Accessor<boolean>;
};

type UploadCommandDeps = {
  trigger_file_upload: () => void;
  trigger_folder_upload: () => void;
  trigger_zip_upload: () => void;
};

type AgentCommandDeps = {
  agent_review_store: AgentReviewStore;
  set_show_agent_panel: Setter<boolean>;
  on_copy_agent_write_link: () => void;
};

export type CommandDeps = {
  project: ProjectCommandDeps;
  compile: CompileCommandDeps;
  layout: LayoutCommandDeps;
  editor: EditorCommandDeps;
  uploads: UploadCommandDeps;
  agent: AgentCommandDeps;
};

export function init_commands(d: CommandDeps): void {
  const project = d.project;
  const compile = d.compile;
  const layout = d.layout;
  const editor = d.editor;
  const uploads = d.uploads;
  const agent = d.agent;

  // -- Compile --

  register_command({
    id: "compile.run",
    label: "Compile Document",
    description: "Run tectonic to compile the project",
    keywords: ["build", "typeset", "latex", "pdf"],
    category: "Compile",
    keybinding: "Cmd+Enter",
    when: () => Object.keys(project.store.files).length > 0,
    action: () => {
      const files = { ...project.store.files };
      worker_client.compile({ files, main: project.store.main_file(), mode: "full" });
    },
  });

  register_command({
    id: "compile.toggle_watch",
    label: "Toggle Watch Mode",
    description: "Auto-compile on file changes",
    keywords: ["auto", "live", "recompile"],
    category: "Compile",
    keybinding: "Cmd+Shift+W",
    when: () => Object.keys(project.store.files).length > 0,
    action: () => compile.watch.toggle(),
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
    action: () => compile.set_show_logs((v) => !v),
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
      const existing = project.store.file_names();
      let name = "untitled.tex";
      if (existing.includes(name)) {
        let i = 1;
        while (existing.includes(`untitled-${i}.tex`)) i++;
        name = `untitled-${i}.tex`;
      }
      project.store.add_file(name, "");
    },
  });

  register_command({
    id: "file.upload",
    label: "Upload Files",
    description: "Upload files from your computer",
    keywords: ["import", "open"],
    category: "File",
    action: () => uploads.trigger_file_upload(),
  });

  register_command({
    id: "file.upload_folder",
    label: "Upload Folder",
    description: "Upload an entire folder",
    keywords: ["import", "directory"],
    category: "File",
    action: () => uploads.trigger_folder_upload(),
  });

  register_command({
    id: "file.upload_zip",
    label: "Import Project",
    description: "Import a project from a ZIP archive",
    keywords: ["upload", "archive"],
    category: "File",
    action: () => uploads.trigger_zip_upload(),
  });

  // -- Navigate --

  register_command({
    id: "nav.goto_file",
    label: "Go to File",
    description: "Quick-open a file by name",
    keywords: ["open", "switch", "quick"],
    category: "Navigate",
    keybinding: "Cmd+P",
    when: () => Object.keys(project.store.files).length > 0,
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
        project.store.set_current_file(d.file);
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
        project.store.set_current_file(d.file);
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
    action: () => layout.set_files_visible((v) => !v),
  });

  register_command({
    id: "layout.toggle_preview",
    label: "Toggle Preview",
    description: "Show or hide the PDF preview",
    keywords: ["pdf", "output", "viewer"],
    category: "View",
    keybinding: "Cmd+Shift+E",
    action: () => layout.toggle_preview(),
  });

  register_command({
    id: "layout.toggle_split",
    label: "Toggle Split Direction",
    description: "Switch between side-by-side and stacked layout",
    keywords: ["horizontal", "vertical", "layout"],
    category: "View",
    when: () => layout.preview_visible(),
    action: () => layout.toggle_split(),
  });

  register_command({
    id: "layout.focus_editor",
    label: "Focus Editor",
    description: "Move focus to the code editor",
    keywords: ["cursor", "type"],
    category: "View",
    action: () => {
      const view = editor.get_editor_view();
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
      const view = editor.get_editor_view();
      if (!view) return;
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      worker_client.sync_forward(project.store.current_file(), line);
    },
  });

  // -- Project --

  register_command({
    id: "project.download_zip",
    label: "Export Project",
    description: "Download the entire project as a ZIP file",
    keywords: ["save", "archive", "backup"],
    category: "Project",
    when: () => Object.keys(project.store.files).length > 0,
    action: async () => {
      const blob = await write_zip(project.store.files);
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
    action: async () => {
      const ok = await worker_client.compile_and_wait({
        files: { ...project.store.files },
        main: project.store.main_file(),
        mode: "full",
      });
      if (!ok) return;

      const url = worker_client.pdf_url();
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.download = "output.pdf";
      a.click();
    },
  });

  register_command({
    id: "project.new",
    label: "New Project",
    description: "Create a new empty project",
    keywords: ["create", "blank"],
    category: "Project",
    action: async () => {
      const { list_projects } = await import("./project_manager");
      const projects = await list_projects();
      const default_name = projects.length === 0 ? "Demo Project" : "Untitled Project";
      const name = await show_input_modal({
        title: "New Project",
        message: "Enter a name for your new project.",
        placeholder: "Project name",
        default_value: default_name,
      });
      if (name === null) return;
      const { create_project } = await import("./project_manager");
      const { get_project_url, set_current_project } = await import("./project_manager");
      const id = await create_project(name || undefined);
      await set_current_project(id);
      window.location.href = get_project_url(id);
    },
  });

  register_command({
    id: "project.share",
    label: "Share Project",
    description: "Create a collaboration room and copy share links",
    keywords: ["collab", "collaborate", "room", "invite"],
    category: "Project",
    action: async () => {
      const pid = project.store.project_id();
      if (!pid) return;
      const { create_room_links } = await import("./collab_share");
      const { get_project } = await import("./project_manager");
      const entry = await get_project(pid);
      const project_name = entry?.name ?? "Untitled Project";
      const links = await create_room_links(pid, project_name, window.location.origin);
      project.store.set_room_id(links.room_id);
      try {
        await navigator.clipboard.writeText(links.write_url);
        await show_alert_modal({
          title: "Share Link Copied",
          message: "The write link has been copied to your clipboard.",
        });
      } catch {
        await show_alert_modal({
          title: "Share Link",
          message: `Write link: ${links.write_url}`,
        });
      }
    },
  });

  register_command({
    id: "project.open_folder",
    label: "Open Local Folder",
    description: "Connect a local folder for file sync",
    keywords: ["sync", "directory", "filesystem"],
    category: "Project",
    when: () => project.folder_sync.is_supported() && !project.folder_sync.state().active,
    action: () => { void project.folder_sync.open_folder(); },
  });

  register_command({
    id: "project.reset",
    label: "Reset Everything",
    description: "Delete all project files and cached bundles",
    keywords: ["clear", "destroy", "wipe"],
    category: "Project",
    action: async () => {
      const confirmed = await show_confirm_modal({
        title: "Reset Everything",
        message: "This will delete all project files and cached bundles. This cannot be undone.",
        confirm_label: "Reset",
        danger: true,
      });
      if (!confirmed) return;
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
    when: () => project.folder_sync.state().active,
    action: () => { void project.folder_sync.sync_now(); },
  });

  // -- Help --

  register_command({
    id: "help.about",
    label: "About eztex",
    description: "Show version and project info",
    keywords: ["info", "version"],
    category: "Help",
    action: () => layout.set_show_info_modal(true),
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
    action: () => editor.set_vim_enabled((v) => !v),
  });

  register_command({
    id: "help.start_tour",
    label: "Start Tutorial",
    description: "Show the onboarding tour",
    keywords: ["guide", "help", "tutorial"],
    category: "Help",
    action: () => layout.set_show_onboarding(true),
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

  // -- Agent --

  register_command({
    id: "agent.showPanel",
    label: "Show Agent Panel",
    description: "Open the agent collaboration panel",
    keywords: ["agent", "collab", "review", "ai"],
    category: "Agent",
    action: () => agent.set_show_agent_panel(true),
  });

  register_command({
    id: "agent.copyWriteLink",
    label: "Copy Agent Write Link",
    description: "Copy a WebSocket URL with write token for agent clients",
    keywords: ["agent", "token", "write", "link", "mcp"],
    category: "Agent",
    when: () => !!project.store.room_id(),
    action: () => agent.on_copy_agent_write_link(),
  });

  register_command({
    id: "agent.acceptReview",
    label: "Accept Next Agent Review",
    description: "Accept the first pending agent review",
    keywords: ["agent", "review", "accept", "apply"],
    category: "Agent",
    when: () => agent.agent_review_store.pending().length > 0,
    action: () => {
      const pending = agent.agent_review_store.pending();
      if (pending.length > 0) {
        agent.agent_review_store.accept(pending[0].id, project.store.ydoc());
      }
    },
  });

  register_command({
    id: "agent.rejectReview",
    label: "Reject Next Agent Review",
    description: "Reject the first pending agent review",
    keywords: ["agent", "review", "reject", "discard"],
    category: "Agent",
    when: () => agent.agent_review_store.pending().length > 0,
    action: () => {
      const pending = agent.agent_review_store.pending();
      if (pending.length > 0) {
        agent.agent_review_store.reject(pending[0].id);
      }
    },
  });

  register_command({
    id: "agent.clearCompletedReviews",
    label: "Clear Completed Agent Reviews",
    description: "Remove accepted, rejected, and stale reviews",
    keywords: ["agent", "review", "clear", "clean"],
    category: "Agent",
    when: () => agent.agent_review_store.reviews().some((review) => review.status !== "pending"),
    action: () => agent.agent_review_store.clear_completed(),
  });
}
