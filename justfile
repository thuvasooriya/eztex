help:
    just --list

# build native binary
build:
    zig build

# build wasm binary and copy to app/public/
build-wasm:
    zig build wasm

# run native compilation on a .tex file
run file:
    zig build run -- compile {{ file }}

# run test suite
test:
    zig build test
    zig build test-integration

app-dev: build-wasm
    cd app && bun dev

app-build: build-wasm
    cd app && bun run build

# regenerate favicons from logo.svg (run after changing app/public/logo.svg)
gen-icons:
    bun run app/scripts/gen_icons.ts

git-push desc:
    jj desc -m "{{ desc }}"
    jj bookmark move main --to @
    jj git push -b main

alias ad := app-dev
alias gp := git-push
