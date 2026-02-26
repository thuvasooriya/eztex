# eztex Architecture Plan: Multi-Engine Library

## 1. Library API Design

### Naming and Structure

Keep the name `eztex`. The library is the core; CLI and WASM are thin consumers.

```
eztex/
  src/
    lib/                    # the library (public API)
      root.zig              # pub const Compiler = @import("Compiler.zig"); etc.
      Compiler.zig          # comptime-parameterized, engine-generic orchestration
      Engine.zig            # ttbc_* bridge, C ABI globals (unchanged)
      World.zig             # I/O abstraction, handle table (unchanged)
      BundleStore.zig       # bundle fetching/caching (unchanged)
      FormatCache.zig       # format file content-addressed cache (unchanged)
      Host.zig              # comptime platform dispatch (unchanged)
      Cache.zig             # disk/memory cache layer (unchanged)
      Log.zig               # diagnostic formatting (unchanged)
      Flate.zig             # compression (unchanged)
      seeds.zig             # seed list management (unchanged)
      hosts/
        native.zig          # HTTP, filesystem, threads
        wasm.zig            # JS extern imports
    cli/
      main.zig              # CLI entry, arg parsing, calls lib
      Watcher.zig           # file watch loop
      Config.zig            # CLI config loading
      Project.zig           # project detection
      MainDetect.zig        # main file heuristics
    wasm/
      exports.zig           # WASM export surface, calls lib
  pkg/
    tectonic/               # XeTeX engine (existing)
      build.zig
      src/
    pdftex/                 # pdfTeX engine (new, Phase 1)
      build.zig
      src/
  build.zig                 # top-level: lib, cli, wasm targets
```

### What moves where from current src/

| Current file | Destination | Change |
|---|---|---|
| Engine.zig | lib/Engine.zig | none |
| World.zig | lib/World.zig | none |
| Compiler.zig | lib/Compiler.zig | parameterize with comptime Backend |
| Host.zig | lib/Host.zig | none |
| BundleStore.zig | lib/BundleStore.zig | none |
| FormatCache.zig | lib/FormatCache.zig | none |
| Cache.zig | lib/Cache.zig | none |
| Log.zig | lib/Log.zig | none |
| Flate.zig | lib/Flate.zig | none |
| seeds.zig | lib/seeds.zig | none |
| main.zig | cli/main.zig | thin wrapper calling lib |
| Watcher.zig | cli/Watcher.zig | none |
| Config.zig | cli/Config.zig | none |
| Project.zig | cli/Project.zig | none |
| MainDetect.zig | cli/MainDetect.zig | none |
| wasm_exports.zig | wasm/exports.zig | calls lib instead of inlining logic |
| hosts/native.zig | lib/hosts/native.zig | none |
| hosts/wasm.zig | lib/hosts/wasm.zig | none |

### Public API surface

```zig
// lib/root.zig - the library's public module
const eztex = @This();

pub const Backend = @import("Compiler.zig").Backend;
pub const Compiler = @import("Compiler.zig").Compiler;
pub const World = @import("World.zig");
pub const BundleStore = @import("BundleStore.zig");
pub const FormatCache = @import("FormatCache.zig");
pub const Host = @import("Host.zig");
pub const Log = @import("Log.zig");

// What a consumer calls to compile a document:
//
//   const C = eztex.Compiler(.xetex);
//   var compiler = try C.init(allocator, world, bundle_store, format_cache);
//   defer compiler.deinit();
//   const result = try compiler.compile(.{
//       .input = input_bytes,         // or .input_path for file-backed
//       .format = .latex,
//       .synctex = true,
//   });
//   // result.pdf is []const u8, result.diagnostics is []Diagnostic, result.log is []const u8
```

### Build artifact structure

