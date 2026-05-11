# Wave 0 Requirements Document

Task ID: `ses_1e9362f08ffe78oVgw2ByjnB5r`

Repository: `/Users/tony/arc/dev/eztex`

Product name in planning docs: `extex`

Implementation target: browser-only Wave 0, no server changes.

---

## 1. Wave Overview

### Scope

Wave 0 converts the current single-project in-memory file store into a Yjs-backed local collaboration model while preserving the existing single-user workflow.

Wave 0 includes:

1. Add Yjs dependencies.
2. Create `app/src/lib/y_project_doc.ts`.
3. Refactor `app/src/lib/project_store.ts` to use Yjs internally while keeping most public API compatibility.
4. Refactor `app/src/components/Editor.tsx` to bind CodeMirror directly to `Y.Text` via `y-codemirror.next`.
5. Add same-origin multi-window sync using `BroadcastChannel`.
6. Update OPFS persistence to store Yjs snapshots and content-addressed binary blobs.
7. Migrate existing `eztex-projects/default/` data into OPFS v2 project layout.
8. Keep compile, preview, upload, folder sync, diagnostics, Vim mode, Synctex forward/reverse sync, binary preview, and auto-save working.

### Non-Scope

Wave 0 does not include:

1. Cloudflare Workers.
2. Durable Objects.
3. Remote WebSocket collaboration.
4. Share links.
5. MCP server implementation.
6. Multi-user permissions.
7. WebRTC.
8. Full project switcher UI beyond safe internal project identity support.

### Goals

1. CRDT-backed project document exists locally.
2. Editor no longer writes full document strings on every keystroke.
3. Editor no longer replaces entire CodeMirror document on file switch.
4. Two browser tabs/windows for the same local project converge through `BroadcastChannel`.
5. OPFS persists/restores the Yjs document snapshot.
6. Binary files remain outside Yjs and continue to preview correctly.
7. Existing public store methods keep working for current UI code.
8. Existing compile flow still receives `ProjectFiles` snapshots.

### Acceptance Criteria

Wave 0 is done when:

1. `bun install` succeeds in `app/`.
2. `bun run build` succeeds in `app/`.
3. App loads a saved v1 project from `eztex-projects/default/` and migrates it to v2 layout.
4. Single-user editing works with no obvious UI regression.
5. File switching preserves each file's text and does not dispatch full replacement edits into Yjs.
6. Undo/redo works through Yjs undo manager.
7. Two tabs editing the same project converge without server involvement.
8. Compile still receives all text and binary project files through `snapshot_files()`.
9. Binary images still display in `Editor.tsx`.
10. Existing local folder upload/import does not crash.
11. Existing PDF diagnostics and Synctex interactions still work.

### Definition Of Done

1. Code is implemented with minimal changes outside listed files.
2. No server code is added.
3. Old v1 OPFS project data is read and migrated once.
4. `store.files` remains available as a compatibility facade, but new code paths use `snapshot_files()`.
5. All binary content is stored in a local blob store, not directly in Yjs.
6. BroadcastChannel messages are project-scoped and do not leak between projects.
7. Implementation is documented in code only where behavior is non-obvious.

---

## 2. Project/Session Architecture

### Core Concepts

Project state is durable document data.

Session state is local runtime/UI state.

Project state includes:

1. Project metadata.
2. File path mapping.
3. Text file CRDT contents.
4. Binary file references.
5. Main file.
6. Updated timestamp.

Session state includes:

1. Current file selection.
2. Editor view instance.
3. Vim enabled setting.
4. Diagnostics currently displayed.
5. Compile sequence guards.
6. Active BroadcastChannel provider.
7. Dirty/save timers.
8. Local in-memory binary blob cache.
9. Current PDF/Synctex output handles.

### ProjectRuntime

Create this abstraction in `project_store.ts` or a future `project_manager.ts`. For Wave 0, it can be implemented inside `create_project_store()` with the interface prepared for extraction.

```ts
export type ProjectId = string;
export type RoomId = string;
export type FileId = string;
export type ContentHash = string;

export interface ProjectMetadata {
  id: ProjectId;
  room_id?: RoomId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
}

export type FileContent = string | Uint8Array;
export type ProjectFiles = Record<string, FileContent>;

export interface BlobStore {
  get(hash: ContentHash): Uint8Array | undefined;
  put(bytes: Uint8Array): Promise<ContentHash>;
  put_sync_for_existing_hash(hash: ContentHash, bytes: Uint8Array): void;
  delete(hash: ContentHash): void;
  entries(): IterableIterator<[ContentHash, Uint8Array]>;
}

export interface ProjectRuntime {
  project_id: ProjectId;
  room_id?: RoomId;
  metadata: ProjectMetadata;
  doc: Y.Doc;
  awareness: Awareness | null;
  blob_store: BlobStore;
  snapshot_files(): Promise<ProjectFiles>;
  persist(): Promise<void>;
  destroy(): Promise<void>;
}
```

### ProjectManager Interface

Wave 0 does not need a full UI project switcher, but persistence should be shaped for this async interface.

