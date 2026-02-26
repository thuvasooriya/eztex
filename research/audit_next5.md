# Audit: Next 5 Fixes

## Selection Rationale

Ranked by: correctness bugs > memory/resource issues > code quality > style.
Excluding already-fixed: gr_cache leak, bbox_cache collision, getDesignSize stub,
threading docs, C stdlib replacements (strcmp/strlen/memcpy).

## Selected Issues

### 1. page_allocator used for all HashMap caches (Audit 1 #1 residual + Audit 1 #2)
- **Files**: `src/Layout.zig` lines 191, 221, 409
- **Fix**: Replaced `page_allocator` with `c_allocator` at all 3 sites.
- [x] DONE

### 2. memset on FT_Open_Args + strlen/strcpy/strcat/strrchr in AFM code (Audit 4 #1 residual)
- **File**: `src/Layout.zig` ~1482-1516
- **Fix**: Replaced with `std.mem.zeroes`, `std.mem.span`, `std.fmt.bufPrintZ`,
  `std.mem.lastIndexOfScalar`. Removed 5 unused extern fn declarations.
- [x] DONE

### 3. snprintf/getenv/access C stdlib in platform font code (Audit 4 #1 residual)
- **File**: `src/Layout.zig` ~2018-2145, ~2340
- **Fix**: Replaced `getenv` -> `std.posix.getenv`, `snprintf` -> `std.fmt.bufPrintZ`,
  `access` -> `std.fs.cwd().accessZ`. Removed 4 unused extern decls + F_OK constant.
  Also fixed a bug in `register_bundle_fonts` subdirectory loop (first snprintf
  used wrong base variable).
- [x] DONE

### 4. Compiler.zig format generation duplication (Audit 4 #5)
- **File**: `src/Compiler.zig` ~449-568
- **Fix**: Extracted `FormatSpec` struct and `run_initex` helper. Both
  `setup_plain_format` and `generate_xelatex_format` are now one-line wrappers.
  Also removed dead `g_plain_fmt_buf` variable.
- [x] DONE

### 5. ttbc_output_flush no-op without comment (Audit 5 #7)
- **File**: `src/Engine.zig` lines 285-288
- **Fix**: Added comment explaining no-op is correct because Zig's std.fs.File
  writes are direct syscalls with no user-space buffering.
- [x] DONE
