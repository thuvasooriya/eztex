# Incremental Compilation Research

Analysis of reference projects (TeXlyre, Octree, SwiftLaTeX) and architectural recommendations for eztex.

## 1. Reference Assessment

### TeXlyre

Web-based LaTeX/Typst editor. Not an engine innovator. Its value is as a deployment example: it embeds SwiftLaTeX's WASM-compiled XeTeX and pdfTeX in the browser. The editor itself (React/Yjs) does nothing novel with compilation -- it calls `compileLaTeX()` and gets a PDF back. Full recompile every time.

### Octree

AI-assisted LaTeX editor. Server-side compilation via standard TeX Live. Nothing to learn about engines or incremental compilation. Irrelevant to this analysis.

### SwiftLaTeX (upstream of TeXlyre)

The only technically interesting project of the three. Key observations:

- Compiles XeTeX and pdfTeX to WASM via Emscripten. The resulting engine runs identically to native but in a sandboxed memory space.
- **Persistent WASM instance**: The engine instance stays alive between compilations. This means the loaded format file (latex.fmt / xelatex.fmt) remains in memory. No format reload cost on subsequent compiles.
- **Emscripten MemFS**: Files are written into an in-memory virtual filesystem (`writeMemFSFile`). The FS persists across compilation calls. `flushCache()` exists to explicitly clear it.
- **No incremental compilation**: Despite instance persistence, each `compileLaTeX()` call runs the full engine from the start of the document. The only savings are: (a) format stays loaded, (b) files stay in MemFS.
- XeTeX variant is "almost 100% identical" minus full ICU dataset. This confirms XeTeX-to-WASM is viable and battle-tested.

**What eztex already does better**: `g_format_bytes` achieves the same format-persistence benefit as SwiftLaTeX's persistent WASM instance, but in a cleaner way -- the format bytes are kept in Zig-managed memory and served via `World.set_format_data()` without needing to keep an entire engine instance alive. eztex's approach is more memory-efficient and works for both native and WASM targets.

## 2. Why Incremental TeX Compilation is Hard

TeX is a Turing-complete macro expansion language with pervasive global mutable state:

- **Catcodes**: Any character's syntactic role can change at any point. `\makeatletter` changes `@` from "other" to "letter" mid-document.
- **Macro definitions**: `\renewcommand`, `\def`, `\let` can redefine anything anywhere. A macro defined on page 3 can affect rendering on page 1 via aux files on the next pass.
- **Counters and registers**: Page numbers, figure counters, equation numbers are global mutable state. Inserting a paragraph shifts everything downstream.
- **Aux file feedback loop**: Cross-references, bibliography, table of contents all work via write-then-read-on-next-pass. Adding a `\label` changes the aux file, which changes `\ref` output, which can change line breaks, which can change page numbers, which changes the aux file again.
- **No dependency graph**: Unlike Typst (which has a reactive IR with tracked dependencies), TeX processes input as a linear stream. There is no way to know what output depends on what input without running the engine.

The consequence: you cannot skip processing a section of a TeX document without risking incorrect output. There is no sound way to do partial recompilation at the document level.

## 3. What Incremental Actually Means Here

Given the fundamental constraints, "incremental compilation" for TeX falls into tiers:

### Tier 0: What eztex already does
- Format file caching (in-memory via `g_format_bytes`, on-disk via `FormatCache.zig`)
- Bundle file caching (via `BundleStore.zig` and `Cache.zig`)
- Multi-pass stability detection (aux file content comparison in `Compiler.zig`)
- File change detection with debounced recompilation (`Watcher.zig`)

### Tier 1: Preamble checkpoint/restore (highest impact, tractable)
Freeze engine state after `\begin{document}`. On recompile, restore from checkpoint instead of re-processing the preamble. The preamble typically loads 50-200 packages, defines hundreds of macros, and takes 30-70% of total compilation time. Restoring from a checkpoint skips all of this.

This is the **single biggest win available** without modifying the TeX engine itself.

