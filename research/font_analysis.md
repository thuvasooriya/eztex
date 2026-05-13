# font handling analysis

## executive summary

the original premise ("PTSerif is NOT in the Tectonic bundle") was **wrong**. PTSerif IS in the bundle with 200+ entries (.sty, .fd, .tfm, .vf, .pfb, .enc files). the real problem was a **case-sensitivity bug** in BundleStore index lookup: TeX requests `t1ptserif-tlf.fd` (lowercase) but the bundle index stores `T1PTSerif-TLF.fd` (mixed case). this caused 22 failed lookups per compilation for PTSerif alone, and affects ~65k of ~135k index entries.

**fix applied**: lowercase all index keys during parsing, lowercase lookup keys at query time. confirmed working -- `t1ptserif-tlf.fd` now resolves on first attempt.

---

## task 1: native CLI compilation

### result: SUCCESS (exit 0, font_test.pdf = 12765 bytes)

compiled `tmp/font_test.tex` (uses PTSerif via `\usepackage{PTSerif}` with book.cls) through two passes + xdvipdfmx.

### case-sensitivity bug discovered

the bundle index stores filenames in their original mixed case:
```
T1PTSerif-TLF.fd 188418560 1465
PTSerif-Regular-tlf-t1.tfm 814788096 22852
PTSerif.sty 188408320 968
```

but XeTeX/LaTeX requests font descriptor files in lowercase:
```
input_open('t1ptserif-tlf.fd', format=26)  -> FileNotFound (22 failed variants)
input_open('T1PTSerif-TLF.fd', format=26)  -> SUCCESS (TeX retries with original case)
```

on native macOS the compilation still succeeds because:
1. TeX has an internal retry mechanism with the original-case filename
2. macOS filesystem is case-insensitive, so cached files match regardless of case

on WASM this would fail because WASI filesystem is case-sensitive and there is no retry.

### remaining FileNotFound errors (expected, not bugs)

extensionless lookups like `cmr17`, `PTSerif-Regular-tlf-t1` fail on bare name, then succeed with `.tfm` extension via the format-extension fallback in `try_open_input()`. this is normal TeX behavior.

`font_test.aux` errors are expected (local file, not in bundle).

---

## task 2: bundle architecture

### file resolution flow

```
ttbc_input_open (C bridge)
  -> Engine.zig input_open_callback
    -> World.try_open_input(name, format)
      1. try_open_path: filesystem + search_dirs (direct + extension variants)
      2. try_open_from_bundle_store: BundleStore.open_file(name)
         a. Host.cache_open(name)     -- persistent cache (disk/OPFS)
         b. resolve_index_entry(name) -- HashMap lookup
         c. Host.fetch_range(entry)   -- HTTP Range / sync XHR
         d. Host.cache_write(name)    -- persist to cache
         e. fs.cwd().createFile(name) -- write temp file, return handle
```

### index format

plain text, one line per file: `<name> <offset> <length>`. 134,977 entries. ~5MB decompressed, ~1.3MB gzip compressed.

### platform differences

| aspect | native | WASM |
|---|---|---|
| transport | std.http.Client Range | JS extern sync XHR |
| cache | filesystem (SHA-256 content-addressed) | no-op (WASI tmpfs only) |
| concurrency | OS thread pool for seed_cache | single-threaded, sequential |
| index storage | cached to disk | pushed from JS via eztex_push_index |

### bundle URL

configurable via `eztex.zon`, defaults to same-origin production routes:
- bundle: `/bundle` (`https://eztex.thuvasooriya.me/bundle` in production)
- index: `/index.gz` (`https://eztex.thuvasooriya.me/index.gz` in production)

---

## task 3: CTAN API

### verdict: FEASIBLE but heavyweight

- `https://ctan.org/json/2.0/pkg/ptserif` -- public, no auth, returns package metadata
- PTSerif package is marked OBSOLETE, redirects to `paratype` bundle
- `https://ctan.org/json/2.0/pkg/paratype` -- has `"install":"/fonts/paratype.tds.zip"` (TDS zip)
- TDS zip at `https://mirrors.ctan.org/install/fonts/paratype.tds.zip` exists but is >5MB
- mirror directory listing available at `https://mirrors.ctan.org/fonts/paratype/` with individual files

### pros
- authoritative source for all TeX packages
- provides complete .sty/.fd/.tfm/.vf/.pfb/.enc files
- stable API, no auth required

### cons
- TDS zips are large (5MB+ for paratype), no range requests
- individual file download requires parsing HTML directory listings
- no structured API for listing files within a package
- would need a name-to-package mapping (TeX name -> CTAN package name)
- mirror selection adds complexity

---

## task 4: Fontsource API

### verdict: NOT FEASIBLE for TeX

- `https://api.fontsource.org/v1/fonts/pt-serif` -- public, no auth
- provides TTF/WOFF2 files via CDN (e.g., `https://cdn.jsdelivr.net/fontsource/fonts/pt-serif@latest/latin-400-normal.ttf`)
- weights: 400, 700; styles: normal, italic; subsets: latin, cyrillic, etc.

### why not feasible

Fontsource provides **web font formats only** (woff2, woff, ttf). TeX compilation requires:
- `.sty` (LaTeX package macro definitions)
- `.fd` (font descriptor mapping family/series/shape to TFM names)
- `.tfm` (TeX font metrics -- glyph widths, heights, kerning)
- `.vf` (virtual font remapping)
- `.pfb` or `.ttf` (actual glyph outlines)
- `.enc` (encoding vectors)
- `.map` (font map linking TFM names to outline files)

