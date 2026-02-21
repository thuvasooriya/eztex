# eztex

Zig-based TeX/XeLaTeX engine (built on [Tectonic](https://tectonic-typesetting.github.io/))
packaged as a native CLI and a WASM-powered web app with a SolidJS frontend.

## Build and Run

```sh
zig build          # native CLI binary
zig build wasm     # WASM binary for the web app
cd app && bun install
cd app && bun run dev    # local dev server
cd app && bun run build  # production build
```

## Bundle Configuration

eztex downloads TeX resource bundles at runtime. Defaults are compiled in;
override per-project via `eztex.zon`:

```zon
.{ .bundle = .{ .url = "https://...", .index = "https://..." } }
```

See `src/Config.zig` for all options and defaults.

## Deployment

Cloudflare Pages deploy guide: [tmp/docs/CLOUDFLARE_PAGES_DEPLOY.md](tmp/docs/CLOUDFLARE_PAGES_DEPLOY.md)

## License

eztex source code is [MIT](LICENSE).

Third-party C libraries in `pkg/` (harfbuzz, freetype, ICU, libpng, graphite2,
zlib) and the Tectonic engine each carry their own licenses (MIT, FTL, ICU
License, libpng License, LGPL-2.1, zlib License respectively). Authoritative
license texts live in the upstream repositories referenced by each
`pkg/*/build.zig.zon`.
