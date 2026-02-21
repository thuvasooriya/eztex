# eztex

Zig based wrapper for TeX/XeLaTeX engine (built on [Tectonic](https://tectonic-typesetting.github.io/))
packaged as a native CLI and a WASM-powered web app with a SolidJS frontend.

## Build and Run

```sh
zig build run
```

## Bundle Configuration

eztex downloads tex resource bundles at runtime. defaults are compiled in;
override per-project via `eztex.zon`:

```zon
.{ .bundle = .{ .url = "https://...", .index = "https://..." } }
```

See `src/Config.zig` for all options and defaults.

## license

eztex source code is [MIT](LICENSE).

third-party c libraries in `pkg/` (harfbuzz, freetype, icu, libpng, graphite2,
zlib) and the tectonic engine each carry their own licenses (mit, ftl, icu
license, libpng license, lgpl-2.1, zlib license respectively). authoritative
license texts live in the upstream repositories referenced by each
`pkg/*/build.zig.zon`.
