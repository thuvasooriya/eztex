# Local Folder Select & Sync Plan

## Bottom Line

Use the File System Access API (`showDirectoryPicker` with `mode: 'readwrite'`) to let users select a local folder as the backing store for their LaTeX project. eztex owns the folder during a session -- sync is **one-way outbound** (eztex -> disk) triggered by explicit events (save, compile, idle). Conflicts are only possible at session boundaries (folder open / reconnect) and are resolved via a diff UI. This composes cleanly with Yjs collab: the `ProjectStore` is the sole live source of truth, and the local folder is just a persistence target. Chrome/Edge only; Firefox/Safari get read-only import + ZIP export.

## 1. API Capability Matrix

| API                        | Chrome/Edge | Firefox | Safari | Notes                                        |
| -------------------------- | ----------- | ------- | ------ | -------------------------------------------- |
| `showDirectoryPicker()`    | Yes (86+)   | No      | No     | Requires HTTPS + user gesture. Not Baseline. |
| `FileSystemDirectoryHandle`| Yes         | No      | No     | Structured-cloneable (IndexedDB storable)    |
| `createWritable()`         | Yes         | No      | No     | Write-back to user filesystem                |
| Handle persistence (IDB)   | Yes         | N/A     | N/A    | Must re-request permission each session      |
| `<input webkitdirectory>`  | Yes         | Yes     | Yes    | Read-only flat FileList. No write-back.      |
| OPFS                       | Yes         | Yes     | Yes    | Sandboxed, not visible to user. Already used.|

**Decision**: Target Chrome/Edge for full read-write sync. Firefox/Safari get read-only import + ZIP export. Do NOT polyfill or abstract across browsers -- the capabilities are fundamentally different.

## 2. Architecture Design

### Core Mental Model

Opening a local folder says: *"Use this folder as the backing store for this project session."* This is the same model as VS Code's File > Open Folder. eztex is the sole editor during the session. The disk is a write-only persistence target, not a live input source.

### Data Flow

```
                 [session start: open_folder()]
                            |
                            v
              Read all files from disk
              Build baseline hashes
                            |
                            v
Yjs CRDT (collab) ---+
                     +---> ProjectStore <--- CodeMirror (local edits)
Local edits ---------+           |
                          [sync trigger event]
                          (Cmd+S / compile / idle / tab close)
                                 |
                                 v
                     Conflict check (baseline hash vs disk)
                                 |
                       +---------+---------+
                       |                   |
                    no conflict          conflict
                       |                   |
                       v                   v
                  Write to disk       Show diff UI
                  Update baseline     User resolves
                                           |
                                           v
                                      Write to disk
                                      Update baseline
```

### Key Principle: ProjectStore is the Single Source of Truth

Whether edits come from local typing, Yjs collab peers, or initial folder load -- they all flow through `ProjectStore`. The local folder sync module is a **side-effect layer** that persists store state to disk on trigger events. Every other part of eztex (editor, compiler, file tree) works identically regardless of backing store (OPFS, ZIP, or local folder).

### TypeScript Interfaces

```typescript
// app/src/lib/local_folder_sync.ts

interface LocalSyncState {
  dir_handle: FileSystemDirectoryHandle | null;
  active: boolean;
  baseline_hashes: Map<string, string>;   // path -> SHA-1 hash at last sync
  last_sync: number;                       // timestamp of last successful sync
  syncing: boolean;                        // true during an active sync operation
  dirty_files: Set<string>;                // files modified since last sync
  error: string | null;
}

interface SyncOptions {
  idle_timeout_ms: number;      // default 30000 (30s of no edits triggers sync)
  ignored_patterns: string[];   // default: [".git", "node_modules", ".DS_Store", ...]
  max_file_size: number;        // default: 10MB
  sync_on_compile: boolean;     // default: true
}

// public API
function create_local_folder_sync(store: ProjectStore): LocalFolderSync;

interface LocalFolderSync {
  state: LocalSyncState;             // reactive (SolidJS signal)
  open_folder(): Promise<boolean>;   // triggers showDirectoryPicker, reads files, takes baseline
  reconnect(): Promise<boolean>;     // re-request permission on stored handle
  disconnect(): void;                // stop sync, clear handle
  sync_now(): Promise<SyncResult>;   // manually trigger a sync (called by event triggers)
  is_supported(): boolean;           // feature detection
}

type SyncResult = 
  | { status: "ok"; files_written: number }
  | { status: "conflict"; conflicts: ConflictInfo[] }
  | { status: "error"; message: string };

interface ConflictInfo {
  path: string;
  eztex_content: FileContent;
  disk_content: FileContent;
  eztex_hash: string;
  disk_hash: string;
}
```