```zig
// build.zig (simplified)
pub fn build(b: *std.Build) void {
    // Library - static lib for embedding
    const lib = b.addStaticLibrary(.{
        .name = "eztex",
        .root_source_file = b.path("src/lib/root.zig"),
        .target = target,
    });
    // Link engine C libs based on build option
    const backend = b.option(Backend, "backend", "Engine backend") orelse .xetex;
    switch (backend) {
        .xetex => linkTectonic(lib),
        .pdftex => linkPdftex(lib),
    }
    b.installArtifact(lib);

    // CLI - native executable
    const cli = b.addExecutable(.{
        .name = "eztex",
        .root_source_file = b.path("src/cli/main.zig"),
        .target = target,
    });
    cli.root_module.addImport("eztex", &lib.root_module);
    b.installArtifact(cli);

    // WASM - one binary per engine (comptime selection)
    const wasm = b.addExecutable(.{
        .name = "eztex",
        .root_source_file = b.path("src/wasm/exports.zig"),
        .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi }),
    });
    wasm.root_module.addImport("eztex", &lib.root_module);
    b.installArtifact(wasm);
}
```

Build commands:
- `zig build -Dbackend=xetex` -- native CLI with XeTeX
- `zig build -Dbackend=pdftex` -- native CLI with pdfTeX
- `zig build -Dbackend=xetex -Dtarget=wasm32-wasi` -- WASM XeTeX binary
- `zig build -Dbackend=pdftex -Dtarget=wasm32-wasi` -- WASM pdfTeX binary

Decision: **comptime engine selection, one binary per engine**. For WASM, binary size wins. A pdfTeX-only WASM binary is ~500KB-1MB smaller than a combined binary. JS loader picks which .wasm to fetch. For native CLI, could support both in one binary via runtime flag, but comptime keeps it simpler and consistent.


## 2. XeTeX Capability Comparison: Tectonic vs SwiftLaTeX

| Dimension | Tectonic XeTeX | SwiftLaTeX XeTeX |
|---|---|---|
| **I/O bridge** | ttbc_* callbacks (generic, no filesystem assumption) | kpseemu.c + Emscripten MemFS + synchronous XHR |
| **Build system** | Zig cc (already integrated in eztex) | Emscripten (emmake/emcc), incompatible with Zig build |
| **WASM support** | Via Zig's wasm32-wasi target, same source | Emscripten-only, separate toolchain |
| **Font handling** | xetex_layout with harfbuzz/graphite2, no fontconfig dependency | Pre-compiled .a libs, Emscripten-linked |
| **Format dump/restore** | Supported via ttbc_* bridge, format files are regular I/O | Heap snapshot trick (snapshot Module.HEAP8 after format load) |
| **SyncTeX** | Supported | Unknown/untested |
| **Fork depth** | Deep fork: all kpathsea replaced, layout engine restructured | Lighter fork: kpseemu shim atop relatively stock TeX Live XeTeX |
| **Maintenance** | Active (tectonic project) | Minimal (SwiftLaTeX focuses on pdfTeX WASM) |
| **pdfTeX sibling** | No | Yes (pdftex.wasm/) |
| **Binary size (WASM)** | ~4-6MB (XeTeX + deps) | ~4-6MB (similar, different deps) |

### Verdict

**Keep tectonic's XeTeX. SwiftLaTeX XeTeX adds nothing.**

Tectonic's ttbc_* bridge is the right abstraction -- it decouples the engine from the I/O layer completely, which is exactly what eztex needs. The Zig build integration is already working. SwiftLaTeX's XeTeX is Emscripten-locked and less maintained.

The only value SwiftLaTeX provides is its **pdfTeX sibling** and the **kpseemu.c shim pattern** -- which we will reuse for pdfTeX integration (Section 4), not for XeTeX.


## 3. Zero-Cost Multi-Engine Interface

### Core abstraction: comptime-parameterized Compiler

