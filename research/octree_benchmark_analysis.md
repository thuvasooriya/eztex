# Octree Benchmark Claims: Critical Analysis

## 1. Summary of Claims

Octree's blog post ("Fastest LaTeX Compilation") claims dramatic speed advantages over TeXLive, Tectonic, and Overleaf across four document types:

| Document Type | Octree (initial) | TeXLive | Tectonic | Overleaf |
|---|---|---|---|---|
| Simple (1-page) | 1.2s | 3.8s | 2.1s | 5.2s |
| Medium (10-page) | 2.8s | 12.4s | 8.3s | 18.6s |
| Large (100-page thesis) | 8.5s | 45.2s | 28.7s | 62.3s |
| Complex (math-heavy) | 4.1s | 18.9s | 12.5s | 28.4s |

They further claim incremental compilation times:

| Document Type | Octree (incremental) | TeXLive | Tectonic | Overleaf |
|---|---|---|---|---|
| Large (100-page thesis) | 0.6s | 42.1s | 25.3s | 48.7s |

Attributed speed factors:
1. **Incremental compilation** -- only recompile changed portions
2. **Cloud parallelization** -- distribute work across cloud workers
3. **Smart caching** -- avoid redundant work
4. **Optimized pipeline** -- streamlined compilation steps

Headline claim: "47 minutes saved per day" for active LaTeX writers.

---

## 2. Verification: What the Public Code Reveals

### Architecture: Pure Proxy, No Engine

The `octree-labs/octree` GitHub repo (81 stars, TypeScript/Next.js) contains **zero compilation engine code**. The entire compilation path is:

1. **Frontend** (`hooks/use-editor-compilation.ts`): Collects all project files from Supabase storage, gzip-compresses them, sends JSON payload to an API endpoint.

2. **Next.js API route** (`app/api/compile-pdf/route.ts`): Authenticates user via Supabase session, checks an in-process cache (SHA-256 of all file contents), then proxies the request to `COMPILE_SERVICE_URL/compile`.

3. **Compiler proxy** (`app/api/compile-pdf/compiler.ts`): Simple `fetch()` call to the external compile service with a 180-second timeout. Reads response headers (`x-compile-duration-ms`, `x-compile-queue-ms`, `x-compile-sha256`). Returns the PDF binary.

4. **Cache layer** (`app/api/compile-pdf/cache.ts`): In-memory `Map` with 32 entries max, 60-second TTL. This is a trivial response cache on the Next.js server -- NOT incremental compilation or smart caching of TeX artifacts.

5. **Agent compilation** (`agent_server/lib/tools.ts`): The AI agent's compile tool also just POSTs to the same `COMPILE_SERVICE_URL/compile` endpoint.

**The actual compilation service is completely closed-source.** There is no public code showing any TeX engine, no incremental compilation logic, no parallelization system, no "optimized pipeline." The Dockerfile for the agent server is a plain Node.js Alpine container with zero TeX tooling installed.

### What the "Caching" Actually Is

The public cache (`cache.ts`) is a **response-level memoization**: if the exact same set of files is compiled again within 60 seconds, return the cached PDF. This is not:
- Format caching (pre-compiled .fmt files)
- Auxiliary file caching (.aux, .toc, .bbl)
- Incremental compilation (recompiling only changed pages)
- Object caching (compiled paragraphs/floats)

It is literally the most basic cache possible: hash all inputs, store the output, expire after 60s, max 32 entries.

### What "lastModifiedFile" Does

Both the frontend and agent send a `lastModifiedFile` field. This is passed through to the closed-source compile service. It **could** be used for incremental compilation on the server side, but there is no public evidence of how it is used. It could equally be used just for logging or as a hint for which file to use as the entry point.

---

## 3. Validity of Benchmark Methodology and Numbers

### Red Flags in the Claimed Numbers