### Module Placement

```
app/src/lib/
  local_folder_sync.ts     -- core sync logic + event triggers
  local_folder_detect.ts   -- browser capability detection (~30 lines)
  local_folder_conflict.ts -- conflict detection + diff generation
app/src/components/
  Toolbar.tsx              -- add "Open Folder" button (Chrome) or hide it
  FolderSyncStatus.tsx     -- status indicator (synced/dirty/syncing/conflict/error)
  ConflictDialog.tsx       -- diff view + resolution UI
```

## 3. Sync Trigger Events

### Design Rationale

Since eztex is the sole editor during a session, there is no need to poll the filesystem for external changes. Sync is purely outbound: eztex decides *when* to flush its in-memory state to disk. This eliminates:
- The entire polling loop and adaptive interval logic
- The `pending_writes` echo prevention mechanism
- `FileSystemObserver` considerations
- All bidirectional sync complexity

### Trigger Events

| Trigger | When it fires | Scope | Always on? |
|---------|--------------|-------|------------|
| **Explicit save (Cmd+S)** | User presses Cmd+S / Ctrl+S | Current file only (fast path), or all dirty files | Yes, always |
| **Compile complete** | Tectonic run finishes successfully | All dirty files | Default on, configurable |
| **Idle timeout** | No edits for 30s | All dirty files | Default on, configurable |
| **File switch** | User switches to a different file tab | The file being switched away from | Yes, always |
| **Page unload** | `beforeunload` / `visibilitychange` to hidden | All dirty files (best-effort) | Yes, always |

### Dirty Tracking

Instead of syncing the entire project on every trigger, track which files have been modified since the last sync:

```typescript
// subscribe to ProjectStore changes
unsub = store.on_change(() => {
  // diff store state against baseline_hashes to find dirty files
  for (const path of store.file_names()) {
    const content = store.get_content(path);
    const current_hash = hash_sync(content);
    if (current_hash !== state.baseline_hashes.get(path)) {
      state.dirty_files.add(path);
    }
  }
  // also detect deletions: baseline has it, store doesn't
  for (const path of state.baseline_hashes.keys()) {
    if (!store.file_names().includes(path)) {
      state.dirty_files.add(path); // marked for deletion on sync
    }
  }
  reset_idle_timer();
});
```

### Idle Timer

```typescript
let idle_timer: number | null = null;

function reset_idle_timer() {
  if (idle_timer) clearTimeout(idle_timer);
  idle_timer = setTimeout(() => {
    if (state.dirty_files.size > 0) sync_now();
  }, options.idle_timeout_ms);
}
```

### Page Unload Safety Net

```typescript
// best-effort sync on page hide/close
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.dirty_files.size > 0) {
    // use synchronous write if possible, or fire-and-forget async
    sync_now();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty_files.size > 0) {
    // warn user about unsaved changes
    e.preventDefault();
    e.returnValue = "";
  }
});
```

### Why Debounce is Unnecessary

With polling, writes happened on every keystroke (debounced to 500ms) to keep disk in sync for external editors to see. With event-driven sync, the *trigger events themselves* are inherently infrequent:
- Cmd+S: user-initiated, naturally infrequent
- Compile: happens at most a few times per minute
- Idle: fires once after 30s of quiet
- File switch: at most once per tab change

No debounce needed. Each trigger calls `sync_now()` directly. If a sync is already in progress (the `syncing` flag), the call is a no-op -- the next trigger will catch any remaining dirty files.

### Performance: Polling vs Event-Driven

For a typical 1-hour session (20 files, 500 edits across 3 files):