```zig
// lib/Compiler.zig
const std = @import("std");
const Engine = @import("Engine.zig");
const World = @import("World.zig");

pub const Backend = enum {
    xetex,
    pdftex,
};

pub fn Compiler(comptime backend: Backend) type {
    return struct {
        const Self = @This();

        world: *World,
        format_cache: *FormatCache,
        bundle_store: *BundleStore,
        allocator: std.mem.Allocator,

        pub const Format = switch (backend) {
            .xetex => enum { latex, plain },
            .pdftex => enum { latex, plain },
            // identical now, but xetex could gain xelatex-specific formats later
        };

        pub const Result = struct {
            pdf: []const u8,
            diagnostics: []const Diagnostic,
            log: []const u8,
        };

        pub const Options = struct {
            format: Format = .latex,
            synctex: bool = false,
            max_passes: u8 = 3,
        };

        pub fn init(
            allocator: std.mem.Allocator,
            world: *World,
            bundle_store: *BundleStore,
            format_cache: *FormatCache,
        ) Self {
            return .{
                .allocator = allocator,
                .world = world,
                .bundle_store = bundle_store,
                .format_cache = format_cache,
            };
        }

        pub fn compile(self: *Self, input: []const u8, opts: Options) !Result {
            // 1. Ensure format is available (dump if needed)
            const format_data = try self.ensureFormat(opts.format);

            // 2. Run engine passes until aux files stabilize
            var pass: u8 = 0;
            while (pass < opts.max_passes) : (pass += 1) {
                try self.runPass(input, format_data, opts);
                if (try self.auxStable()) break;
            }

            // 3. Engine-specific output pipeline
            const pdf = try self.produceOutput(opts);
            return .{ .pdf = pdf, .diagnostics = &.{}, .log = &.{} };
        }

        // -- Engine-specific internals, selected at comptime --

        const engine_main = switch (backend) {
            .xetex => @extern(*const fn () -> c_int, .{ .name = "tt_engine_xetex_main" }),
            .pdftex => @extern(*const fn () -> c_int, .{ .name = "tt_engine_pdftex_main" }),
        };

        fn runPass(self: *Self, input: []const u8, format_data: []const u8, opts: Options) !void {
            Engine.setWorld(self.world);
            Engine.setInput(input);
            Engine.setFormat(format_data);
            const ret = engine_main();
            if (ret != 0) return error.EngineError;
        }

        fn produceOutput(self: *Self, opts: Options) ![]const u8 {
            switch (backend) {
                .xetex => {
                    // XeTeX pipeline: XDV -> xdvipdfmx -> PDF
                    const xdv = Engine.getOutput();
                    const xdvipdfmx_main = @extern(
                        *const fn () -> c_int,
                        .{ .name = "tt_engine_xdvipdfmx_main" },
                    );
                    Engine.setInput(xdv);
                    const ret = xdvipdfmx_main();
                    if (ret != 0) return error.XdvipdfmxError;
                    return Engine.getOutput();
                },
                .pdftex => {
                    // pdfTeX pipeline: source -> PDF directly (no XDV)
                    return Engine.getOutput();
                },
            }
        }

        fn ensureFormat(self: *Self, format: Format) ![]const u8 {
            // Same logic for both engines: check cache, dump if missing
            // Format file name differs per engine
            const format_name = switch (backend) {
                .xetex => switch (format) {
                    .latex => "xelatex.fmt",
                    .plain => "xetex.fmt",
                },
                .pdftex => switch (format) {
                    .latex => "pdflatex.fmt",
                    .plain => "pdftex.fmt",
                },
            };
            return self.format_cache.getOrDump(format_name, self.bundle_store);
        }

        fn auxStable(self: *Self) !bool {
            // Compare aux file hashes between passes - same logic for all engines
            _ = self;
            return true; // placeholder
        }
    };
}
```

### How Engine.zig globals work with comptime selection

Engine.zig's file-scope globals (`var the_world: *World = undefined;` etc.) and ttbc_* exports remain unchanged. The C ABI callbacks have no user-data parameter, so globals are unavoidable. This is fine because:

1. Only one engine runs at a time (no concurrent compilation in one process).
2. The globals are set before calling `engine_main` and read during the call.
3. Both XeTeX and pdfTeX (via kpseemu-to-ttbc_* shim) call the same ttbc_* symbols.

The comptime selection happens one layer up -- `Compiler(.xetex)` calls `tt_engine_xetex_main`, `Compiler(.pdftex)` calls `tt_engine_pdftex_main`. The bridge layer beneath is shared.

