# Audit 5: Legacy and Dead Code

## Critical

### 1. getDesignSize always returns 10.0 -- stub masking real functionality
- **File**: `src/Layout.zig`, lines 642-644
- **Issue**: `export fn getDesignSize(_: ?*XeTeXFont_rec) f64 { return 10.0; }`. This is a stub that always returns a hardcoded value. The real implementation should read the design size from the font's OS/2 table or head table.
- **Impact**: **Correctness issue**: any TeX code that queries the font's design size gets a wrong answer. In practice this matters for optical sizing and font selection at specific design sizes. Most LaTeX documents don't query this, but OpenType variable fonts and some specialized packages do.
- **Recommendation**: Implement properly by reading from the font's `size` feature in GPOS table or from the OS/2 table. Or document as known limitation. Priority depends on whether users need optical sizing.

### 2. initGraphiteBreaking / findNextGraphiteBreak are permanent stubs
- **File**: `src/Layout.zig`, lines 561-567
- **Issue**: `initGraphiteBreaking` always returns `false`, `findNextGraphiteBreak` always returns `0`. These are called from `xetex-ext.c` (linebreak_next in the line breaking code). The C code checks the return of `initGraphiteBreaking` and falls back to ICU line breaking.
- **Impact**: Graphite-based line breaking is non-functional. The fallback to ICU works for most languages, but Graphite line breaking is important for some complex scripts (e.g., Myanmar, Khmer with Graphite fonts).
- **Recommendation**: Document as known limitation. Implementing Graphite line breaking requires significant effort (creating a Graphite segment, iterating break opportunities). Low priority unless users need complex script support with Graphite.

## Major

### 3. bridge_flate directory contains only a header file
- **File**: `pkg/tectonic/src/bridge_flate/`
- **Issue**: The `bridge_flate` directory contains only `tectonic_bridge_flate.h` with no `.c` implementation. The Flate bridge is implemented in Zig (`src/Flate.zig`) which directly links against zlib.
- **Impact**: The header file is unused dead code. It was part of original tectonic's C build but is no longer needed since Zig provides the implementation.
- **Recommendation**: Delete the header file and directory. Very low risk.

### 4. wasm_stubs included in build system but only used for WASM
- **File**: `pkg/tectonic/src/wasm_stubs/`, `build.zig` lines 195-210
- **Issue**: The wasm_stubs directory contains fontconfig stubs and wasm_compat.h. These are correctly only compiled into the WASM build (conditional in build.zig). Not dead code -- properly gated.
- **Impact**: None. This is working correctly.
- **Recommendation**: No action needed.

### 5. Graphite feature query functions work but line breaking doesn't
- **File**: `src/Layout.zig`, lines 442-559
- **Issue**: The 12 Graphite feature query functions (countGraphiteFeatures, getGraphiteFeatureCode, etc.) are fully implemented and work correctly. But the line breaking functions (items 2 above) are stubs. This is an inconsistent partial implementation.
- **Impact**: Confusing -- Graphite features appear to work (font menus show Graphite features) but line breaking doesn't use Graphite.
- **Recommendation**: Document this asymmetry. The feature queries were easier to implement (just call gr_* functions) while line breaking requires creating segments.

## Minor

### 6. hb_h_origin_func and hb_v_origin_func are no-ops
- **File**: `src/Layout.zig`, lines 1850-1860
- **Issue**: Both functions always set x=0, y=0 and return 1. This matches the upstream C implementation (layout.c) -- HarfBuzz uses these as defaults and they're rarely meaningful for horizontal text.
- **Impact**: None. This is correct behavior.
- **Recommendation**: No action needed.

### 7. ttbc_output_flush is a no-op
- **File**: `src/Engine.zig`, lines 285-288
- **Issue**: `export fn ttbc_output_flush(handle: Handle) c_int { _ = handle; return 0; }`. Always returns success without flushing.
- **Impact**: File writes use std.fs.File which is unbuffered at the Zig level (writes go directly to OS). The C engine calls flush as a safety measure. Since there's no user-space buffer, the no-op is correct.
- **Recommendation**: Add a comment explaining why it's a no-op. No functional change needed.

### 8. ttbc_shell_escape always returns 1 (disallowed)
- **File**: `src/Engine.zig`, lines 544-548
- **Issue**: Shell escape is permanently disabled. Returns 1 (disallowed) always.
- **Impact**: Intentional security decision. Some TeX packages (minted, gnuplot-lua) require shell escape, but enabling it in a web-capable tool is a security risk.
- **Recommendation**: Document as intentional. Consider making it configurable for native builds via a CLI flag in the future.

### 9. on_diag_warning discards all warnings
- **File**: `src/Compiler.zig`, lines 138-140
- **Issue**: `fn on_diag_warning(text: []const u8) void { _ = text; }`. All diagnostic warnings are silently discarded.
- **Impact**: Users don't see TeX warnings (overfull hboxes, undefined references, etc.) unless they check the log file.
- **Recommendation**: Should at least write to stderr or store for later display. This is a UX issue for interactive usage.

### 10. TecKit usage (C++ dependency)
- **File**: `pkg/tectonic/src/engine_xetex/teckit-Engine.cpp`
- **Issue**: TecKit is a text encoding conversion library used by XeTeX for legacy font encoding support. It's compiled as C++ and linked into the engine.
- **Impact**: Adds C++ dependency and binary size. TecKit is rarely needed with modern Unicode fonts, but some legacy TeX documents depend on it.
- **Recommendation**: Accept as-is. Removing TecKit would break compatibility with legacy documents. It's part of the upstream tectonic engine.

### 11. Platform-conditional exports at end of Layout.zig
- **File**: `src/Layout.zig`, lines 2397-2415
- **Issue**: A `comptime` block at the end of the file conditionally exports Mac CoreText or non-Mac filesystem font functions. The pattern is: `comptime { if (is_mac) { @export(...); } else { @export(...); } }`.
- **Impact**: This is not dead code -- it's the platform abstraction mechanism. But it means both Mac and non-Mac implementations are always compiled (both exist in the binary as regular functions), only the export symbols differ.
- **Recommendation**: Accept as-is. Zig's comptime conditional export is the correct pattern. The unused platform functions are optimized away by the linker since they're not referenced.