```ts
export interface ProjectCatalogEntry {
  id: ProjectId;
  name: string;
  main_file: string;
  created_at: number;
  updated_at: number;
  room_id?: RoomId;
}

export interface ProjectCatalog {
  version: 2;
  current_project_id: ProjectId | null;
  projects: ProjectCatalogEntry[];
}

export interface ProjectManager {
  catalog(): Promise<ProjectCatalog>;
  current(): ProjectRuntime | null;
  create_project(name?: string): Promise<ProjectRuntime>;
  open_project(id: ProjectId): Promise<ProjectRuntime>;
  open_room(room_id: RoomId, token: string): Promise<ProjectRuntime>;
  close_project(id?: ProjectId): Promise<void>;
  delete_project(id: ProjectId): Promise<void>;
}
```

### URL Structure

Wave 0 should not implement full routing, but it must not block the future URL model.

Supported now:

```txt
/?project=<project_id>
```

Future remote collaboration:

```txt
/c/<room_id>#<permission>.<signature>
/?project=<project_id>&room=<room_id>#<permission>.<signature>
```

Wave 0 behavior:

1. If `?project=` exists and project exists in catalog, open it.
2. If `?project=` does not exist, open current catalog project.
3. If no project exists, create one and set it as current.
4. If routing work is too large, preserve current one-project UI but store the project in v2 layout with a generated `ProjectId`.

### Multiple Browser Windows/Tabs

Wave 0 must support multiple same-origin tabs editing the same project.

Rules:

1. Each tab has its own `Y.Doc`.
2. Each tab opens the same OPFS project snapshot.
3. BroadcastChannel sync exchanges Yjs updates between tabs.
4. Every update originated by local editing is applied to local Yjs, then broadcast to other tabs.
5. Every remote tab update is applied to local Yjs and updates the editor through `yCollab`.
6. Persistence can be done by every tab with debounce, but must write compacted snapshots, not raw full `ProjectFiles`.
7. Channel names must include project id: `eztex:yjs:<project_id>`.

### Project Switching Mechanics

Wave 0 can keep a single visible project, but implementation must be safe for future switching.

Switching rules:

1. Persist current project before opening another project.
2. Destroy current editor binding/provider before binding the new project.
3. Close previous BroadcastChannel.
4. Reset session state: current file, diagnostics view state, compile sequence.
5. Keep outputs project-scoped under `outputs/`.
6. Worker compile requests must include `project_id` where supported.
7. If `worker_client.ts` cannot accept `project_id` yet, keep current behavior but add TODO-level internal plumbing only if minimal.

### OPFS v2 Layout

Use this layout:

```txt
eztex-projects/
  catalog.json
  projects/
    <project_id>/
      project.json
      ydoc.bin
      blobs/
        <sha256>
      outputs/
        output.pdf
        output.synctex
```

`catalog.json`:

```ts
export interface ProjectCatalogFile {
  version: 2;
  current_project_id: ProjectId | null;
  projects: ProjectCatalogEntry[];
}
```

`project.json`:

```ts
export interface ProjectManifestV2 {
  version: 2;
  id: ProjectId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
  room_id?: RoomId;
  ydoc_file: "ydoc.bin";
  blobs_dir: "blobs";
  outputs_dir: "outputs";
}
```

---

## 3. Yjs Document Schema

Create `app/src/lib/y_project_doc.ts`.

### Types

```ts
import * as Y from "yjs";

export type ProjectId = string;
export type RoomId = string;
export type FileId = string;
export type ContentHash = string;

export type FileKind = "text" | "binary";

export interface ProjectMetadata {
  id: ProjectId;
  room_id?: RoomId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
}

export interface FileMetadata {
  id: FileId;
  path: string;
  kind: FileKind;
  created_at: number;
  updated_at: number;
  content_hash?: ContentHash;
  mime?: string;
  size?: number;
}

export interface YProjectDoc {
  doc: Y.Doc;
  meta: Y.Map<unknown>;
  paths: Y.Map<FileId>;
  file_meta: Y.Map<Y.Map<unknown>>;
  texts: Y.Map<Y.Text>;
  blob_refs: Y.Map<ContentHash>;
}
```

### Yjs Top-Level Keys

Use these exact keys:

```ts
export const Y_META = "meta";
export const Y_PATHS = "paths";
export const Y_FILE_META = "file_meta";
export const Y_TEXTS = "texts";
export const Y_BLOB_REFS = "blob_refs";
```

Mapping:

1. `meta`: project metadata fields.
2. `paths`: path string to stable file id.
3. `file_meta`: file id to metadata map.
4. `texts`: file id to `Y.Text`.
5. `blob_refs`: file id to content hash for binary files.

### Required Helpers

Implement these helpers:

```ts
export function create_y_project_doc(project_id: ProjectId, name?: string): YProjectDoc;

export function bind_y_project_doc(doc: Y.Doc): YProjectDoc;

export function get_project_metadata(yp: YProjectDoc): ProjectMetadata;

export function set_project_metadata(yp: YProjectDoc, patch: Partial<ProjectMetadata>): void;

export function get_file_id(yp: YProjectDoc, path: string): FileId | undefined;

export function get_or_create_text_file(yp: YProjectDoc, path: string, initial?: string): Y.Text;

export function create_binary_file_ref(
  yp: YProjectDoc,
  path: string,
  hash: ContentHash,
  size: number,
  mime?: string,
): FileId;

export function rename_file_path(yp: YProjectDoc, old_path: string, new_path: string): boolean;

export function delete_file_entry(yp: YProjectDoc, path: string): boolean;

export function list_paths(yp: YProjectDoc): string[];

export function encode_snapshot(doc: Y.Doc): Uint8Array;

export function apply_snapshot(doc: Y.Doc, bytes: Uint8Array): void;
```