```
Consumer (CLI / WASM)
  |
  v
Compiler(backend)          <-- comptime-selected engine orchestration
  |
  v
Engine.zig (ttbc_* bridge) <-- shared, engine-agnostic
  |
  v
C engine code              <-- tectonic XeTeX or TeX Live pdfTeX
```

### Build.zig: separate artifacts per backend

```zig
// In build.zig, for WASM we produce two artifacts:
const backends = [_]Backend{ .xetex, .pdftex };
for (backends) |backend| {
    const wasm = b.addExecutable(.{
        .name = switch (backend) {
            .xetex => "eztex-xetex",
            .pdftex => "eztex-pdftex",
        },
        .root_source_file = b.path("src/wasm/exports.zig"),
        .target = wasm_target,
    });
    const opts = b.addOptions();
    opts.addOption(Backend, "backend", backend);
    wasm.root_module.addOptions("build_options", opts);
    switch (backend) {
        .xetex => linkTectonic(wasm),
        .pdftex => linkPdftex(wasm),
    }
    b.installArtifact(wasm);
}
```

At runtime (JS side), the loader picks which .wasm to fetch based on the document's engine requirement. No runtime dispatch overhead. No dead engine code in the binary.


## 4. Engine Sourcing and Forking Strategy

### Phase 1: Wire best available

**XeTeX -- tectonic's fork (already done)**
- Upstream: https://github.com/tectonic-typesetting/tectonic
- Status: fully integrated in eztex, working on native + WASM
- Sync strategy: periodic manual sync of C source changes (tectonic releases are infrequent, ~quarterly)
- No changes needed

**pdfTeX -- TeX Live source + kpseemu-to-ttbc_* shim (new)**
- Upstream: https://github.com/TeX-Live/texlive-source (mirror of SVN), specifically `texk/web2c/pdftexdir/`
- The web2c tangle output (pdftex.c, pdftex0.c) is what we compile -- not the .web source
- Dependencies: libpng, zlib (already linked for tectonic), no harfbuzz/ICU/graphite2 needed (pdfTeX has no OpenType layout)
- New directory: `pkg/pdftex/`

**The kpseemu-to-ttbc_* shim:**

pdfTeX calls kpathsea functions (`kpse_find_file`, `kpse_open_file`, etc.) for all I/O. We need a shim that translates these to ttbc_* calls so pdfTeX uses eztex's World/BundleStore infrastructure.

```c
// pkg/pdftex/src/kpseemu.c
// Adapted from SwiftLaTeX's kpseemu.c pattern, but targeting ttbc_* instead of Emscripten XHR

#include "tectonic_bridge_core.h"  // ttbc_* declarations

// kpathsea API that pdfTeX expects:
char *kpse_find_file(const char *name, kpse_file_format_type format, boolean must_exist) {
    // Map kpathsea format types to ttbc file types
    ttbc_file_format ttbc_fmt = kpse_format_to_ttbc(format);
    // Use ttbc to find the file through eztex's World
    int handle = ttbc_input_open_name(name, ttbc_fmt);
    if (handle < 0) return must_exist ? NULL : NULL;
    ttbc_input_close(handle);
    // Return the name -- the actual I/O goes through ttbc when pdfTeX opens it
    return strdup(name);
}

FILE *kpse_open_file(const char *name, kpse_file_format_type format) {
    // Can't return a real FILE* -- instead, route through ttbc handles
    // This requires a thin wrapper: pdftex_io.c that replaces pdfTeX's
    // direct fopen/fread calls with ttbc_input_read equivalents
}
```

The shim is ~200-400 lines of C. The harder part is replacing pdfTeX's direct `FILE*` I/O with ttbc handle-based I/O in a few dozen call sites within the pdfTeX source. Estimated ~500-800 lines of C changes total in the vendored pdfTeX code.

**pkg/pdftex/build.zig:**