**1. TeXLive numbers are implausibly slow.**
A simple 1-page LaTeX document compiling in 3.8s on TeXLive is unrealistically slow for any modern machine. With a pre-loaded format file, `pdflatex` compiles a trivial document in ~0.3-0.5s. Even with XeLaTeX (slower due to font loading), a 1-page document takes ~1-2s. The 3.8s figure suggests either:
- Cold-start compilation without a cached format file (unusual benchmark scenario)
- An extremely underpowered machine
- Deliberately pessimistic measurement

**2. 100-page thesis at 45.2s for TeXLive is inflated.**
A 100-page thesis with standard packages typically compiles in 10-20s on modern hardware with pdflatex. Even with XeLaTeX and complex bibliography processing (multiple passes), 45s is at the extreme upper bound. This looks like a worst-case multi-pass scenario being compared against Octree's single-pass or cached result.

**3. Incremental compilation comparison is meaningless.**
TeXLive "incremental" at 42.1s (vs initial 45.2s) reveals they are measuring full recompilation -- because TeXLive does not have incremental compilation. Comparing a full recompilation against a potentially cached or partial recompilation is not an apples-to-apples benchmark. The fair comparison would be TeXLive with format caching and auxiliary file reuse vs Octree's incremental mode.

**4. Overleaf numbers are network-dependent and irrelevant.**
Overleaf compilation times include network latency, server queue time, and shared infrastructure overhead. Comparing a dedicated cloud service against a shared multi-tenant platform is misleading. Overleaf's actual TeX compilation time (server-side) is comparable to TeXLive since it runs TeXLive.

**5. No methodology disclosure.**
The blog does not specify:
- Hardware used for benchmarks
- Whether format files were pre-cached
- Number of compilation passes measured
- Whether bibliography/index processing was included
- Network conditions for cloud-based services
- Whether the numbers include or exclude network round-trip time for Octree itself

**6. Tectonic numbers are suspicious.**
Tectonic's main overhead vs TeXLive is first-run bundle download. After caching, Tectonic compilation times are within ~10-20% of equivalent TeXLive engines. The claimed 28.7s vs 45.2s gap for the same document is implausible -- they use the same underlying TeX engine (XeTeX).

### The "47 Minutes Saved Per Day" Claim

This assumes ~100 compilations per day with an average saving of ~28 seconds each. For active writers this compilation count is plausible, but the per-compilation saving is based on the inflated baseline numbers above. A realistic saving (vs properly configured TeXLive with format caching) would be perhaps 2-5 seconds per compilation, yielding 3-8 minutes per day -- impressive if real, but not the marketed figure.

---

## 4. Genuinely Novel or Useful Techniques

### What Could Be Happening Server-Side (Speculation)

Since the compile service is closed-source, we can only speculate based on the interface:

1. **Pre-warmed TeX engines**: Keeping XeTeX/pdfTeX processes alive with format files already loaded, eliminating cold-start overhead. This is a well-known technique (used by Overleaf's CLSI, latexmk's daemon mode).

2. **Auxiliary file persistence**: Keeping .aux, .toc, .bbl files between compilations so that subsequent runs skip bibliography/index passes. Standard practice with `latexmk -pvc`.

3. **lastModifiedFile-based optimization**: If only one file changed, potentially skip unchanged auxiliary processing. Novel in a cloud context but the technique is conceptually similar to latexmk's dependency tracking.

4. **Container pooling**: Pre-built containers with all common TeX packages installed, avoiding package installation overhead. Standard cloud engineering.

### What Is NOT Novel

- Response-level caching (the only public code) is trivial
- Gzip compression of request bodies is standard HTTP optimization
- SHA-256 content hashing for cache keys is bog-standard
- Proxying to a compilation service is what every cloud LaTeX editor does (Overleaf, Papeeria, etc.)

### Potentially Interesting (If They Actually Implemented It)

- True incremental compilation at the TeX level (recompiling only changed pages) would be genuinely novel and technically difficult. TeX's architecture makes this extremely hard -- page breaks are global, cross-references create dependencies across the entire document. No public TeX system does this well.
- If they achieved sub-second "incremental" compilation of a 100-page document, the most likely explanation is **response caching** (which they demonstrably do) rather than true incremental compilation.