| Metric | Polling (2s interval) | Event-driven |
|--------|----------------------|-------------|
| Disk reads (polling inbound) | ~1,800 polls x 20 files = **36,000 file reads** | **20 reads** (initial load only) |
| Hash computations | **36,000** | **~60** (on sync events for dirty files) |
| Disk writes | ~500 (debounced from edits) | **~40** (Cmd+S + compile + idle triggers) |
| Total I/O operations | **~72,500** | **~120** |
| CPU overhead | Constant background hashing | Near zero between syncs |

~600x reduction in disk I/O. The browser tab uses negligible CPU between sync events.

## 4. Write-Back Design

### Strategy: Event-Triggered Sync

Write-back happens only when a sync trigger fires and dirty files exist. No background writes, no debouncing.

```typescript
async function sync_now(): Promise<SyncResult> {
  if (state.syncing || state.dirty_files.size === 0) {
    return { status: "ok", files_written: 0 };
  }
  state.syncing = true;

  try {
    const dirty = [...state.dirty_files];
    const conflicts: ConflictInfo[] = [];
    let files_written = 0;

    for (const path of dirty) {
      const store_content = store.get_content(path);
      const store_deleted = !store.file_names().includes(path);

      // conflict check: has the disk file changed since our baseline?
      const conflict = await check_conflict(path, state.baseline_hashes.get(path));
      if (conflict) {
        conflicts.push({
          path,
          eztex_content: store_content,
          disk_content: conflict.disk_content,
          eztex_hash: await hash_content(store_content),
          disk_hash: conflict.disk_hash,
        });
        continue; // skip writing conflicted files
      }

      if (store_deleted) {
        await delete_file(state.dir_handle!, path);
      } else {
        await write_file(state.dir_handle!, path, store_content);
      }

      state.baseline_hashes.set(path, await hash_content(store_content));
      state.dirty_files.delete(path);
      files_written++;
    }

    state.last_sync = Date.now();

    if (conflicts.length > 0) {
      return { status: "conflict", conflicts };
    }
    return { status: "ok", files_written };
  } catch (err) {
    state.error = `Sync failed: ${err}`;
    return { status: "error", message: String(err) };
  } finally {
    state.syncing = false;
  }
}
```

### write_file Implementation

```typescript
async function write_file(dir: FileSystemDirectoryHandle, path: string, content: FileContent) {
  const parts = path.split('/');
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  const file_handle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file_handle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function delete_file(dir: FileSystemDirectoryHandle, path: string) {
  const parts = path.split('/');
  let current = dir;
  for (const part of parts.slice(0, -1)) {
    try {
      current = await current.getDirectoryHandle(part);
    } catch {
      return; // parent dir doesn't exist, file already gone
    }
  }
  try {
    await current.removeEntry(parts[parts.length - 1]);
  } catch {
    // file already gone, that's fine
  }
}
```

### Error Handling

| Error                     | Cause                        | Response                                   |
| ------------------------- | ---------------------------- | ------------------------------------------ |
| `NotAllowedError`         | Permission revoked           | Show "Permission lost" banner, offer reconnect |
| `NotFoundError`           | File/dir deleted externally  | Remove from baseline, continue             |
| `NoModificationAllowedError` | File locked by another app | Retry once, then show warning              |
| `QuotaExceededError`      | Disk full                    | Show error, stop sync                      |

### Ignored Files and Directories

```typescript
const IGNORED_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "__pycache__",
  ".DS_Store", "Thumbs.db",
  "__MACOSX",
]);

const IGNORED_PREFIXES = [".", "_minted-"];

function is_ignored(path: string): boolean {
  const parts = path.split("/");
  return parts.some(p => IGNORED_DIRS.has(p) || IGNORED_PREFIXES.some(pre => p.startsWith(pre)));
}
```

### Sync Extensions (stricter than zip_utils KNOWN_EXTS)

```typescript
const SYNC_EXTS = new Set([
  // source files
  "tex", "sty", "cls", "bib", "bst", "def", "cfg", "clo", "dtx", "fd",
  // text assets
  "txt", "md",
  // binary assets
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "ico",
  "ttf", "otf", "woff", "woff2",
  "pdf", "eps", "ps",
]);
// Explicitly excludes aux, log, toc, lof, lot, idx, ind, gls, glo, ist, bbl, blg
// Those are build artifacts generated by tectonic
```

