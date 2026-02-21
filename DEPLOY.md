https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz

export ZIG_DIR="$HOME/.local/zig" && mkdir -p "$ZIG_DIR" && curl -fsSL "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz" | tar -xJ --strip-components=1 -C "$ZIG_DIR" && export PATH="$ZIG_DIR:$PATH" && zig build wasm && cd app && bun install && bun run build
