# Audit 2: Async, Sync, Threading, Optimization Opportunities

## Critical

### 1. Layout.zig global mutable state is entirely thread-unsafe
- **File**: `src/Layout.zig`, multiple locations
- **Globals**: `bbox_cache` (line 180), `left_prot`/`right_prot` (line 216-217), `gr_cache` (line 405), `req_engine` (line 573), `ft_lib` (line 1786), `ft_face_count` (line 1787), `ft_lib_shutdown_pending` (line 1788), `custom_font_funcs` (line 1811), `ft_face_user_data_key` (line 1812), `mac_name_buf` (line 2294), `mac_desc_buf` (line 2311)
- **Issue**: All global state is plain `var` with no synchronization. If two compilation sessions run concurrently (e.g., watch mode with parallel builds), all of these are data races.
- **Impact**: Currently not a live bug since compilation is single-threaded, but completely prevents safe parallelism.
- **Recommendation**: Document single-threaded assumption clearly. If parallel compilation is ever needed, all Layout.zig globals need to be per-session or protected by a mutex.

### 2. Engine.zig global state prevents concurrent compilation
- **File**: `src/Engine.zig`, lines 48-50, 118, 579
- **Globals**: `global_world`, `global_bundle_store`, `global_diag_handler`, `bridge_verbose`, `checkpoint_handler`
- **Issue**: The entire engine is built around a single global World instance. `get_world()` returns the one global. This is fundamental to the C engine's design (the Tectonic C code uses global state extensively via setjmp/longjmp).
- **Impact**: Cannot run two TeX compilations in the same process concurrently. Watch mode works only because it reuses the same global between sequential runs.
- **Recommendation**: Accept as architectural constraint from C engine. Document clearly. If WASM needs concurrent compilations, they must be separate instances (separate WASM modules).

### 3. Compiler.zig global format buffer
- **File**: `src/Compiler.zig`, lines 322, 447-448
- **Globals**: `g_plain_fmt_buf`, `g_fmt_buf`, `g_format_bytes`
- **Issue**: Global mutable buffers for format file paths and in-memory format data. Not thread-safe.
- **Impact**: Same as above -- prevents concurrent compilation.
- **Recommendation**: Same as above.

## Major

### 4. WASM single-threaded constraints are well-handled
- **File**: `build.zig`, lines 7, 122, 173-184, 195-228, 255-260
- **Issue**: (Not a bug) WASM builds correctly disable threading features, use exception_handling for setjmp/longjmp, and include posix stubs + sjlj runtime.
- **Impact**: N/A -- this is working correctly.
- **Recommendation**: No action needed.

## Optimization Opportunities

### 5. Comptime lookup table for character classification
- **File**: `src/Layout.zig`
- **Issue**: Several functions do runtime character checking (e.g., `starts_with_icase` at line 2057). These are fine as-is but some hot paths could benefit from comptime tables.
- **Impact**: Minimal -- these are not hot paths.
- **Recommendation**: No action needed unless profiling shows otherwise.

### 6. get_ot_table_tag could cache result per face
- **File**: `src/Layout.zig`, lines 685-691
- **Issue**: As noted in Audit 1, this makes 2 HB API calls per invocation and is called repeatedly for the same face during script/language/feature enumeration.
- **Recommendation**: Could cache the table tag in a small inline cache (last face pointer + tag). Low priority since HarfBuzz likely has internal caching.

### 7. BundleStore seed_cache concurrency is fixed at 6
- **File**: `src/Compiler.zig`, line 581
- **Issue**: `default_seed_concurrency = 6` is hardcoded. No way to tune it.
- **Impact**: May be suboptimal for fast or slow network connections.
- **Recommendation**: Accept as-is. 6 concurrent fetches is a reasonable default. Could be made configurable later if needed.

### 8. Format file loaded into memory twice during generation
- **File**: `src/Compiler.zig`, lines 515-537
- **Issue**: `cache_generated_format` reads the format file from disk (line 520-524), stores it in the content-addressed cache (line 527), copies it to legacy location (line 533), then stores it in `g_format_bytes` (line 535). The format file is read from disk even though it was just written.
- **Impact**: Extra disk I/O on first-run format generation. One-time cost.
- **Recommendation**: Could capture the format bytes during generation instead of re-reading from disk. Very low priority.

## Minor

### 9. Watcher.zig is properly platform-abstracted
- **File**: `src/Watcher.zig`
- **Issue**: (Not a bug) Uses kqueue on macOS, inotify on Linux, poll fallback. Not available on WASM (correctly excluded).
- **Recommendation**: No action needed.

### 10. No async I/O patterns in the codebase
- **Issue**: The codebase is entirely synchronous. File I/O, network fetches (in BundleStore), and compilation are all blocking.
- **Impact**: Acceptable for CLI tool. WASM builds work because the WASI runtime handles blocking I/O.
- **Recommendation**: No action needed. Async would add significant complexity for minimal benefit in a TeX compiler.
