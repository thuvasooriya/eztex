# Logging Analysis Report

## Architecture

Three logging mechanisms exist:

1. **Log.zig** -- central module
   - `Log.log(scope, level, fmt, args)` -- structured `[scope] level: msg` (info omits level tag)
   - `Log.dbg(scope, fmt, args)` -- debug-only, gated by runtime `debug_enabled` bool
   - `Log.log_stderr(prefix, fmt, args)` -- raw low-level stderr write

2. **Engine.zig** -- parallel verbose system (partially dead)
   - `log_bridge()` / `log_bundle()` -- gated by `bridge_verbose`
   - `Engine.set_verbose(v)` calls `World.set_verbose(v)` which **does not exist** -- dead code

3. **C engine diagnostic pipeline**
   - `xetex-output.c`: `error_here_with_diagnostic()` builds diagnostic via `ttbc_diag_*` API -> flows to Zig's `on_diag_error/warning` -> `diag_write_with_severity()`
   - `dpx-error.c`: `dpx_warning()` / `dpx_message()` write to stdout AND call `ttstub_issue_warning` -> Zig handler
   - `dpx-vf.c` + others: raw `fprintf(stderr, ...)` calls that bypass Zig entirely

`--verbose` flag sets `debug_enabled` = true. There is no separate `--debug` flag.

## Default Output (148 lines)

Captured from: `eztex compile tmp/test.tex`

Breakdown:
- **Essential eztex lines**: 6 lines (`compiling`, `pass 1`, `pass 2`, `aux stable`, `xdvipdfmx`, `output`)
- **TeX engine transcript** (C stdout routed through): ~130 lines of `(file.sty)` nesting, font warnings, geometry detection
- **Zig-formatted diagnostics**: 2x `warning: Underfull \hbox` with `-->` file pointer
- **xdvipdfmx output**: page markers `[1][2]`, byte count, and 4 duplicated warnings

### Issues Found in Default Output

**BUG 1: "warning: warning:" duplication (CRITICAL)**

```
warning: warning: Creating ToUnicode CMap failed for "FontAwesome5Free-Solid-900.otf"
Creating ToUnicode CMap failed for "FontAwesome5Free-Solid-900.otf"
```

Root cause in `dpx-error.c:dpx_warning()`:
- Line 107: writes `"warning: "` to stdout
- Line 109: calls `_dpx_print_to_stdout(fmt, argp, 1)` which:
  - Line 76: calls `ttstub_issue_warning()` -> Zig handler prints `"warning: <message>"` to stderr
  - Line 78: writes raw `<message>` to stdout

Result: stderr gets `warning: <message>` from Zig handler, stdout gets `warning: <message>` from C, and since both are merged in terminal, you see `warning: warning: <message>` followed by bare `<message>`.

Fix: In `dpx-error.c:dpx_warning()`, remove line 107 (`ttbc_output_write("warning: ", 9)`) and line 78's output write when `warn=1`. Let the Zig diagnostic handler be the sole warning printer. OR, simpler: set `_dpx_quietness = 1` before calling xdvipdfmx to suppress dpx stdout warnings, keeping only the Zig-routed ones.

**BUG 2: Missing newline before Zig diagnostic (concatenated lines)**

```
Underfull \hbox (badness 10000) in paragraph at lines 21--21warning: Underfull \hbox (badness 10000) in paragraph at lines 21--21
```

The C engine writes `"Underfull \hbox..."` to stdout without trailing newline, then the Zig diagnostic handler writes `"warning: Underfull \hbox..."` to stderr. Both streams merge in terminal output with no separator.

The C side (`error_here_with_diagnostic()` in xetex-output.c) BOTH prints to stdout via `print_file_line()` + `print_cstr(message)` AND captures to diagnostic. The diagnostic flows to Zig which prints again to stderr.

Fix: In `error_here_with_diagnostic()` (xetex-output.c:58-73), remove the `print_file_line()` and `print_cstr(message)` calls for warning-type diagnostics. The Zig handler already formats them nicely. Only the diagnostic capture path should remain.

**ISSUE 3: Severity mismatches (several .info calls should be .err or .warn)**

| Line | Current | Should Be | Message |
|------|---------|-----------|---------|
| Compiler.zig:397 | .info | debug | `calling xdvipdfmx(...)...` |
| Compiler.zig:405 | .info | debug | `xdvipdfmx returned: {d}` |
| Compiler.zig:411 | .info | .err | `xdvipdfmx abort reason: {s}` |
| Compiler.zig:413 | .info | .err | `xdvipdfmx abort: no error message` |
| Compiler.zig:820 | .info | debug | `pass {d} (auto, max {d})...` -- noisy per-pass |
| Compiler.zig:828 | .info | .err | `xetex failed on pass {d}` |
| Compiler.zig:855 | .info | .warn | `bibtex failed` |
| Compiler.zig:894 | .info | .err | `xdvipdfmx failed` |

**ISSUE 4: TeX transcript noise in default output**

~130 lines of `(file.sty (nested.sty))` and `LaTeX Font Warning:` etc. This is the TeX engine's "terminal output" routed through the C stdout handle. In default mode for a tool like eztex, this is noise. Users care about errors and the final PDF path.