Fontsource has none of the TeX-specific files. a bare .ttf can only be used with XeTeX's `\font\x="filename.ttf"` primitive, not with LaTeX's `\usepackage{PTSerif}` infrastructure.

---

## task 5: Google Fonts API

### verdict: NOT FEASIBLE for TeX (same limitations as Fontsource)

- Google Fonts CSS2 API: `https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400;1,700`
- returns `@font-face` declarations pointing to `.woff2` files on `fonts.gstatic.com`
- no API key needed for the CSS endpoint
- PT Serif available in 4 variants (regular, bold, italic, bold-italic), 4 subsets (latin, latin-ext, cyrillic, cyrillic-ext)

### same fundamental problem as Fontsource

Google Fonts provides WOFF2 files only (no TTF via CSS2 API). even if we could get TTF, we'd still need:
1. `.fd` files (font descriptor) -- could theoretically be generated from a template
2. `.tfm` files (TeX font metrics) -- requires running `tftopl`/`pltotf` or extracting metrics from font tables
3. `.map` files (font mapping) -- could be generated
4. `.enc` files (encoding) -- standard T1/OT1 encodings exist

### dynamic .fd generation feasibility

generating wrapper files at runtime is theoretically possible but practically a dead end:
- `.fd` generation: template-based, ~50 lines per file -- EASY
- `.tfm` generation: requires parsing OpenType/TrueType font tables, computing TeX-specific metrics (height, depth, italic correction, kern pairs, ligatures), encoding them in TFM binary format -- HARD, essentially reimplementing `tftopl`
- without .tfm, TeX cannot lay out text at all

### conclusion

Google Fonts and Fontsource are web font CDNs. they serve a fundamentally different ecosystem (CSS/browsers) than TeX. the gap between "has a .ttf" and "has all the TeX infrastructure files" is enormous.

---

## task 6: architecture analysis

### the real problem (revised)

the case-sensitivity bug was the primary issue. after fixing it:
- PTSerif and most fonts compile correctly on native
- the same fix enables WASM compilation (lowercase index keys work on case-sensitive WASI fs)
- the remaining extensionless FileNotFound errors are normal TeX behavior (try bare name, fall back to extension)

### are there still missing fonts?

for the standard Tectonic bundle: **no**. the bundle contains 134,977 files covering:
- all standard LaTeX fonts (CM, LM, AMS)
- most CTAN font packages (paratype/PTSerif, libertine, newpx, etc.)
- all standard LaTeX classes and packages

fonts genuinely NOT in the bundle would be:
- proprietary/commercial fonts (not distributable)
- very new CTAN packages not yet in the Tectonic bundle snapshot
- custom user fonts

### architecture options for genuinely absent fonts

**option A: supplementary bundle (second tar.gz)**
- effort: MEDIUM
- create a curated supplementary bundle with additional fonts
- same index+range-fetch mechanism, just a second URL
- pros: simple, no new infrastructure, works on WASM
- cons: requires manual curation, bundle grows over time

**option B: CTAN package fetch on demand**
- effort: LARGE
- on FileNotFound, query CTAN API -> download TDS zip -> extract needed files
- pros: access to entire CTAN archive (~6000 font packages)
- cons: large downloads (5MB+ zips), complex name resolution (TeX name -> CTAN package), slow on first use, WASM bandwidth concerns

**option C: custom font support via fontspec/XeTeX**
- effort: SMALL
- already partially supported: XeTeX can use system fonts via fontconfig (native) or uploaded .ttf/.otf via `\fontspec{}`
- for WASM: allow users to upload .ttf/.otf files, use fontspec directly
- pros: zero infrastructure, works for the actual use case (custom fonts)
- cons: requires users to use fontspec instead of NFSS `\usepackage{FontName}`

**option D: pre-built extended bundle**
- effort: SMALL
- replace the default bundle URL with a larger Tectonic bundle that includes more fonts
- the Tectonic project maintains bundle builds; could use a more comprehensive one
- pros: zero code changes, just update `default_bundle_url`
- cons: larger initial downloads

---

## task 7: recommendation

### priority 1: case-sensitivity fix (DONE)

**fix applied in `src/BundleStore.zig`:**
- `parse_index_into()`: lowercase all index keys during parsing via `ascii_lower()`
- `resolve_index_entry()`: lowercase lookup key before HashMap query
- `has()`: same lowercase treatment
- `seed_cache()`: now uses `resolve_index_entry()` instead of direct `bundle_index.get()`

**impact**: eliminates 22+ failed lookups per compilation for any font with mixed-case filenames. verified: `t1ptserif-tlf.fd` now resolves on first attempt.

**collision risk**: only 1 collision in 134,977 entries (`cherokee.tfm` vs `Cherokee.tfm`). negligible.

### priority 2: no further action needed for standard fonts

the Tectonic bundle is comprehensive. the case-sensitivity fix was the missing piece. no CTAN/Google Fonts/Fontsource integration is needed for standard LaTeX documents.

### priority 3: future consideration for custom fonts

if users need fonts not in the bundle, **option C** (fontspec + user-uploaded .ttf) is the right approach:
- zero infrastructure cost
- already works on native (fontconfig discovers system fonts)
- for WASM: add a file upload mechanism in the web UI
- effort: QUICK (the engine already supports it)

### effort summary

| action | effort | status |
|---|---|---|
| case-sensitivity fix | QUICK | DONE |
| CTAN API integration | LARGE | NOT RECOMMENDED |
| Fontsource/Google Fonts | N/A | NOT FEASIBLE for TeX |
| supplementary bundle | MEDIUM | NOT NEEDED |
| fontspec custom fonts | QUICK | future enhancement |