### File ID Generation

Use stable IDs that survive rename.

Strategy:

```ts
export function create_file_id(): FileId {
  return `f_${crypto.randomUUID().replaceAll("-", "")}`;
}
```

Rules:

1. Never derive `FileId` from path.
2. Rename changes `paths`, `file_meta.path`, and leaves `texts[file_id]` unchanged.
3. Delete removes path mapping and metadata.
4. Delete may leave old `Y.Text` in the map for Wave 0 if physical cleanup is risky, but new code should not reference it.
5. New text file creates `Y.Text` at `texts[file_id]`.
6. New binary file creates `blob_refs[file_id] = hash`.

### Text vs Binary Handling

Text files:

1. Store content in `Y.Text`.
2. `get_text_content(path)` returns `ytext.toString()`.
3. `update_content(path, string)` mutates `Y.Text` using delete/insert inside `doc.transact`.

Binary files:

1. Do not store bytes in Yjs.
2. Store bytes in `BlobStore`.
3. Store hash reference in `blob_refs`.
4. Store size/mime/kind in `file_meta`.
5. `get_content(path)` returns `Uint8Array` from blob store if present.
6. `snapshot_files()` includes binary files by reading blob refs.

### Metadata Storage

Set project metadata on creation:

```ts
{
  id: project_id,
  name: name ?? "Untitled Project",
  created_at: Date.now(),
  updated_at: Date.now(),
  main_file: "main.tex",
}
```

Update `updated_at` on structural and text changes with debounce or immediate mutation. Minimal implementation can update immediately on mutating store methods.

---

## 4. Store Refactor Specifications

Modify `app/src/lib/project_store.ts`.

Current important lines:

1. `FileContent` and `ProjectFiles`: lines `6-7`.
2. `create_project_store()`: line `24`.
3. Solid store `files`: lines `25-27`.
4. `current_file`, `main_file`, `revision`: lines `29-36`.
5. `file_names()`: lines `46-53`.
6. `add_file`, `remove_file`, `rename_file`, `update_content`: lines `55-88`.
7. `get_content`, `get_text_content`: lines `90-98`.
8. `load_files`, `merge_files`, `init_from_template`: lines `109-160`.
9. Returned API: lines `162-181`.

### Keep Existing API

These methods must remain:

```ts
files: ProjectFiles;
current_file: () => string;
set_current_file: (name: string) => void;
main_file: () => string;
set_main_file: (name: string) => void;
revision: () => number;
file_names: () => string[];
add_file: (name: string, content?: FileContent) => void;
remove_file: (name: string) => void;
rename_file: (old_name: string, new_name: string) => void;
update_content: (name: string, content: FileContent) => void;
get_content: (name: string) => FileContent;
get_text_content: (name: string) => string;
clear_all: () => void;
load_files: (new_files: ProjectFiles) => void;
merge_files: (new_files: ProjectFiles) => void;
on_change: (cb: () => void) => () => void;
init_from_template: () => Promise<void>;
```

### Add New API

Add:

```ts
project_id: () => ProjectId;
ydoc: () => Y.Doc;
get_ytext: (path: string) => Y.Text;
snapshot_files: () => Promise<ProjectFiles>;
encode_ydoc_snapshot: () => Uint8Array;
apply_ydoc_snapshot: (bytes: Uint8Array) => void;
destroy: () => void;
```

### Compatibility Facade For `store.files`

`store.files` must continue to exist because current code uses it.

Known access points include:

1. `App.tsx:91`: watch controller `get_files`.
2. `App.tsx:219`: initial compile snapshot.
3. `App.tsx:230`: save project.
4. Other UI upload/export code may use `store.files`.

Implementation requirement:

1. Maintain a Solid `createStore<ProjectFiles>` facade called `files`.
2. Update facade from Yjs on every local or remote document change.
3. Do not use facade as source of truth.
4. New/modified code should prefer `await store.snapshot_files()`.

Minimal acceptable approach:

```ts
const [files, set_files] = createStore<ProjectFiles>({ "main.tex": "" });

function refresh_files_facade() {
  snapshot_files_sync_if_possible();
  set_revision((r) => r + 1);
  _notify();
}
```

If async binary reads are needed, keep binary bytes in memory so `snapshot_files()` can be async but facade refresh remains synchronous.

### Solid Reactivity

Rules:

1. Increment `revision` on Yjs updates that affect current UI.
2. Call `_notify()` after mutating methods and after remote BroadcastChannel updates.
3. Avoid infinite loops: remote updates applied to Yjs should refresh facade but not rebroadcast the same update.
4. Use Yjs transaction origins.

Suggested origins:

```ts
const ORIGIN_LOCAL = "local";
const ORIGIN_REMOTE_BC = "remote-broadcast";
const ORIGIN_LOAD = "load";
```

### Store Method Behavior

`file_names()`:

1. Read from Yjs `paths`.
2. Sort main file first, then alphabetical.

`add_file(name, content)`:

1. If `content` is string, create text file in Yjs.
2. If `content` is `Uint8Array`, put bytes in blob store and create binary file ref.
3. Set current file to new file.
4. Notify.

`remove_file(name)`:

1. Keep current guard: cannot remove main file.
2. Keep current guard: cannot remove last file.
3. Delete path mapping and metadata.
4. If current file deleted, switch to main file.
5. Notify.

`rename_file(old_name, new_name)`:

1. If target exists, no-op.
2. Rename path mapping, preserve file id.
3. If current file was old path, switch to new path.
4. If main file was old path, update main file metadata.
5. Notify.

`update_content(name, content)`:

1. For string: mutate `Y.Text` to match content.
2. For binary: store bytes in blob store, update hash ref and metadata.
3. This method remains for compatibility and non-editor write paths.
4. Editor typing must not call this method on every keystroke after refactor.

`get_content(name)`:

1. Return string from `Y.Text` for text file.
2. Return bytes from blob store for binary file.
3. Return `""` if missing.

`get_text_content(name)`:

1. Return `""` for binary.
2. Return `Y.Text.toString()` for text.

`load_files(new_files)`:

1. Create a fresh Y.Doc or clear current doc.
2. Import all files into Yjs/blob store.
3. Detect main file using current logic.
4. Set current file to detected main.
5. Notify.

`merge_files(new_files)`:

1. Add or replace files through Yjs.
2. Preserve current project metadata and main file unless main missing.
3. Notify.

`clear_all()`:

1. Reset to default `main.tex`.
2. Clear blob store.
3. Notify.

### Deprecation Plan For `store.files`

Wave 0 should not remove `store.files`.

Rules:

1. Existing call sites can keep using it if refactoring them is risky.
2. New compile/persist code should use `snapshot_files()`.
3. Add a code comment above returned `files` explaining it is a compatibility snapshot, not the source of truth.
4. Do not expose Yjs internals except through explicit methods.

---

## 5. Editor Refactor Specifications

Modify `app/src/components/Editor.tsx`.

Current important lines:

1. Imports: lines `1-18`.
2. `history` and `historyKeymap` import: line `4`.
3. `view` and `updating_from_outside`: lines `159-160`.
4. Initial `EditorState.create`: lines `206-245`.
5. `history()` extension: line `216`.
6. `keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])`: line `220`.
7. Keystroke writeback: lines `222-228`.
8. Full replacement on file/revision change: lines `280-293`.
9. Diagnostics effect: lines `296-315`.
10. Synctex reverse sync: lines `317-338`.

### Dependency Imports

Add:

```ts
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
```

Remove from `@codemirror/commands` import:

```ts
history
historyKeymap
```

Keep:

```ts
defaultKeymap
indentWithTab
```

### Binding Model

Editor must bind to current file's `Y.Text`.

Do not call `props.store.update_content()` inside `EditorView.updateListener`.

Do not dispatch a full document replacement when switching files.

Use `view.setState(EditorState.create(...))` for rebind.

### Extension Factory

Create a local function in `Editor.tsx`:

```ts
function create_editor_state(ytext: Y.Text, awareness: any | null, undoManager: Y.UndoManager): EditorState {
  return EditorState.create({
    doc: ytext.toString(),
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      bracketMatching(),
      indentOnInput(),
      foldGutter(),
      StreamLanguage.define(stex),
      syntaxHighlighting(tokyo_night_highlight),
      tokyo_night_theme,
      yCollab(ytext, awareness ?? undefined, { undoManager }),
      keymap.of([...defaultKeymap, ...yUndoManagerKeymap, indentWithTab]),
      vim_compartment.of([]),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          schedule_forward_synctex(update);
        }
      }),
      EditorView.lineWrapping,
    ],
  });
}
```

If `yCollab` requires a non-null awareness, create a minimal local awareness object or omit awareness only if library supports it. Prefer creating an `Awareness` from `y-protocols/awareness` in store and exposing it.

### Undo/Redo Migration

1. Remove CodeMirror `history()`.
2. Remove `historyKeymap`.
3. Use `Y.UndoManager` per current file or per text type.
4. Minimum acceptable Wave 0: create a new `Y.UndoManager(ytext)` on each file bind.
5. Better implementation: cache undo managers by file id/path in `Editor.tsx`.

Suggested cache:

```ts
const undo_managers = new Map<string, Y.UndoManager>();

function get_undo_manager(path: string, ytext: Y.Text): Y.UndoManager {
  let manager = undo_managers.get(path);
  if (!manager) {
    manager = new Y.UndoManager(ytext);
    undo_managers.set(path, manager);
  }
  return manager;
}
```

### File Switch Rebind

Replace current effect at `Editor.tsx:280-293`.

New behavior:

```ts
createEffect(
  on(
    () => props.store.current_file(),
    (file) => {
      if (!view) return;
      if (current_is_binary()) return;

      const ytext = props.store.get_ytext(file);
      const undoManager = get_undo_manager(file, ytext);

      view.setState(create_editor_state(ytext, props.store.awareness?.() ?? null, undoManager));

      if (props.vim_enabled) {
        import("@replit/codemirror-vim").then(({ vim }) => {
          if (view) view.dispatch({ effects: vim_compartment.reconfigure(vim()) });
        });
      }
    },
  ),
);
```