### OPFS Interaction

When local folder sync is active, OPFS persistence is **disabled**. The local folder IS the persistence layer. On disconnect, the current state remains in-memory (and can be saved to OPFS or downloaded as ZIP).

## 5. Conflict Detection & Resolution

### When Conflicts Can Occur

Since eztex owns the folder during a session, conflicts can only arise from:

1. **Session open**: User opens a folder that was edited externally since the last eztex session (by git, a build tool, another editor, etc.)
2. **Background processes**: A git hook, build script, or formatter modifies a file while eztex has a session open
3. **Reconnect**: User reloads the page and reconnects to a previously-opened folder that was modified in between

Conflicts are **rare by design**. The common case is zero conflicts.

### Conflict Check Algorithm

Before writing a file to disk, compare the current disk content against our baseline:

```typescript
async function check_conflict(
  path: string,
  baseline_hash: string | undefined
): Promise<{ disk_content: FileContent; disk_hash: string } | null> {
  if (!baseline_hash) return null; // new file, no conflict possible

  try {
    const disk_content = await read_file(state.dir_handle!, path);
    const disk_hash = await hash_content(disk_content);

    if (disk_hash === baseline_hash) return null; // disk unchanged since baseline

    return { disk_content, disk_hash };
  } catch {
    return null; // file doesn't exist on disk, no conflict
  }
}
```

### On open_folder(): Initial Conflict Check

When opening a folder for the first time in a session, there is no conflict -- we simply read whatever is on disk and that becomes our baseline + store state.

When **reconnecting** to a previously-opened folder (stored handle in IndexedDB), we may need to merge:
- If the store still has unsaved in-memory state from the previous session (unlikely after page reload, but possible with service worker persistence), compare it against disk and show conflicts if any.
- In practice, reconnect is equivalent to a fresh open: read disk, populate store, take baseline.

### Conflict Resolution UX

When `sync_now()` returns `{ status: "conflict", conflicts }`:

1. Sync is **blocked** for conflicted files (non-conflicted files are written normally)
2. A `ConflictDialog` appears showing each conflict:
   - File path
   - Side-by-side or inline diff of eztex version vs disk version
   - Three buttons: **"Keep eztex"** / **"Keep disk"** / **"Merge manually"**
3. User resolves each conflict in sequence

```typescript
// conflict resolution actions
async function resolve_conflict(path: string, resolution: "eztex" | "disk") {
  if (resolution === "disk") {
    // load disk content into store, overwriting eztex state
    const disk_content = await read_file(state.dir_handle!, path);
    store.update_content(path, disk_content);
    state.baseline_hashes.set(path, await hash_content(disk_content));
  } else {
    // write eztex content to disk, overwriting disk state
    const content = store.get_content(path);
    await write_file(state.dir_handle!, path, content);
    state.baseline_hashes.set(path, await hash_content(content));
  }
  state.dirty_files.delete(path);
}
```

### Diff Library

Use the `diff` npm package (BSD, ~5KB gzipped) for text diffs. It provides `diffLines()` which generates a line-level diff suitable for rendering.

Render as an inline diff within `ConflictDialog.tsx`:
- Removed lines (disk version only): red background
- Added lines (eztex version only): green background
- Unchanged lines: normal

For **"Merge manually"**: open both versions in a temporary split view where the user can copy sections between them. This is a v2 nicety -- v1 ships with just "Keep eztex" / "Keep disk".

### Binary Files (images, fonts, PDFs)

Diff is meaningless for binary files. Show:
- File path and sizes of both versions
- Thumbnails if it's an image
- Two buttons: **"Keep eztex"** / **"Keep disk"**

No "Merge manually" option for binaries.

### Hashing Strategy

Use `crypto.subtle.digest('SHA-1', content)` -- hardware-accelerated, async, available in all browsers. For a 50-file project this is <5ms total.

```typescript
async function hash_content(content: FileContent): Promise<string> {
  const data = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(content);
  const hash_buffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash_buffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
```

## 6. Collab Integration

### Why Mutual Exclusion is Removed