### Tier 2: Selective pass elimination (medium impact, already partially done)
Skip bibtex/biber if .bib files haven't changed. Skip additional XeTeX passes if aux file is stable after pass 1. eztex's multi-pass loop with aux comparison already does some of this.

### Tier 3: Output caching / page-level diffing (low impact, high effort)
Cache intermediate XDV/DVI output and only re-run xdvipdfmx for changed pages. Requires understanding the XDV format at the page level. Marginal gains because xdvipdfmx is typically fast compared to XeTeX.

### Tier 4: Engine-level incremental (extreme effort, research-grade)
Modify XeTeX internals to track dependencies and skip unchanged macro expansions. This is essentially writing a new engine. Typst took this approach from scratch; retrofitting it onto TeX is not practical.

## 4. Preamble Checkpoint/Restore: The Key Opportunity

### How it works

1. First compilation runs normally. At the `\begin{document}` point, the engine's entire state is serialized: memory (main mem, string pool, font data, hash table), registers, catcodes, all defined macros and environments.
2. This checkpoint is stored in memory (and optionally on disk with content-addressing).
3. On subsequent compilations, instead of loading the format file and re-processing the preamble, restore the checkpoint directly. Then feed only the document body to the engine.
4. Invalidate the checkpoint when any preamble-affecting file changes (.cls, .sty, .def, or the preamble portion of the main .tex file).

### What eztex already has

- **Checkpoint callback infrastructure**: `Engine.zig` has a checkpoint system. The `format_loaded` checkpoint fires after format loading. This proves the C-Zig boundary can intercept engine state at defined points.
- **Memory-backed format serving**: `World.set_format_data()` and `g_format_bytes` demonstrate that engine state blobs can be held in Zig memory and served to the C engine on demand.
- **Content-addressed caching**: `FormatCache.zig` already implements keyed store/load for format files. The same pattern extends to preamble checkpoints.

### What's missing

- **No `\begin{document}` checkpoint**: The engine doesn't currently intercept at this point. A new checkpoint type is needed in the tectonic C code (specifically in `xetex/xetex-texmfmp.c` or equivalent) that fires when `\begin{document}` is processed.
- **Engine state serialization**: XeTeX's internal state (main memory, eqtb, font tables, string pool) must be serializable to a byte buffer. tectonic's XeTeX is a C codebase; these are mostly global arrays. Serialization is conceptually a `memcpy` of known global arrays, but the set of arrays must be identified and validated.
- **Preamble change detection**: Need to hash the preamble portion of the main .tex file (everything before `\begin{document}`) plus all files loaded during preamble processing. The engine already tracks which files are opened; this information needs to be surfaced to Zig.
- **Checkpoint restore pathway**: A new engine entry point that skips format loading and preamble processing, instead restoring from a state blob and starting execution from the document body.

### Effort estimate

This is a **Medium-to-Large** effort (2-4 weeks focused work). Most complexity is in the C engine modifications, not the Zig orchestration layer. The Zig side (caching, invalidation, orchestration) maps cleanly onto existing patterns.

### Risk

XeTeX's internal state may have pointers or file descriptors that don't survive serialization. The main mitigation is that format files (`latex.fmt`) are already serialized engine state -- the machinery for "dump and undump" exists in TeX. The preamble checkpoint extends this concept. The tectonic codebase already has the dump/undump pathways; they need to be made invocable at the `\begin{document}` point rather than only at format generation time.

## 5. Typst as a Reference Point

Typst achieves true incremental compilation through a fundamentally different design:

- **Content-addressed IR**: Every intermediate result is hashed. If inputs haven't changed, cached results are reused automatically.
- **Reactive dependency tracking**: The compiler knows exactly which outputs depend on which inputs. Changing a paragraph only recomputes affected pages.
- **No global mutable state**: The language is designed to be pure-functional at the document level. No catcode mutations, no `\def` side effects.
- **Incremental layout**: Page layout is incrementalized so that changing page 5 doesn't re-layout pages 1-4.

