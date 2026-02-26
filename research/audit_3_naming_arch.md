# Audit 3: Naming, Namespace, Architecture Inconsistencies

## Major

### 1. Layout.zig is a 2415-line monolith doing too many things
- **File**: `src/Layout.zig`
- **Issue**: This single file contains: bbox cache, character protrusion codes, font unit conversion, engine accessors, graphite feature queries (12 functions), graphite breaking stubs, shaper queries, font filename helpers, OpenType table queries, glyph name/count/width queries, glyph bounds/sidebearings/italic correction, character mapping, engine lifecycle, font creation/deletion, glyph output, text shaping (layoutChars), font manager lifecycle, custom HarfBuzz callbacks (10 functions), HarfBuzz font initialization, platform font functions (Mac CoreText + non-Mac filesystem), and platform-conditional exports.
- **Impact**: Hard to navigate, understand scope, or modify safely. Merge conflicts likely when multiple areas are touched.
- **Recommendation**: Split into logical modules:
  - `Layout.zig` -> core engine lifecycle + text shaping
  - `BBoxCache.zig` -> bbox and cp_code caches
  - `OtQuery.zig` -> OpenType script/language/feature enumeration
  - `GraphiteQuery.zig` -> Graphite feature queries + stubs
  - `FontCreate.zig` -> font creation/deletion, FT initialization, HB font setup
  - `PlatformFont.zig` -> platform-conditional font discovery (Mac/non-Mac)

### 2. Mixed naming conventions in Layout.zig exports
- **File**: `src/Layout.zig`
- **Issue**: Export names mix multiple conventions:
  - camelCase C-style: `getCachedGlyphBBox`, `createLayoutEngine`, `deleteFont`, `layoutChars`, `countScripts`, `getIndScript`
  - Prefixed: `ttxl_font_units_to_points`, `ttxl_font_get_point_size`, `ttxl_platfont_get_desc`
  - No consistent pattern for when to use `ttxl_` prefix vs bare camelCase
- **Impact**: Confusing API surface. Hard to know whether a function is Layout-internal or a bridge export.
- **Recommendation**: Accept as-is. These names are dictated by the C engine's expectations (xetex-ext.c calls these by name). Renaming would require updating all C callers. The `ttxl_` prefix was added for functions that don't have existing C names.

### 3. File naming: Capitalized vs lowercase inconsistency
- **File**: `src/` directory
- **Issue**: Most files follow the Zig 0.15 file-as-struct convention (Capitalized): `Layout.zig`, `Engine.zig`, `Compiler.zig`, `World.zig`, `Host.zig`, `BundleStore.zig`, `FormatCache.zig`, `Cache.zig`, `Watcher.zig`, `Config.zig`, `MainDetect.zig`, `Log.zig`, `Flate.zig`, `Project.zig`. But also: `main.zig` (entry point, correctly lowercase), `seeds.zig` (data module, correctly lowercase), `wasm_exports.zig` (utility module with snake_case).
- **Impact**: Minor. The naming is actually consistent -- structs are Capitalized, modules are lowercase.
- **Recommendation**: No action needed. This follows the convention correctly.

### 4. C legacy names preserved in Zig code
- **File**: `src/Layout.zig`, `src/Engine.zig`
- **Issue**: Function names like `ttbc_issue_warning`, `ttbc_diag_begin_error`, `ttbc_input_open`, `ttbc_output_write` follow tectonic's C naming convention (`ttbc_` = tectonic bridge core). Zig code also uses `XeTeXFont_rec`, `XeTeXLayoutEngine_rec` (C struct naming with `_rec` suffix).
- **Impact**: Not idiomatic Zig, but changing names would break C ABI compatibility.
- **Recommendation**: Accept as-is. These are `export fn` functions and `extern struct` types that must match C declarations exactly.

## Minor

### 5. Engine/Compiler/World responsibility boundaries
- **File**: `src/Engine.zig`, `src/Compiler.zig`, `src/World.zig`
- **Issue**: The responsibility split is:
  - `Engine.zig`: C bridge exports (I/O, diagnostics, MD5), global state management
  - `Compiler.zig`: High-level compilation orchestration (multi-pass, format generation)
  - `World.zig`: I/O abstraction (handle management, file search, bundle store integration)
  
  This is actually well-structured. Engine is the C-facing layer, World is the I/O model, Compiler is the user-facing orchestrator.
- **Recommendation**: No action needed. The layering is clear and appropriate.

### 6. BundleStore vs Cache vs FormatCache naming
- **File**: `src/BundleStore.zig`, `src/Cache.zig`, `src/FormatCache.zig`
- **Issue**: Three different caching abstractions:
  - `BundleStore.zig`: Unified file resolution (cache + bundle index + network fetch)
  - `Cache.zig`: Content-addressed file cache with manifest (generic, native-only)
  - `FormatCache.zig`: Content-addressed SHA256 format file cache (specialized for .fmt files)
  
  The naming could be confusing -- "Cache" is very generic.
- **Impact**: Minor confusion for new contributors.
- **Recommendation**: Consider renaming `Cache.zig` to `FileCache.zig` to distinguish from `FormatCache.zig`. Low priority.

### 7. Host.zig + hosts/ pattern is clean
- **File**: `src/Host.zig`, `src/hosts/native.zig`, `src/hosts/wasm.zig`
- **Issue**: (Not a bug) Host.zig uses comptime dispatch to select between native and WASM host implementations. Clean abstraction.
- **Recommendation**: No action needed.

### 8. MainDetect.zig naming
- **File**: `src/MainDetect.zig`
- **Issue**: The name "MainDetect" could be confused with "main function detection". It actually detects the main .tex file in a project directory.
- **Impact**: Minimal -- the file has good comments explaining its purpose, and has tests.
- **Recommendation**: Could rename to `TexFileDetect.zig` or `ProjectDetect.zig` for clarity. Very low priority.

### 9. seeds.zig naming
- **File**: `src/seeds.zig`
- **Issue**: "seeds" is an unusual name for what is essentially a list of files to prefetch into cache. The name makes sense once you know it refers to "seeding the cache".
- **Impact**: Minimal.
- **Recommendation**: Accept as-is. The name is documented in the file and used clearly in Compiler.zig.