The original plan made collab and folder sync mutually exclusive because polling created a **bidirectional** sync problem: both Yjs peers and the local filesystem were live input sources into ProjectStore, creating a three-way merge nightmare.

With event-driven sync, the filesystem is **write-only** during a session. The data flow is:

```
Remote peers (Yjs) ---+
                      +---> ProjectStore ----> CodeMirror
Local typing ---------+          |
                          [sync event]
                                 |
                                 v
                          Write to local disk
```

There is no inbound data flow from disk. ProjectStore / Yjs doc is the sole source of truth for live state. Writing to disk is no different from writing to OPFS or downloading a ZIP -- it's a persistence side effect, not a mutation source.

### How They Compose

| Scenario | What happens | Result |
|----------|-------------|--------|
| User types locally + folder sync | Edit -> ProjectStore -> sync event -> disk | Normal operation |
| Collab peer edits + folder sync | Yjs merge -> ProjectStore -> sync event -> disk | Peer edits get written to local disk |
| Internet drops (collab disconnects) + folder sync | CRDT handles offline; disk keeps getting synced | On reconnect, Yjs merges offline edits |
| User closes collab while folder sync is active | Last Yjs state persists in ProjectStore -> next sync writes it | Clean shutdown |
| Same folder on two machines, both in collab | Yjs handles merge; each machine writes to its own local disk | Both disks converge to same state |
| Collab peer changes file after we synced it to disk | Next sync event overwrites disk with latest ProjectStore state | Disk is always at most one sync interval behind |

### No Remaining Three-Way Merge Problem

The disk is never read after initial load (except for conflict checks, which are one-shot comparisons, not live data feeds). It cannot inject state into the live editing flow. Therefore:
- Yjs merges remote + local edits in the CRDT (its job)
- Folder sync writes the merged result to disk (our job)
- These are orthogonal operations

### Edge Cases to Guard

**Joining collab while folder sync is active**: When the user joins a collab room, Yjs performs state merge on connect. The richer CRDT state wins (standard Yjs behavior). After join, any changes from merging will make the affected files dirty, and the next sync event writes the merged state to disk. No special handling needed -- this flows through the existing dirty tracking.

**Starting folder sync while in collab**: The folder's files are loaded into ProjectStore (via `load_files()`), which merges with Yjs state. Same as above.

**User's local folder as collab backup**: When a user is both the collab room owner and has folder sync active, their local folder becomes a persistent backup of the collab session. This is a natural benefit, not a special feature that needs code.

### UX When Both Are Active

The status bar shows both indicators independently:
- Folder sync indicator: "Synced to ~/thesis" (green) / "3 files pending" (yellow) / etc.
- Collab indicator: "2 peers connected" / "Offline" / etc.

No special combined indicator needed. The user understands: "My collab session saves to my local folder."

Optional: when folder sync is first activated during an active collab session, show a one-time tooltip: *"Collab edits will be synced to your local folder on save."*

## 7. Browser Compatibility & UX

### Feature Detection

```typescript
export function supports_folder_sync(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export function get_browser_hint(): string | null {
  if (supports_folder_sync()) return null;
  return "Local folder sync requires Chrome or Edge. You can still import folders and download as ZIP.";
}
```

### UI Behavior by Browser

**Chrome/Edge (full support)**:
- Toolbar shows "Open Folder" button (folder icon)
- Clicking triggers `showDirectoryPicker({ mode: 'readwrite', id: 'eztex-project' })`
- Status indicator in toolbar: green = synced, yellow = dirty/syncing, red = error/conflict
- File panel shows "(local)" badge next to project name

**Firefox/Safari (fallback)**:
- "Open Folder" button is hidden
- Existing "Upload Folder" button (webkitdirectory input) remains
- Subtle inline notice: "Local folder sync is available in Chrome and Edge"
- "Download as ZIP" always available (already exists)

### Permission Flow

```
1. User clicks "Open Folder"
2. Browser shows native directory picker
3. eztex reads all files, populates ProjectStore, takes baseline hashes
4. Store handle in IndexedDB for reconnection
5. On next page load:
   a. Check IndexedDB for stored handle
   b. Call handle.queryPermission({ mode: 'readwrite' })
   c. If 'granted': auto-reconnect (re-read files, take new baseline)
   d. If 'prompt': show "Reconnect to [folder name]?" banner with button
   e. If 'denied': clear stored handle, show nothing
```