Important:

1. Do not include `props.store.revision()` in the file-switch effect.
2. Yjs remote/local changes update CodeMirror through `yCollab`.
3. Binary files hide editor as current code already does.

### Initial Mount

At `Editor.tsx:206-245`, use:

```ts
const file = props.store.current_file();
const ytext = props.store.get_ytext(file);
const undoManager = get_undo_manager(file, ytext);
const state = create_editor_state(ytext, props.store.awareness?.() ?? null, undoManager);
```

### Diagnostic Integration Preservation

Keep diagnostics effect lines `296-315`.

Risk:

1. Recreating EditorState on file switch removes current diagnostics extension state.
2. Existing effect re-applies diagnostics reactively from `worker_client.diagnostics()` and current file.

Requirement:

1. After rebind, diagnostics effect must still dispatch `cmSetDiagnostics`.
2. If diagnostics do not reappear on file switch, include `props.store.current_file()` in the diagnostics effect dependencies by reading it as current code already does.
3. Do not remove `cmSetDiagnostics`.

### Vim Mode Preservation

Current Vim logic:

1. `vim_compartment` line `163`.
2. Initial load lines `255-260`.
3. Toggle effect lines `263-278`.

Requirement:

1. Keep `vim_compartment`.
2. Include `vim_compartment.of([])` in every recreated editor state.
3. After `view.setState`, re-apply Vim if `props.vim_enabled`.
4. Keep toggle effect unchanged if possible.

### Synctex Integration Preservation

Current forward sync is inside update listener lines `229-240`.

Requirement:

1. Preserve forward sync scheduling on selection change and document change.
2. Use current file from `props.store.current_file()`.
3. Keep debounce at `300ms`.
4. Keep reverse sync effect lines `317-338`.
5. Ensure reverse sync dispatching selection still works after yCollab state creation.

### Image/Binary Preview Preservation

Current binary preview logic lines `165-191` and render lines `347-366` must keep working.

Requirement:

1. `props.store.get_content(file)` returns `Uint8Array` for binary files.
2. `is_binary()` remains exported from `project_store.ts`.
3. Binary files do not call `get_ytext()` unless creating an empty placeholder is harmless.

---

## 6. BroadcastChannel Integration

Implement inside `project_store.ts` or a small new file if cleaner.

No extra dependency required.

### Channel Name

```ts
const channel_name = `eztex:yjs:${project_id}`;
```

### Message Types

```ts
type BroadcastMessage =
  | {
      type: "hello";
      sender_id: string;
      project_id: ProjectId;
    }
  | {
      type: "sync";
      sender_id: string;
      project_id: ProjectId;
      update: Uint8Array;
    }
  | {
      type: "state-request";
      sender_id: string;
      project_id: ProjectId;
    }
  | {
      type: "state-response";
      sender_id: string;
      project_id: ProjectId;
      update: Uint8Array;
    };
```

Structured clone supports `Uint8Array` in BroadcastChannel.

### Sender ID

Each tab gets a runtime id:

```ts
const sender_id = crypto.randomUUID();
```

Ignore messages from self.

### Startup Protocol

On store creation:

1. Open channel.
2. Send `hello`.
3. Send `state-request`.
4. Existing tabs respond with `state-response` containing `Y.encodeStateAsUpdate(doc)`.
5. New tab applies response via `Y.applyUpdate(doc, update, ORIGIN_REMOTE_BC)`.

### Update Protocol

Register:

```ts
doc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === ORIGIN_REMOTE_BC || origin === ORIGIN_LOAD) return;
  channel.postMessage({
    type: "sync",
    sender_id,
    project_id,
    update,
  });
});
```

On receive `sync`:

```ts
Y.applyUpdate(doc, message.update, ORIGIN_REMOTE_BC);
```

### Multi-Tab Safety

Rules:

1. Ignore messages with different `project_id`.
2. Ignore messages from same `sender_id`.
3. Applying remote updates must not rebroadcast them.
4. On remote update, refresh Solid facade and notify subscribers.
5. Persist with debounce, not every remote keystroke.
6. If BroadcastChannel unsupported, app still works single-tab.

### Awareness

Wave 0 can skip cross-tab awareness.

Remote cursor rendering between same-user tabs is not required.

---

## 7. OPFS Persistence Update

Modify `app/src/lib/project_persist.ts`.

Current important lines:

1. v1 root constants: lines `6-7`.
2. `get_project_dir()`: lines `9-17`.
3. `SavedManifest`: lines `19-22`.
4. `save_project`: lines `24-68`.
5. `load_project`: lines `70-101`.
6. `has_saved_project`: lines `103-112`.
7. PDF/Synctex functions: lines `144-195`.
8. `reset_all_persistence`: lines `197-211`.

### New Functions

Add v2 APIs while preserving old exported names if needed.