**What eztex can learn from Typst**: Not the implementation (wrong paradigm for TeX), but the principle that **the biggest wins come from avoiding redundant work at the coarsest granularity**. For TeX, the coarsest meaningful granularity is the preamble boundary. Everything finer-grained runs into TeX's global-state problem.

**What Typst cannot do that TeX can**: Full backward compatibility with 40 years of LaTeX packages. This is why eztex exists -- it serves users who need real LaTeX, not a TeX-like language.

## 6. How Zig Helps

### Direct C interop without FFI overhead
Zig can call C functions and access C global variables with zero overhead. This is critical for the checkpoint approach: Zig can directly read/write XeTeX's global arrays (main_memory, eqtb, str_pool, font_info, etc.) without marshalling. The `Engine.zig` C export layer already demonstrates this pattern.

### Comptime for checkpoint layout
The set of XeTeX global arrays to serialize can be described as a comptime struct. Zig can generate serialization/deserialization code at compile time with exact offsets and sizes, eliminating runtime reflection overhead.

```zig
const CheckpointLayout = comptime blk: {
    // Define all global arrays that constitute engine state
    // Generate serialize/deserialize functions at compile time
};
```

### Memory control
Zig's allocator model means checkpoint buffers can be managed precisely: arena-allocated for transient state, page-aligned for mmap-backed disk caching, or held in a long-lived buffer for watch mode. No GC pauses, no hidden allocations.

### WASM target
The same checkpoint code works on WASM via comptime host dispatch (already proven by `Host.zig`). In the browser, checkpoints live in WASM linear memory or can be persisted to OPFS. This gives eztex's web target the same preamble-caching benefit that SwiftLaTeX gets from its persistent WASM instance, but with explicit control and invalidation rather than hoping the instance stays alive.

## 7. Is XeTeX-via-Tectonic the Right Engine?

### Arguments for staying

- **Package compatibility**: XeTeX runs real LaTeX with full Unicode and system font support. The vast majority of LaTeX documents and packages work.
- **Tectonic's bundling**: The bundle system (with eztex's improvements in BundleStore.zig) eliminates TeX Live installation, which is the single biggest UX win for a TeX tool.
- **Proven WASM path**: SwiftLaTeX proves XeTeX-to-WASM works. eztex already compiles to WASM.
- **Existing investment**: eztex has a clean, well-structured integration with tectonic's C code. Engine.zig, World.zig, and Compiler.zig are solid.

### Arguments against