### Handle Persistence via IndexedDB

```typescript
const DB_NAME = 'eztex-folder-sync';
const STORE_NAME = 'handles';

async function store_handle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(handle, 'project-dir');
  await tx_complete(tx);
}

async function load_handle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await open_db();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const handle = await tx.objectStore(STORE_NAME).get('project-dir');
  return handle ?? null;
}
```

### Window Title / Project Identity

When a local folder is the backing store, the window title should reflect it:
- `eztex - thesis/` (folder name)
- Or `eztex - main.tex (thesis/)` when editing a specific file

This reinforces the mental model: "I opened my thesis folder in eztex."

## 8. Implementation Phases

### Phase 0: Browser Detection & UI Wiring (Quick, ~2h)

- [ ] Create `app/src/lib/local_folder_detect.ts` (~30 lines)
- [ ] Add "Open Folder" button to `Toolbar.tsx` (conditionally rendered)
- [ ] Add inline browser hint text for Firefox/Safari
- [ ] Wire up `showDirectoryPicker()` call (no sync yet, just prove the picker works)

### Phase 1: Read-Only Folder Open (Short, ~4h)

- [ ] Create `app/src/lib/local_folder_sync.ts` skeleton
- [ ] Implement `walk_directory()` recursive iterator
- [ ] Implement `open_folder()` -> read all files -> `store.load_files()`
- [ ] Implement SHA-1 hashing and baseline snapshot
- [ ] Filter by `SYNC_EXTS`, skip ignored dirs
- [ ] Handle binary vs text files correctly
- [ ] Test: open a real LaTeX project folder, verify it loads and compiles

### Phase 2: Event-Triggered Write-Back (Medium, ~6h)

- [ ] Implement `write_file()` and `delete_file()` with directory creation
- [ ] Implement dirty tracking via `store.on_change()` subscription
- [ ] Implement `sync_now()` with conflict check before each write
- [ ] Wire up sync triggers: Cmd+S, compile complete, file switch
- [ ] Implement idle timer (30s)
- [ ] Implement `beforeunload` / `visibilitychange` safety net
- [ ] Disable OPFS persistence when folder sync is active
- [ ] Error handling for permission loss, disk full, file locked
- [ ] Add `FolderSyncStatus.tsx` component (synced/dirty/syncing/error indicator)
- [ ] Test: edit in eztex, press Cmd+S, verify file changes on disk

### Phase 3: Conflict Detection & Diff UI (Medium, ~6h)

- [ ] Implement `check_conflict()` (hash comparison against baseline)
- [ ] Install `diff` npm package
- [ ] Create `ConflictDialog.tsx` with inline diff rendering
- [ ] Implement "Keep eztex" / "Keep disk" resolution actions
- [ ] Handle binary file conflicts (size + thumbnail comparison, no diff)
- [ ] Test: modify file externally while eztex session is open, trigger sync, verify conflict UI appears
- [ ] Test: resolve conflict both ways, verify correct outcome

### Phase 4: Handle Persistence & Reconnection (Short, ~3h)

- [ ] IndexedDB store/load for `FileSystemDirectoryHandle`
- [ ] On page load: check for stored handle, query permission
- [ ] "Reconnect" banner UI
- [ ] On reconnect: re-read all files, take fresh baseline (effectively a new session open)
- [ ] Clear stale handles on permission denial
- [ ] Test: reload page, verify reconnection flow

**Total estimated effort: ~21h of focused implementation.**

## 9. Concrete Code Patterns

### Directory Walker

```typescript
async function* walk_directory(
  dir: FileSystemDirectoryHandle,
  prefix: string = ""
): AsyncGenerator<[string, FileContent]> {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      if (is_ignored_dir(name)) continue;
      yield* walk_directory(handle as FileSystemDirectoryHandle, path);
    } else {
      if (!is_sync_ext(name)) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      if (file.size > MAX_FILE_SIZE) continue;
      if (is_binary(name)) {
        yield [path, new Uint8Array(await file.arrayBuffer())];
      } else {
        yield [path, await file.text()];
      }
    }
  }
}
```

