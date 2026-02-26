# Audit 1: Performance, Memory Leaks, Bad Practices

## Critical

### 1. gr_cache uses page_allocator and is never freed
- **File**: `src/Layout.zig`, line 405-411
- **Issue**: `gr_cache` is initialized with `std.heap.page_allocator` (line 409) and there is no `deinit()` call anywhere. `destroy_font_manager()` (line 1970) does not touch `gr_cache`. Each graphite font face+font pair is cached but never released. The page_allocator is the worst choice here -- it allocates full pages (4KB+) and never reclaims memory from individual frees.
- **Impact**: Memory leak proportional to number of unique Graphite fonts used. Page_allocator overhead means even a small HashMap wastes pages.
- **Recommendation**: Use `c_allocator` (consistent with rest of codebase), add `gr_cache.?.deinit()` in `destroy_font_manager()`, and call `gr_face_destroy`/`gr_font_destroy` on cached entries before clearing.

### 2. bbox_cache: 1MB+ always-resident static array
- **File**: `src/Layout.zig`, lines 174-201
- **Issue**: `max_cached_boxes = 65536` entries of `CachedBBox` (key:u32 + bbox:4xf32 + valid:bool = ~21 bytes, padded to likely 24). Total: ~1.5MB of static BSS. This memory is always resident regardless of whether any glyphs are cached.
- **Impact**: On WASM where memory is precious, 1.5MB of static data is significant. On native it matters less but is still wasteful for short-lived compilations.
- **Recommendation**: Consider lazy allocation (allocate on first use) or a smaller default size. A HashMap(u32, GlyphBBox) with ~4096 initial capacity would serve most documents and use ~100KB.

### 3. bbox_cache and cp_code hash collisions silently overwrite
- **File**: `src/Layout.zig`, lines 184, 196, 221-222, 232
- **Issue**: Both `bbox_cache` and `left_prot`/`right_prot` use modulo hashing (`key % max_cached_boxes` / `key % max_cp_entries`) with no collision handling. Hash collisions silently overwrite existing entries.
- **Impact**: For bbox_cache this is a performance issue (cache misses cause redundant FreeType glyph metric lookups). For cp_code, this is a **correctness** issue -- a collision means wrong protrusion values, causing incorrect typography.
- **Recommendation**: bbox_cache: acceptable as a cache (correctness unaffected, just performance). cp_code: this is a correctness bug -- collisions corrupt protrusion data. Replace with a proper HashMap or increase table size and use a better hash function.

### 4. afm_data intentionally leaked
- **File**: `src/Layout.zig`, line 1501
- **Issue**: Comment says "afm_data must remain valid while face is alive (intentional leak, same as C)". The malloc'd AFM data is never freed, even when the FT_Face is destroyed.
- **Impact**: Memory leak per Type1 font loaded. Small in practice since Type1 fonts are rare in modern usage.
- **Recommendation**: Store afm_data pointer in XeTeXFont_rec (or parallel tracking structure) and free in deleteFont(). Low priority since it mirrors upstream C behavior.

### 5. ft_face_count is non-atomic global
- **File**: `src/Layout.zig`, lines 1787, 1460, 1466, 1553
- **Issue**: `ft_face_count` is a plain `c_int` used as a reference counter for FT_Face objects. Incremented in `initialize_ft_internal` (line 1460), decremented in error paths (line 1466) and in `deleteFont` (line 1553). Not atomic.
- **Impact**: Currently single-threaded so not a live bug, but becomes a data race if threading is ever added. Same applies to `ft_lib`, `ft_lib_shutdown_pending`, `custom_font_funcs`.
- **Recommendation**: Mark as known single-threaded assumption. If threading is planned, convert to `std.atomic.Value(c_int)`.

## Major

### 6. get_ot_table_tag() repeated per-call overhead
- **File**: `src/Layout.zig`, line 685-691
- **Issue**: `get_ot_table_tag()` makes 2 HarfBuzz API calls (`hb_ot_layout_table_get_script_tags` for GSUB and GPOS). This function is called by `getIndScript`, `countLanguages`, `getIndLanguage`, `countFeatures`, `getIndFeature` -- each of which is called from C for every script/language/feature enumeration. For a font with N scripts, M languages, K features, this means O(N*M*K) calls to get_ot_table_tag, each doing 2 HB API calls.
- **Impact**: Performance degradation during font feature enumeration. Likely small in absolute terms since HB caches internally, but wasteful.
- **Recommendation**: Cache the table tag per hb_face_t (e.g., compute once and store alongside the face). Or accept it as-is since HB likely caches the data internally.

### 7. Excessive C allocator usage where Zig alternatives exist
- **File**: `src/Engine.zig` (lines 168-194), `src/Compiler.zig` (lines 183, 488, 499, 523), `src/World.zig` (line 271)
- **Issue**: `std.heap.c_allocator` is used pervasively for allocations that are Zig-internal (Diagnostic structs, file reads, ArrayList for gz_buf, format loading). c_allocator is fine for C interop but adds an unnecessary dependency on libc malloc for pure Zig allocations.
- **Impact**: Missed opportunity for better memory tracking/debugging. No practical performance issue.
- **Recommendation**: Low priority. Acceptable since libc is linked anyway. Consider `GeneralPurposeAllocator` for debug builds to catch leaks.

### 8. Diagnostic struct fixed 4096-byte buffer
- **File**: `src/Engine.zig`, line 26
- **Issue**: Each `Diagnostic` is heap-allocated (via c_allocator.create) with a fixed 4096-byte buffer. Messages longer than 4096 bytes are silently truncated.
- **Impact**: Potential loss of diagnostic information for very long error messages. Heap allocation of 4096 bytes for each begin_warning/begin_error call.
- **Recommendation**: Acceptable. TeX error messages are rarely >4K. Could use stack buffer instead of heap allocation to avoid the alloc/free overhead.

## Minor

### 9. create_font_mac opens N+1 FT faces for N-face font files
- **File**: `src/Layout.zig`, lines 2210-2243
- **Issue**: `get_file_name_from_ct_font` opens a temp FT_Face to get num_faces, then iterates all faces with FT_New_Face + FT_Get_Postscript_Name to match the PostScript name from CoreText. For a 10-face collection, this means 11 FT_New_Face calls.
- **Impact**: Slow font lookup for large font collections (e.g., Noto CJK with many faces). One-time cost per font.
- **Recommendation**: Accept as-is. This matches upstream C behavior and only runs once per font.

### 10. World fixed-size arrays
- **File**: `src/World.zig`, lines 159-184
- **Issue**: Fixed arrays: inputs/outputs[256], search_dirs[16], primary_input[512], output_dir[512], last_input_abspath[1024], format_name[64]. No overflow detection for some (search_dirs silently stops adding at 16).
- **Impact**: Adequate for TeX compilation. The 256-handle limit matches tectonic's original design.
- **Recommendation**: Accept as-is. These limits are appropriate for the domain.