This is a design question, not a bug. Options:
- Suppress C stdout in default mode, only show in `--verbose` (requires adding a quietness flag to the C engine)
- Parse and filter the TeX transcript to extract only warnings/errors
- Leave as-is (matches traditional TeX behavior)

## Verbose Output (13,291 lines)

Captured from: `eztex compile tmp/test.tex --verbose`

Breakdown by category:
- `[dbg:bridge] input_open(...)`: **1,969 lines** (14.8% of total)
- `[dbg:bs] open_file`: **5,069 lines** (38.1% of total)
- `[dbg:world]`: related bundle store resolution lines
- `[dbg:bridge] -> not found`: **73 lines**
- Everything else: TeX transcript, eztex info lines, diagnostic output

### Key Problem: Massive Duplication in Verbose

The C engine calls `input_open` multiple times for the SAME file (different TeX format codes tried sequentially). For example:

```
[dbg:bridge] input_open('etoolbox.sty', format=26)    -- repeated 11 times
[dbg:bs] open_file: "etoolbox.sty"                    -- repeated 11 times
[dbg:bs] open_file: cache hit for "etoolbox.sty"      -- repeated 11 times
[dbg:world]   -> found via bundle store: 'etoolbox.sty' -- repeated 11 times
[dbg:bridge]   -> handle 3                             -- repeated 11 times
```

Top offenders (same file opened N times per pass, x2 passes):
- `pdftexcmds.sty`: 26 times
- `infwarerr.sty`: 26 times
- `tgpagella.sty`: 24 times
- `xcolor.sty`: 22 times

Only 139 unique files are opened, but 1,969 `input_open` calls are logged.

This is not a Zig logging issue. The C engine genuinely calls `input_open` this many times because TeX tries different format/path combinations. The verbose output correctly reflects what happens, but it's too noisy to be useful.

Fix for verbose usability: In `Engine.zig:input_open` debug logging, deduplicate: only log the first open attempt per filename per pass, or only log the resolution result (found/not-found), not every attempt.

### Inconsistent Scoping

- `BundleStore.zig` uses scope `"bs"` -- should be `"bundle"` or `"bundle_store"`
- `native.zig` uses scope `"bundle"` for the same subsystem
- Duplicate message: both `BundleStore.zig:260` and `native.zig:208` log `"seed: {d} files to fetch"`

### Dead Code

- `Engine.set_verbose(v)` at Engine.zig:122 calls `World.set_verbose(v)` -- **this function does not exist in World.zig**
- This compiles because Zig only resolves function references when they're actually called at runtime, and this path may never be reached
- `log_bridge_always()` exists in Engine.zig but is never called

## Raw fprintf in C (bypasses Zig logging)

`dpx-vf.c` has direct `fprintf(stderr, ...)` calls at lines 84, 221, 230, 269, 288, 370, 434-435, 443-445, 526, 533. These bypass all Zig logging infrastructure. They write raw unformatted messages to stderr with no scope, no level, no structure.

711 total `dpx_warning()` call sites exist across the pdf_io C code. These at least go through the diagnostic pipeline via `ttstub_issue_warning`, but produce the "warning: warning:" duplication bug described above.

## Summary of Action Items

### Bugs to Fix (high priority)

1. **"warning: warning:" duplication** -- Fix in `dpx-error.c`: either remove the stdout `"warning: "` prefix write + raw message write when `warn=1`, or suppress dpx stdout output and let Zig handle all warning display
2. **Concatenated C stdout + Zig stderr** -- Fix in `xetex-output.c:error_here_with_diagnostic()`: remove `print_file_line()` + `print_cstr()` for warnings, let Zig diagnostic handler be the sole output path
3. **Dead code** -- Remove `World.set_verbose` call from `Engine.set_verbose()`, remove unused `log_bridge_always()`

### Severity Fixes (medium priority)

4. Change `Compiler.zig:411,413` from `.info` to `.err` (xdvipdfmx abort)
5. Change `Compiler.zig:828` from `.info` to `.err` (xetex failed)
6. Change `Compiler.zig:894` from `.info` to `.err` (xdvipdfmx failed)
7. Change `Compiler.zig:855` from `.info` to `.warn` (bibtex failed)
8. Change `Compiler.zig:397,405` from `Log.log(.info)` to `Log.dbg` (xdvipdfmx call/return are internal details)
9. Consider changing `Compiler.zig:820` (per-pass message) to debug-only -- it's noise in multi-pass compiles

### Verbose Usability (lower priority)

10. Deduplicate `input_open` debug logging -- only log first attempt or final resolution per unique filename
11. Unify `"bs"` scope to `"bundle"` or `"bundle_store"` for consistency
12. Remove duplicate seed message between `BundleStore.zig:260` and `native.zig:208`

### Design Decisions (deferred)

13. Whether to suppress TeX transcript output in default mode (large scope, changes user-visible behavior)
14. Whether to replace `dpx-vf.c` raw fprintf calls with `dpx_warning()` (low impact, only affects VF font edge cases)