```zig
pub fn buildPdftex(b: *std.Build, target: std.Build.ResolveTarget) *std.Build.Step.Compile {
    const lib = b.addStaticLibrary(.{
        .name = "pdftex",
        .target = target,
    });
    lib.addCSourceFiles(.{
        .files = &.{
            "src/pdftex.c",
            "src/pdftex0.c",
            "src/kpseemu.c",    // the shim
            "src/pdftex_io.c",  // FILE* -> ttbc handle wrapper
        },
        .flags = &.{"-DEZTEX_PDFTEX"},
    });
    lib.addIncludePath(b.path("src"));
    lib.addIncludePath(b.path("../../pkg/tectonic/src")); // for tectonic_bridge_core.h
    lib.linkLibrary(libpng);
    lib.linkLibrary(zlib);
    return lib;
}
```

**Sync strategy:**
- Tectonic XeTeX: check upstream quarterly, cherry-pick bug fixes
- TeX Live pdfTeX: check upstream annually (pdfTeX changes very rarely -- it's essentially feature-frozen)

### Phase 2: Fork and innovate

**Fork point:** after Phase 1 is working and tested on both native and WASM.

**Preamble checkpoint/restore -- the C-level changes:**

The goal is to serialize engine state at `\begin{document}` so subsequent compiles skip the preamble. This requires hooks in the TeX engine's inner loop.

For XeTeX (tectonic's C code):
1. Add a callback `ttbc_checkpoint_save(void *state, size_t len)` and `ttbc_checkpoint_restore(void **state, size_t *len)` to the bridge.
2. In `main_body()` (xetex0.c), after the preamble commands are processed and `\begin{document}` triggers the transition to document mode, call a new function `eztex_save_checkpoint()`.
3. `eztex_save_checkpoint()` serializes: the hash table (macro definitions), equivalents table (category codes, counters, dimensions), font tables (loaded fonts + metrics), string pool, and the memory (token lists, node lists in use).
4. On restore: instead of calling `load_fmt_file()` + re-running preamble, load the checkpoint blob directly into these data structures.

What gets serialized (~the "TeX state"):
- `eqtb[]` -- equivalents table (~60K entries, ~480KB)
- `hash[]` -- control sequence hash table (~30K entries)
- `font_info[]` -- font metric data (variable, typically 100-500KB)
- `str_pool[]` + `str_start[]` -- string pool
- `mem[]` -- main memory (token/node lists, typically 1-5MB)
- A handful of global counters (cur_font, cur_group, if_stack depth, etc.)

Estimated diff: ~1000-2000 lines of C changes in xetex0.c and a new xetex_checkpoint.c file.

For pdfTeX: similar approach, slightly simpler because pdfTeX has no xdv/layout engine state to worry about. Same data structures (eqtb, hash, font_info, mem, str_pool).

**What to upstream vs keep local:**
- Bug fixes and portability improvements: upstream to tectonic
- Checkpoint/restore hooks: keep local (too eztex-specific, tectonic has different goals)
- kpseemu-to-ttbc_* shim for pdfTeX: keep local (tectonic deliberately doesn't support pdfTeX)

**Realistic fork maintenance cost:**
- XeTeX: low. Tectonic's XeTeX changes rarely. Our checkpoint hooks are additive (new files + a few insertion points). Merge conflicts will be infrequent.
- pdfTeX: very low. TeX Live's pdfTeX is essentially frozen. Our kpseemu shim is a separate file. The I/O call site changes are mechanical.


## 5. Migration Path

### Step 1: Extract library boundary

Move files into `src/lib/` and `src/cli/` structure. Create `src/lib/root.zig` as the public module. CLI's main.zig imports from `eztex` module instead of direct file imports.

**No behavior change.** All existing tests pass. This is pure file reorganization + import path updates.

Effort: **Quick** (1-2 days)

### Step 2: Parameterize Compiler with comptime Backend

Add `Backend` enum. Wrap current Compiler.zig logic into `Compiler(.xetex)`. The xetex path is identical to current code -- we're just putting it inside a comptime-generated struct.

Extract engine-specific pieces:
- `tt_engine_xetex_main` extern -> selected by backend
- `tt_engine_xdvipdfmx_main` -> only in xetex path
- `bibtex_main` -> shared (both engines use BibTeX)
- Format enum values -> backend-specific names
- Output pipeline (XDV->PDF vs direct PDF) -> backend-specific

**No new engine yet.** `Compiler(.pdftex)` exists as a type but `@compileError`s if you try to use it ("pdfTeX backend not yet available").

Effort: **Quick** (1-2 days)

### Step 3: Add pkg/pdftex/

Vendor pdfTeX C sources from TeX Live. Write kpseemu.c shim. Write pdftex_io.c wrapper. Write pkg/pdftex/build.zig.

Get it compiling and linking. The shim is the hard part -- mapping kpathsea's file format types to ttbc equivalents, handling the FILE*-to-handle translation.

Effort: **Medium** (1-2 weeks)

### Step 4: Implement pdfTeX compile path

Fill in `Compiler(.pdftex)`:
- `ensureFormat` with pdflatex.fmt / pdftex.fmt
- `runPass` calling `tt_engine_pdftex_main`
- `produceOutput` reading PDF directly (no XDV step)
- Format dumping for pdflatex.fmt

Effort: **Short** (3-5 days)

### Step 5: Test and ship

- Native CLI: `eztex --engine=pdftex document.tex`
- WASM: build eztex-pdftex.wasm, test in browser
- Verify format caching works for pdfTeX formats
- Verify bundle store serves pdfTeX's TFM/VF files correctly

Effort: **Short** (3-5 days)

### Step 6: Preamble checkpoint/restore (Phase 2 fork)

- Add `ttbc_checkpoint_save` / `ttbc_checkpoint_restore` to bridge
- Modify XeTeX C source: hook after preamble processing
- Implement state serialization (eqtb, hash, font_info, mem, str_pool)
- Wire into Compiler: detect cached checkpoint, restore instead of re-running preamble
- Test with representative LaTeX documents (complex preambles with many packages)

Effort: **Large** (3-6 weeks)

### Total timeline

| Step | Effort | Cumulative |
|---|---|---|
| 1. Library boundary | 1-2 days | 1-2 days |
| 2. Comptime Backend | 1-2 days | 2-4 days |
| 3. pkg/pdftex/ | 1-2 weeks | ~2 weeks |
| 4. pdfTeX compile path | 3-5 days | ~3 weeks |
| 5. Test and ship | 3-5 days | ~4 weeks |
| 6. Checkpoint/restore | 3-6 weeks | ~2-3 months |


## 6. Concrete Recommendation

**Build first: library boundary extraction (Step 1).**

This is zero-risk, zero-behavior-change refactoring that unblocks everything else. It makes the codebase testable as a library, makes the CLI/WASM consumers thinner, and establishes the module boundary that the multi-engine interface needs.

**Build order:**

1. **This week:** Steps 1-2. Library extraction + comptime Backend parameterization. Pure refactoring.
2. **Next 2-4 weeks:** Steps 3-5. pdfTeX integration. Native first, then WASM. This is the first user-visible feature (pdflatex support).
3. **Month 2-3:** Step 6. Preamble checkpoint/restore. This is the highest-value optimization (2-5x speedup) but requires C-level engine modifications.

**Defer indefinitely:**
- SwiftLaTeX's XeTeX -- tectonic's is strictly better for our use case
- Runtime engine selection -- comptime is simpler and produces smaller WASM binaries
- Full engine rewrite in Zig -- absurd effort for marginal gain, the C code works
- LuaTeX integration -- no demand signal, much larger engine, Lua runtime adds ~300KB+ to WASM

**Revisit if:**
- WASM binary count becomes a deployment problem (multiple .wasm files) -- then consider runtime selection
- Tectonic project dies or diverges in an incompatible direction -- then evaluate deeper fork or SwiftLaTeX XeTeX as fallback
- pdfTeX demand doesn't materialize -- then skip Steps 3-5 entirely and go straight to checkpoint/restore on XeTeX
