# Audit 4: Redundancies, Duplication, Overlapping Responsibilities

## Major

### 1. Extensive use of extern C functions where Zig equivalents exist
- **File**: `src/Layout.zig`, lines 587, 615-616, 946-948, 1193, 1418-1422, 1476-1484, 1996-1998
- **Functions used**:
  - `strcmp` (line 587) -> `std.mem.eql` or `std.mem.orderZ`
  - `strdup` (line 615) -> `std.heap.c_allocator.dupeZ`
  - `free` (line 616) -> `std.heap.c_allocator.free`
  - `malloc` (line 1476) -> `std.heap.c_allocator.alloc`
  - `calloc` (line 1535) -> `std.heap.c_allocator.create` (already used elsewhere)
  - `strlen` (line 1475) -> `std.mem.span` or `.len`
  - `strcpy`, `strcat`, `strrchr` (lines 1478-1484) -> Zig slice operations
  - `memset` (line 1495) -> `@memset`
  - `memcpy` -> `@memcpy` (already used in some places)
  - `access` (line 1996) -> `std.fs.accessAbsolute` or `std.fs.cwd().access`
  - `getenv` (line 1997) -> `std.posix.getenv`
  - `snprintf` (line 1998) -> `std.fmt.bufPrintZ`
- **Impact**: Mixed C/Zig idioms make the code harder to reason about. C functions don't return Zig errors (they return null or -1). Memory from `malloc` must be freed with `free`, not Zig allocator -- this is a maintenance trap.
- **Recommendation**: High-impact cleanup. Replace C string functions with Zig equivalents. Keep `malloc`/`free`/`calloc` only where the allocated memory is passed to/from C code that expects libc-allocated memory (e.g., `strdup` result returned to C caller).

### 2. Duplicate font_units_to_points / fix_to_d between Zig and C
- **File**: `src/Layout.zig` (Zig implementation), `pkg/tectonic/src/engine_xetex/xetex-ext.c` (C implementation)
- **Issue**: Both the Zig Layout.zig and the C xetex-ext.c contain implementations of `font_units_to_points` and `fix_to_d`. The Zig versions are exported as `ttxl_font_units_to_points` etc. The C versions exist in the linked C engine library.
- **Impact**: Two implementations of the same math. If one is changed, the other must match.
- **Recommendation**: Ensure C code calls the Zig exports rather than maintaining its own copy. Or accept the duplication since the C code is from upstream tectonic and not modified.

### 3. createLayoutEngine vs createLayoutEngineBorrowed
- **File**: `src/Layout.zig`, lines ~1258, ~1273
- **Issue**: Two functions that create layout engines. `createLayoutEngine` takes ownership of the font (`owns_font=1`), `createLayoutEngineBorrowed` does not (`owns_font=0`). Both are exported to C.
- **Impact**: Not true duplication -- they serve different ownership semantics. But the implementation is nearly identical (likely copy-pasted with one field changed).
- **Recommendation**: Could refactor to a single internal function with an `owns_font` parameter. Very low priority since the code is small.

### 4. Duplicate opaque type pattern
- **File**: `src/Layout.zig`
- **Issue**: HarfBuzz types are declared as opaque in two groups:
  - `hb_face_t` and `hb_font_t` at line 651-652
  - `hb_font_funcs_t` at line 1740
  - `hb_blob_t` at line ~1775
  These are all `opaque {}` but declared at different points in the file as needed.
- **Impact**: Minor. Scattered declarations make it harder to see all extern type dependencies.
- **Recommendation**: Group all opaque type declarations together at the top of the file (or in a separate `hb.zig` bindings file). Low priority.

### 5. setup_plain_format and generate_xelatex_format are near-duplicates
- **File**: `src/Compiler.zig`, lines 324-377, 381-443
- **Issue**: Both functions follow the same pattern: check if .fmt exists -> create temp .tex file -> set initex mode -> run xetex -> rename output -> cleanup. The only differences are the format name, the \input command, and the WASM log message.
- **Impact**: If the format generation logic needs to change, both functions must be updated.
- **Recommendation**: Extract a common `generate_format_internal(format_name, tex_content, ...)` helper. Medium priority.

## Minor

### 6. run_xetex, run_xdvipdfmx, run_bibtex use same buffer pattern
- **File**: `src/Compiler.zig`, lines 231-309
- **Issue**: All three functions create a 512-byte stack buffer, copy the input name, null-terminate it, then call the C entry point. Same pattern repeated 3 times.
- **Impact**: Minor code duplication. ~10 lines repeated.
- **Recommendation**: Extract a `to_cstring(buf: *[512]u8, input: []const u8) [*:0]const u8` helper. Very low priority.

### 7. countScripts duplicates get_ot_table_tag logic
- **File**: `src/Layout.zig`, lines 708-715
- **Issue**: `countScripts` manually queries both GSUB and GPOS script counts and returns the larger, which is exactly what `get_ot_table_tag` does internally (but only returns the tag, not the count). So countScripts reimplements the same logic instead of calling get_ot_table_tag + one more query.
- **Impact**: Trivial -- 3 extra lines of code.
- **Recommendation**: Accept as-is. The function needs both counts to return the max, while get_ot_table_tag only returns the tag.

### 8. Host abstraction overlaps with build.zig conditionals
- **File**: `src/Host.zig`, `build.zig`
- **Issue**: Platform selection happens at two levels: `build.zig` selects which libraries to link and which stubs to include, while `Host.zig` uses `comptime { if (builtin.os.tag == ...) }` to select host implementations. These are complementary, not conflicting.
- **Impact**: None -- this is the correct approach (build system for linking, comptime for Zig code paths).
- **Recommendation**: No action needed.
