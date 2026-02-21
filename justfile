# eztex project commands
help:
    just --list

# build native binary
build:
    zig build

# build WASM binary and copy to app/public/
build-wasm:
    zig build wasm

# run native compilation on a .tex file
run file:
    zig build run -- compile {{ file }}

# run test suite
test:
    bash tests/run_tests.sh

# clean build artifacts
clean:
    rm -rf zig-out .zig-cache

app-dev: build-wasm
    cd app && bun dev

app-build: build-wasm
    cd app && bun run build

alias ad := app-dev