- **No LuaTeX**: LuaTeX is increasingly the default for modern LaTeX (it's the engine behind lualatex, which many newer packages target). Some packages require LuaTeX. eztex currently cannot compile these documents.
- **Engine modifications are hard**: Tectonic's XeTeX is a large C codebase. Adding checkpoint/restore requires understanding and modifying it. Bugs in engine modifications are subtle and dangerous.
- **XeTeX is in maintenance mode**: Upstream XeTeX receives minimal development. LuaTeX and Typst get active development.

### Recommendation

**Stay with XeTeX-via-tectonic for now. Consider adding LuaTeX as a second engine later.**

The switching cost is too high and the benefits too speculative to justify abandoning the current engine. The preamble checkpoint approach works with any TeX engine -- if eztex later adds LuaTeX, the same Zig-side orchestration applies.

Adding LuaTeX would mean either:
- (a) Integrating tectonic's LuaTeX support (if/when it exists)
- (b) Compiling LuaTeX independently with the same World.zig I/O abstraction

Option (b) is cleaner but more work. Neither is urgent. XeTeX covers 95%+ of real-world LaTeX documents.

## 8. Prioritized Recommendations

### Priority 1: Preamble checkpoint/restore [Large effort, highest impact]

**Expected speedup**: 2-5x for watch-mode recompiles on package-heavy documents. Preamble processing is typically the dominant cost.

Steps:
1. Identify all XeTeX global state arrays in tectonic's C code that constitute engine state post-preamble
2. Add a C-side hook at `\begin{document}` processing that calls back to Zig (extend the existing checkpoint system in Engine.zig)
3. Implement state serialization: dump all identified arrays to a contiguous buffer
4. Implement state restoration: a new engine entry point that loads from checkpoint buffer instead of format + preamble
5. Add preamble change detection: hash the preamble text + all files opened during preamble processing
6. Integrate with Compiler.zig's compilation loop: on first compile, generate checkpoint; on subsequent compiles, restore if preamble unchanged
7. Content-address the checkpoint using FormatCache.zig's existing pattern

This is the single highest-value investment for eztex's compilation speed.

### Priority 2: Smarter pass elimination [Small effort, medium impact]

eztex's multi-pass loop already compares aux file content. Extend this:
1. Skip bibtex entirely if no .bib file has changed AND the .aux file's citation commands haven't changed
2. After a stable compilation (aux unchanged between passes), cache the "stable" aux file. On next watch-mode trigger, if the aux file from pass 1 matches the cached stable version, skip pass 2 entirely
3. Track which files each pass actually reads (World.zig already opens them). If none of those files changed, consider skipping the pass

### Priority 3: Parallel xdvipdfmx [Small effort, small impact]

Currently XeTeX produces XDV, then xdvipdfmx converts to PDF sequentially. If the XDV output is piped rather than file-based, there may be opportunity to start PDF conversion before XeTeX finishes. In practice the impact is small because xdvipdfmx is fast, but it's a clean optimization if the plumbing allows it.

### Priority 4: File-level caching for includes [Medium effort, medium impact]

For documents using `\include{}` (which triggers `\clearpage`), track which included files changed. While the engine still processes everything (because of TeX's global state), the *output* for unchanged sections is deterministic if no cross-references changed. This enables:
1. Detecting that a recompile produced identical output (fast PDF comparison via hash)
2. Signaling to a viewer that only specific pages changed (useful for the WASM/web target)

### Priority 5: Consider LuaTeX as second engine [Large effort, expands compatibility]

Not urgent. Revisit when:
- Users report documents that require LuaTeX
- tectonic adds LuaTeX support upstream
- A clear path to WASM compilation of LuaTeX emerges

The existing architecture (Host.zig comptime dispatch, World.zig I/O abstraction, Engine.zig C exports) is well-structured to support a second engine. The main work would be in Compiler.zig's orchestration and a new set of C exports for LuaTeX's API.

## 9. What NOT to Do

- **Don't try to build a dependency graph for TeX documents**. TeX's Turing-completeness makes this unsound. You will spend months and still get wrong results for edge cases.
- **Don't try to implement page-level incremental compilation**. TeX's page builder has complex interactions with floats, footnotes, and penalties. Partial re-layout is a research problem, not an engineering task.
- **Don't switch engines for incremental benefits**. LuaTeX's Lua hooks don't help with incremental compilation. pdfTeX is less capable than XeTeX. Typst isn't TeX.
- **Don't over-invest in the WASM target's compilation speed**. Browser users expect slower compilation. The native target is where speed matters most, and it's where checkpoint/restore has the biggest impact.
- **Don't try to persist the full engine process between compilations** (like SwiftLaTeX's persistent WASM instance). eztex's approach of caching specific state blobs (format bytes, future preamble checkpoints) is more controlled, more debuggable, and works across both native and WASM targets.

## 10. Summary

The referenced projects (TeXlyre, Octree) are editors, not engine innovators. SwiftLaTeX's persistent-instance approach achieves format reuse accidentally (the WASM instance stays alive); eztex already achieves this deliberately and better via `g_format_bytes`.

The single highest-value next step is **preamble checkpoint/restore**: freeze engine state at `\begin{document}`, restore on recompile when the preamble hasn't changed. eztex's architecture is already partially set up for this (checkpoint callbacks, memory-backed format serving, content-addressed caching). The remaining work is mostly in tectonic's C engine code.

Everything else is incremental improvement on an already solid architecture. eztex's codebase is clean, well-structured, and makes good use of Zig's strengths. The XeTeX-via-tectonic foundation is correct for the foreseeable future.