---

## 5. What eztex Already Does vs Could Adopt

### What eztex Already Has

| Capability | eztex | Octree (public) |
|---|---|---|
| Local TeX engine (XeTeX) | Yes -- compiled from C via Zig | No -- cloud proxy only |
| Format file caching | Yes -- `FormatCache.zig`, SHA-256 keyed by bundle digest + engine version + format type | No (not in public code) |
| Content-addressed file cache | Yes -- `Cache.zig`, SHA-256 content hashing, platform-aware cache dirs | Trivial 32-entry in-memory Map |
| Multi-pass compilation | Yes -- `Compiler.zig`, up to 5 automatic passes with convergence detection | Unknown (closed-source) |
| WASM compilation | Yes -- `wasm_exports.zig`, browser-native compilation | No -- requires network round-trip |
| File watching | Yes -- `Watcher.zig` | N/A (web editor) |
| Bundle store | Yes -- `BundleStore.zig`, ITAR bundle management | N/A |
| Offline capability | Yes -- fully local | No -- requires internet |

### What eztex Could Consider (But Probably Should Not)

1. **Response-level memoization**: Cache the final PDF keyed by input hash. For eztex this is less useful because compilation is local and fast -- the overhead of hashing all inputs might approach the compilation time for small documents.

2. **Incremental compilation hints**: Tracking which file changed (like `lastModifiedFile`) to potentially skip passes. eztex already handles multi-pass convergence detection, which is the correct solution. True incremental TeX compilation remains an unsolved research problem.

3. **Cloud compilation offloading**: Irrelevant for eztex's design philosophy (local-first, offline-capable, WASM-portable).

### Verdict on Adoptable Techniques

**Nothing in Octree's public codebase offers techniques that eztex should adopt.** The public code is a standard web app with a trivial cache layer proxying to a closed-source service. eztex's format caching, content-addressed file cache, and multi-pass convergence detection are all more sophisticated than anything visible in Octree's repo.

---

## 6. Overall Assessment

### Credible Engineering or Marketing?

**Primarily marketing with plausible but unverifiable engineering claims.**

**Evidence for marketing:**
- Benchmark numbers use inflated baselines (TeXLive and Overleaf times are 2-4x higher than realistic measurements)
- "47 minutes saved per day" is derived from these inflated baselines
- The "incremental compilation" comparison pits their (potentially cached) result against full recompilation in systems that don't support incrementality -- an unfair comparison by design
- No benchmark methodology disclosure
- No reproducible benchmark suite
- The blog reads like a conversion funnel piece, not a technical disclosure
- HN presence: 1 Show HN post with 1 point and 0 comments (Feb 2026), plus one earlier "Overleaf alternative" post with 3 points and 3 comments -- zero community validation of speed claims

**Evidence for some real engineering (server-side, unverifiable):**
- The `x-compile-duration-ms` and `x-compile-queue-ms` response headers suggest they instrument their compile service and have a queue-based architecture
- The `lastModifiedFile` parameter suggests *some* optimization logic exists server-side
- The `x-compile-sha256` header suggests server-side output deduplication
- A 180-second timeout suggests they handle real compilation workloads, not just cached responses

**Most likely reality:**
Octree runs a cloud compilation service that keeps TeX engines warm, caches format files and auxiliary outputs, and avoids cold-start overhead. This yields genuinely faster compilation than naive `pdflatex document.tex` invocations, but the improvement is well-understood infrastructure optimization (container pooling, format pre-loading, aux file persistence) -- not novel compilation technology. The benchmark numbers are cherry-picked to maximize the apparent advantage.

**Bottom line:** The closed-source compilation service probably does achieve faster-than-naive compilation through standard server-side optimizations. But the public benchmark claims are inflated, the methodology is undisclosed, and the public codebase contains zero novel compilation technology. For eztex, there is nothing to learn here that is not already implemented or irrelevant to a local-first architecture.