```ts
export type ProjectId = string;

export interface ProjectCatalogEntry {
  id: ProjectId;
  name: string;
  main_file: string;
  created_at: number;
  updated_at: number;
  room_id?: string;
}

export interface ProjectCatalogFile {
  version: 2;
  current_project_id: ProjectId | null;
  projects: ProjectCatalogEntry[];
}

export interface ProjectManifestV2 {
  version: 2;
  id: ProjectId;
  name: string;
  created_at: number;
  updated_at: number;
  main_file: string;
  room_id?: string;
  ydoc_file: "ydoc.bin";
  blobs_dir: "blobs";
  outputs_dir: "outputs";
}

export async function load_catalog(): Promise<ProjectCatalogFile>;
export async function save_catalog(catalog: ProjectCatalogFile): Promise<void>;
export async function save_ydoc_snapshot(project_id: ProjectId, bytes: Uint8Array): Promise<void>;
export async function load_ydoc_snapshot(project_id: ProjectId): Promise<Uint8Array | null>;
export async function save_blob(project_id: ProjectId, hash: string, bytes: Uint8Array): Promise<void>;
export async function load_blob(project_id: ProjectId, hash: string): Promise<Uint8Array | null>;
export async function save_project_manifest(project_id: ProjectId, manifest: ProjectManifestV2): Promise<void>;
export async function load_project_manifest(project_id: ProjectId): Promise<ProjectManifestV2 | null>;
export async function migrate_v1_default_project(): Promise<ProjectId | null>;
```

### Backward Compatibility

Keep these exports for existing `App.tsx` until App is migrated:

```ts
save_project(files: ProjectFiles, main_file?: string): Promise<boolean>;
load_project(): Promise<{ files: ProjectFiles; main_file?: string } | null>;
has_saved_project(): Promise<boolean>;
clear_project(): Promise<void>;
save_pdf(bytes: Uint8Array): Promise<void>;
load_pdf(): Promise<Uint8Array | null>;
save_synctex(text: string): Promise<void>;
load_synctex(): Promise<string | null>;
```

Minimal acceptable strategy:

1. `load_project()` first attempts v2 current project and returns `snapshot_files()` equivalent if easy.
2. If v2 missing, load v1 default as current implementation does.
3. Store refactor can call new `load_ydoc_snapshot()` directly if `App.tsx` is adjusted.
4. Do not remove v1 reading in Wave 0.

### Migration From v1

v1 location:

```txt
eztex-projects/default/
  __manifest.json
  <encoded files>
  _output.pdf
  _output.synctex
```

Migration steps:

1. Check if v2 catalog exists and has projects.
2. If yes, do nothing.
3. If no, call existing v1 `load_project()` logic.
4. If v1 project exists, generate new `ProjectId`.
5. Create v2 Yjs document from files through store `load_files`.
6. Save `ydoc.bin`.
7. Save binary blobs under `blobs/<sha256>`.
8. Create `project.json`.
9. Create `catalog.json`.
10. Copy `_output.pdf` to `projects/<project_id>/outputs/output.pdf` if present.
11. Copy `_output.synctex` to `projects/<project_id>/outputs/output.synctex` if present.
12. Leave v1 data in place for rollback; do not delete in Wave 0.

### PDF/Synctex Outputs

Update output helpers to be project-aware if practical:

```ts
save_pdf(project_id: ProjectId, bytes: Uint8Array): Promise<void>;
load_pdf(project_id: ProjectId): Promise<Uint8Array | null>;
save_synctex(project_id: ProjectId, text: string): Promise<void>;
load_synctex(project_id: ProjectId): Promise<string | null>;
```

If changing call sites is too large, keep default current project internally.

---

## 8. Implementation Order

### Step 1: Dependencies, 15 minutes

Modify `app/package.json`.

Add dependencies:

```json
{
  "yjs": "^13.6.27",
  "y-codemirror.next": "^0.3.5",
  "y-protocols": "^1.0.6",
  "y-indexeddb": "^9.0.12",
  "lib0": "^0.2.114"
}
```

Run:

```sh
bun install
```

### Step 2: Create `y_project_doc.ts`, 2-3 hours

Implement schema, helpers, file ID creation, metadata helpers, snapshot encode/apply.

Can be parallel with OPFS work.

### Step 3: Implement BlobStore and Refactor Store Internals, 1 day

Modify `project_store.ts`.

Required output:

1. Existing API still compiles.
2. New Yjs methods exist.
3. Facade `files` updates from Yjs.
4. Text and binary paths work.

### Step 4: BroadcastChannel Provider, 3-4 hours

Add inside store or separate file.

Required output:

1. Two store instances for same project sync.
2. Updates do not echo infinitely.
3. Remote update refreshes Solid facade.

### Step 5: OPFS v2 Persistence, 1 day

Modify `project_persist.ts`.

Required output:

1. v2 catalog read/write.
2. Yjs snapshot read/write.
3. Blob read/write.
4. v1 default migration path.

### Step 6: App Integration, 3-5 hours

Modify `App.tsx`.

Current known edits:

1. `App.tsx:91`: `get_files` should use sync facade for now or async snapshot with watch adjustment.
2. `App.tsx:185`: load project/PDF/Synctex should use v2 current project if implemented.
3. `App.tsx:219`: compile should use `await store.snapshot_files()` if callback can be async, otherwise keep facade temporarily.
4. `App.tsx:230`: save should use Yjs snapshot persistence, not old `save_project(store.files)`.

Minimal approach:

1. Keep compile using `{ ...store.files }` for Wave 0 compatibility.
2. Change save path to save Yjs snapshot if new helper is ready.
3. Keep PDF/Synctex restore working.

