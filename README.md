# eztex

zig based wrapper for tex/xelatex engine built on [tectonic](https://tectonic-typesetting.github.io/)

packaged as a native cli and a [wasm-powered web app](<(https://eztex.pages.dev/)>) with a solid-js frontend

## quickstart

```sh
zig build run
```

## setup and development

refer to [justfile](justfile)

## license

eztex source code is [MIT](LICENSE)

third-party c libraries in `pkg/` (harfbuzz, freetype, icu, libpng, graphite2,
zlib) and the tectonic engine each carry their own licenses (MIT, FTL, icu
license, libpng license, LGPL-2.1, zlib license respectively). authoritative
license texts live in the upstream repositories referenced by each
`pkg/*/build.zig.zon`.