### Sync Lifecycle

```typescript
export function create_local_folder_sync(store: ProjectStore): LocalFolderSync {
  const [state, set_state] = createSignal<LocalSyncState>({
    dir_handle: null,
    active: false,
    baseline_hashes: new Map(),
    last_sync: 0,
    syncing: false,
    dirty_files: new Set(),
    error: null,
  });

  let unsub_store: (() => void) | null = null;
  let idle_timer: number | null = null;

  async function open_folder(): Promise<boolean> {
    if (!supports_folder_sync()) return false;
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'eztex-project',
      });

      // read all files
      const files: ProjectFiles = {};
      const hashes = new Map<string, string>();
      for await (const [path, content] of walk_directory(handle)) {
        files[path] = content;
        hashes.set(path, await hash_content(content));
      }

      if (Object.keys(files).length === 0) {
        set_state(s => ({ ...s, error: "No supported files found in folder." }));
        return false;
      }

      // load into store
      store.load_files(files);

      set_state({
        dir_handle: handle,
        active: true,
        baseline_hashes: hashes,
        last_sync: Date.now(),
        syncing: false,
        dirty_files: new Set(),
        error: null,
      });

      await store_handle(handle);

      // subscribe to store changes for dirty tracking
      unsub_store = store.on_change(() => {
        track_dirty_files();
        reset_idle_timer();
      });

      return true;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return false;
      set_state(s => ({ ...s, error: `Failed to open folder: ${err}` }));
      return false;
    }
  }

  function disconnect() {
    if (idle_timer) clearTimeout(idle_timer);
    idle_timer = null;
    if (unsub_store) unsub_store();
    unsub_store = null;
    set_state({
      dir_handle: null,
      active: false,
      baseline_hashes: new Map(),
      last_sync: 0,
      syncing: false,
      dirty_files: new Set(),
      error: null,
    });
  }

  function reset_idle_timer() {
    if (idle_timer) clearTimeout(idle_timer);
    idle_timer = setTimeout(() => {
      const s = state();
      if (s.active && s.dirty_files.size > 0) sync_now();
    }, 30000) as unknown as number;
  }

  return {
    state,
    open_folder,
    reconnect: async () => { /* IndexedDB handle reload + requestPermission + re-read files */ },
    disconnect,
    sync_now,
    is_supported: supports_folder_sync,
  };
}
```

### Toolbar Integration

```tsx
// in Toolbar.tsx
import { supports_folder_sync, get_browser_hint } from "../lib/local_folder_detect";

// inside component:
<Show when={supports_folder_sync()}>
  <button
    class={styles.toolbar_btn}
    onClick={() => folder_sync.open_folder()}
    title="Open local folder"
  >
    <FolderIcon />
  </button>
</Show>

<Show when={!supports_folder_sync()}>
  <span class={styles.browser_hint}>{get_browser_hint()}</span>
</Show>

<Show when={folder_sync.state().active}>
  <FolderSyncStatus state={folder_sync.state()} />
</Show>
```

### File Size Guard

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
```

## 10. Open Questions

1. **Should we write tectonic output (.pdf) back to the local folder?** Probably yes -- users expect compiled PDFs next to their source. But .aux/.log should not be written (they're build artifacts). Could be a setting: "Write compiled PDF to folder" (default on).

2. **What about `.latexmkrc` / other config files?** eztex uses tectonic, so latexmk configs are irrelevant. Just ignore them during read.

3. **Should "Open Folder" replace the current project or open in a new tab/window?** Replace. eztex is single-project. Opening a folder is equivalent to loading a new project. Prompt to save current work if unsaved.

4. **Should sync triggers be user-configurable?** For v1, ship with the recommended defaults (all triggers on). A settings panel could expose "sync on compile" and "idle timeout" toggles in a future iteration. Don't build the settings UI until users ask for it.

5. **Should "Merge manually" be in v1?** No. Ship with "Keep eztex" / "Keep disk" only. Manual merge (split editor view) is a v2 feature if users need it. The 90% case is simply choosing one version.