### Step 7: Editor Refactor, 1 day

Modify `Editor.tsx`.

Required output:

1. yCollab binding works.
2. No keystroke writeback.
3. No full replacement on revision change.
4. File switch rebind works.
5. Undo/redo works.
6. Diagnostics, Vim, Synctex still work.

### Step 8: Worker Client Minor Updates, 1-2 hours

Modify `worker_client.ts` only if needed.

Expected minimal changes:

1. Accept compile files from `snapshot_files()`.
2. Preserve existing compile request shape.
3. Do not introduce server assumptions.

### Step 9: Build and Manual Verification, 2-4 hours

Run:

```sh
bun run build
```

Manual test matrix in section 9.

### Parallelizable Work

Can be parallelized:

1. `y_project_doc.ts` and `project_persist.ts` v2 helpers.
2. Editor refactor after `get_ytext()` API shape is fixed.
3. BroadcastChannel provider after basic Yjs doc exists.

Must be sequential:

1. Dependencies before TypeScript imports.
2. Store Yjs internals before Editor yCollab.
3. OPFS save/load before migration verification.

---

## 9. Testing Criteria

### Build

From `app/`:

```sh
bun run build
```

Must pass.

### Single-User Editing

Test:

1. Open app.
2. Type in `main.tex`.
3. Text appears immediately.
4. No console errors.
5. Reload page.
6. Text persists.

Expected:

1. Editor updates through yCollab.
2. Store facade has latest text.
3. OPFS restores Yjs snapshot.

### Two Tabs Converge

Test:

1. Open app in tab A.
2. Open same app in tab B.
3. Type `A` in tab A.
4. Confirm tab B receives `A`.
5. Type `B` in tab B.
6. Confirm tab A receives `B`.
7. Reload tab A.
8. Confirm full document restored.

Expected:

1. No infinite BroadcastChannel loop.
2. Both tabs converge.
3. Save/reload keeps latest content.

### File Switching

Test:

1. Create `a.tex`.
2. Type `AAA`.
3. Create `b.tex`.
4. Type `BBB`.
5. Switch between files repeatedly.

Expected:

1. Each file retains correct content.
2. Undo in `b.tex` does not corrupt `a.tex`.
3. No full document replacement transaction appears from file switch.

### Compile

Test:

1. Use default template.
2. Compile preview.
3. Full compile if UI supports it.
4. Add included `.tex` file and `\input`.
5. Compile again.

Expected:

1. Worker receives complete `ProjectFiles`.
2. PDF renders.
3. Diagnostics still map to current file.

### Undo/Redo

Test:

1. Type three edits.
2. Press Cmd/Ctrl+Z.
3. Press Cmd/Ctrl+Shift+Z or redo binding.
4. Switch files and return.
5. Undo still applies sensibly.

Expected:

1. Yjs undo manager handles local edits.
2. CodeMirror history is not used.
3. No crash after file switch.

### Binary Files

Test:

1. Upload/import image.
2. Select image in file panel.
3. Confirm preview renders.
4. Compile document using image if existing workflow supports it.

Expected:

1. Image bytes are returned by `get_content`.
2. Image not stored in Yjs.
3. `snapshot_files()` includes image bytes.

### Migration

Test:

1. Start with existing v1 saved project.
2. Load app after Wave 0.
3. Confirm project appears.
4. Reload.
5. Confirm v2 path loads.

Expected:

1. No data loss.
2. v1 data left intact.
3. v2 catalog exists.

---

## 10. Files To Modify

### `app/package.json`

Location:

1. Dependencies block lines `11-25`.

Add:

```json
"yjs": "^13.6.27",
"y-codemirror.next": "^0.3.5",
"y-protocols": "^1.0.6",
"y-indexeddb": "^9.0.12",
"lib0": "^0.2.114"
```

### `app/src/lib/y_project_doc.ts`

New file.

Must contain:

1. Type exports.
2. Top-level key constants.
3. Doc create/bind helpers.
4. File create/rename/delete helpers.
5. Snapshot encode/apply helpers.

### `app/src/lib/project_store.ts`

Major refactor.

Known line anchors:

1. Types lines `6-7`.
2. Binary extension helpers lines `9-22`.
3. `create_project_store` line `24`.
4. Existing CRUD methods lines `55-136`.
5. Return object lines `162-181`.

Required additions:

```ts
project_id
ydoc
awareness
get_ytext
snapshot_files
encode_ydoc_snapshot
apply_ydoc_snapshot
destroy
```

### `app/src/components/Editor.tsx`

Major refactor.

Known line anchors:

1. Imports lines `1-18`.
2. Initial state creation lines `206-245`.
3. Keystroke writeback lines `222-228`.
4. File replacement effect lines `280-293`.
5. Diagnostics lines `296-315`.
6. Synctex reverse sync lines `317-338`.

Required changes:

1. Add yCollab imports.
2. Remove CodeMirror history import/use.
3. Add Y.UndoManager.
4. Replace update_content writeback.
5. Replace revision-based full replacement effect with file-only rebind.

### `app/src/lib/project_persist.ts`

Moderate refactor.

Known line anchors:

1. Root constants lines `6-7`.
2. v1 directory helper lines `9-17`.
3. `save_project` lines `24-68`.
4. `load_project` lines `70-101`.
5. output helpers lines `144-195`.

