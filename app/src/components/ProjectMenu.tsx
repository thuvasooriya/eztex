import { type Component, For, Show } from "solid-js";
import AnimatedShow from "./AnimatedShow";
import type { ProjectCatalogEntry } from "../lib/project_repository";

type Props = {
  show: boolean;
  on_close: () => void;
  projects: ProjectCatalogEntry[];
  current_project_id: string;
  on_switch: (id: string) => void;
  on_new: () => void;
  on_rename: () => void;
  on_duplicate: () => void;
  on_delete: () => void;
  on_import: () => void;
  on_export: () => void;
  can_open_folder?: boolean;
  on_open_folder?: () => void;
};

const ProjectMenu: Component<Props> = (props) => (
  <AnimatedShow when={props.show}>
    <div class="upload-dropdown project-dropdown">
      <For each={props.projects}>
        {(project) => (
          <button
            class={`upload-dropdown-item ${project.id === props.current_project_id ? "active-project" : ""}`}
            onClick={() => props.on_switch(project.id)}
          >
            <span class="project-name">{project.name}</span>
          </button>
        )}
      </For>
      <Show when={props.projects.length > 0}>
        <div class="upload-dropdown-divider" />
      </Show>
      <button class="upload-dropdown-item" onClick={props.on_new}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New Project
      </button>
      <button class="upload-dropdown-item" onClick={props.on_import}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 12v-1"/><path d="M8 18v-2"/><path d="M8 7V6"/><circle cx="8" cy="20" r="2"/></svg>
        Import Project
      </button>
      <Show when={props.can_open_folder}>
        <button class="upload-dropdown-item" onClick={props.on_open_folder}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5"/><path d="M12 10v4h4"/><path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5"/><path d="M22 22v-4h-4"/><path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5"/></svg>
          Open Folder
        </button>
      </Show>
      <button class="upload-dropdown-item" onClick={props.on_export}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/></svg>
        Export Project
      </button>
      <button class="upload-dropdown-item" onClick={props.on_rename}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Rename
      </button>
      <button class="upload-dropdown-item" onClick={props.on_duplicate}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        Duplicate
      </button>
      <button class="upload-dropdown-item danger-item" onClick={props.on_delete}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
        Delete
      </button>
    </div>
  </AnimatedShow>
);

export default ProjectMenu;
