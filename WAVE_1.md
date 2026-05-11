# Wave 1: Multi-Project OPFS Persistence + Project Switcher UI

## Goal

Enable users to create, manage, and switch between multiple LaTeX projects stored in OPFS v2 layout. Each project has its own Yjs document, blob storage, outputs, and catalog entry.

## Scope

1. **Project Manager** (`project_manager.ts`): Async API for CRUD operations on the project catalog
2. **URL Routing**: `?project=abc123` opens a specific project; missing param uses catalog current_project
3. **Project Switcher UI**: Dropdown in toolbar showing current project name, list of projects, new/rename/delete actions
4. **App Integration**: Update `App.tsx` to respect URL project param and update catalog on load
5. **Commands**: Add `project.new`, `project.rename`, `project.delete`, `project.switch` to command palette

## Constraints

- **Page reload on switch**: For Wave 1, switching projects triggers a full page reload to `/?project=<id>`. This guarantees clean Yjs/BroadcastChannel/editor state teardown. In-place switching without reload is a future optimization.
- **No breaking changes**: Existing v1 `default` slot migration continues to work. New projects use v2 layout.
- **Minimal code**: Reuse existing `project_persist.ts` functions. Add only what's needed.

## API

### project_manager.ts

```typescript
export async function list_projects(): Promise<ProjectCatalogEntry[]>
export async function create_project(name?: string): Promise<ProjectId>
export async function delete_project(id: ProjectId): Promise<boolean>
export async function rename_project(id: ProjectId, name: string): Promise<void>
export async function get_project(id: ProjectId): Promise<ProjectCatalogEntry | null>
export async function set_current_project(id: ProjectId): Promise<void>
export function get_project_url(id: ProjectId): string
```

### URL Behavior

| URL | Action |
|-----|--------|
| `/?project=abc123` | Open project `abc123` if it exists in catalog; if not, create fresh project and redirect |
| `/` (no param) | Open `catalog.current_project_id`; if null, create fresh project |

On successful project load, `catalog.current_project_id` is updated to match.

### UI

**Toolbar project switcher** (left side, after logo):
- Current project name as a button/dropdown trigger
- Dropdown on click:
  - List of all projects (click to switch -> reload)
  - Separator
  - "New Project" -> prompt for name, create, reload to new project
  - "Rename" -> prompt for new name, update catalog + manifest
  - "Delete" -> confirm, delete project + OPFS dir, reload to another project or create new

## Implementation Plan

1. `project_manager.ts` (50-80 lines) - thin wrapper around `project_persist.ts` catalog/manifest functions
2. `App.tsx` - parse URL, validate project exists, update catalog, handle not-found
3. `Toolbar.tsx` - add `ProjectSwitcher` sub-component with dropdown
4. `register_commands.ts` - add project commands

## Acceptance Criteria

- [ ] Can create multiple projects, each with independent files
- [ ] Can switch between projects via toolbar dropdown (page reloads)
- [ ] Can rename a project
- [ ] Can delete a project (with confirmation)
- [ ] URL `?project=` correctly opens specified project
- [ ] Catalog `current_project_id` updated on every switch
- [ ] Build passes without errors
- [ ] No regressions in compile, preview, file panel, or folder sync

## Notes

- Project names default to "Untitled Project" but can be renamed
- Deleting the last project creates a fresh one automatically
- Outputs (PDF, synctex) are per-project and stored in `outputs/` subdir
- Yjs snapshots are per-project and stored as `ydoc.bin`
- Blob storage is per-project in `blobs/<sha256>`