Required additions:

1. v2 catalog helpers.
2. project manifest helpers.
3. Yjs snapshot save/load.
4. blob save/load.
5. v1 migration.

### `app/src/App.tsx`

Minor integration.

Known line anchors:

1. Store creation line `42`.
2. Folder sync line `43`.
3. Watch `get_files` line `91`.
4. Initial load line `185`.
5. Initial compile lines `217-221`.
6. Auto-save lines `224-231`.

Required changes:

1. Initialize v2 project load/migration if implemented outside store.
2. Use Yjs snapshot persistence on auto-save.
3. Prefer `snapshot_files()` for compile when feasible.
4. Keep old facade path if changing watch async is too risky.

### `app/src/lib/worker_client.ts`

Minor only if compile request typing requires updates.

Requirement:

1. Do not change worker protocol unless necessary.
2. Compile should continue receiving plain `ProjectFiles`.

---

## 11. Risk Mitigation

### Risk: Editor Regression

What could break:

1. Typing not reflected in store.
2. Remote BroadcastChannel updates not reflected in editor.
3. File switch loses content.
4. Undo/redo broken.

Mitigation:

1. Bind CodeMirror directly to `Y.Text`.
2. Remove keystroke writeback only after yCollab works.
3. Rebind with `view.setState`, not document replacement dispatch.
4. Test single file and multi-file editing before OPFS migration.

Rollback:

1. Revert `Editor.tsx` to old `update_content` model.
2. Keep Yjs store facade compatible so old editor can still read/write strings.

### Risk: Binary Files Enter Yjs

What could break:

1. Huge Yjs snapshots.
2. Slow BroadcastChannel messages.
3. Memory spikes.

Mitigation:

1. Enforce `Uint8Array` path in `update_content`.
2. Store only `content_hash` in Yjs.
3. Add assertions/comments in `y_project_doc.ts`.
4. Test image upload.

Rollback:

1. Keep binary bytes in `store.files` facade temporarily.
2. Persist binary through old OPFS file path until blob store is fixed.

### Risk: `store.files` Facade Stale

What could break:

1. Compile uses old contents.
2. Save persists old contents.
3. Watch hash misses edits.

Mitigation:

1. Refresh facade on every Yjs update.
2. Increment `revision`.
3. Call `_notify`.
4. Prefer `snapshot_files()` for new compile/save paths.

Rollback:

1. Use `update_content` compatibility path to force facade update.
2. Temporarily keep editor writeback if compile breaks, then remove after snapshot path is fixed.

### Risk: BroadcastChannel Infinite Echo

What could break:

1. CPU spike.
2. Repeated updates.
3. Tab lockup.

Mitigation:

1. Use `sender_id`.
2. Ignore self messages.
3. Use Yjs transaction origin `ORIGIN_REMOTE_BC`.
4. Do not broadcast updates with remote origin.

Rollback:

1. Disable BroadcastChannel provider behind a local constant.
2. Single-tab workflow remains functional.

### Risk: OPFS Migration Data Loss

What could break:

1. Existing saved projects disappear.
2. PDF restore breaks.
3. Synctex restore breaks.

Mitigation:

1. Do not delete v1 data.
2. Read v1 first in migration tests.
3. Write v2 alongside v1.
4. Keep old `load_project()` code path until v2 verified.

Rollback:

1. Ignore v2 catalog and call old `load_project()`.
2. Since v1 data remains, user data is recoverable.

### Risk: Compile Breaks Due Async Snapshot

What could break:

1. Watch controller expects sync `get_files`.
2. Compile receives proxy/store object instead of plain object.
3. Binary missing from compile.

Mitigation:

1. Keep `store.files` facade sync for Wave 0.
2. Add `snapshot_files()` but migrate compile call only if straightforward.
3. Ensure snapshot returns plain object.

Rollback:

1. Compile from `{ ...store.files }`.
2. Fix facade freshness before reattempting async compile path.

### Risk: Vim Mode Lost On Rebind

What could break:

1. File switch disables Vim.
2. Toggle state inconsistent.

Mitigation:

1. Keep `vim_compartment`.
2. Include it in every new EditorState.
3. Re-apply after `view.setState`.

Rollback:

1. If dynamic Vim reconfigure fails, force editor remount on file switch as temporary workaround.

### Risk: Diagnostics Disappear

What could break:

1. Recreated EditorState clears lint diagnostics.
2. Diagnostics not reapplied until next compile.

Mitigation:

1. Preserve diagnostics effect.
2. Make effect read `current_file`.
3. Dispatch diagnostics after rebind.

Rollback:

1. Trigger diagnostics effect by incrementing store revision after file switch.

---

## Final Implementation Guidance

Keep the implementation minimal.

Prefer:

1. Yjs as source of truth.
2. Store facade for compatibility.
3. BroadcastChannel only for same-origin local sync.
4. OPFS v2 alongside v1, not destructive migration.
5. Small, reversible changes in `App.tsx`.
6. No server assumptions.

Avoid:

1. Remote collaboration code in Wave 0.
2. Accounts, share links, permissions.
3. Putting binary bytes in Yjs.
4. Rewriting unrelated UI.
5. Removing `store.files` before all call sites are migrated.
