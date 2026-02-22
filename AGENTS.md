# RULES

DO NOT assume anything. We might have bugs in zig or zig std functions as well. so we need to think from first principles and verify and debug fundamentally in those cases.

# Zig 0.15 API Reference

## Comptime for Performance

Use `comptime` aggressively for zero-cost abstractions:

### Comptime Lookup Tables

```zig
// Generate character class lookup at compile time
const char_class = comptime blk: {
    var table: [256]CharType = .{.invalid} ** 256;
    for ('a'..='z') |c| table[c] = .alpha;
    for ('A'..='Z') |c| table[c] = .alpha;
    for ('0'..='9') |c| table[c] = .digit;
    break :blk table;
};

// Usage - single array lookup instead of branching
fn classifyChar(c: u8) CharType {
    return char_class[c];
}
```

### Comptime Type Generation

```zig
fn Instruction(comptime fields: []const Field) type {
    return packed struct {
        // Generate fields at compile time
        // ...
    };
}
```

### Comptime vs Runtime Branching

```zig
// BAD - runtime check on every call
fn encode(comptime big_endian: bool, value: u32) [4]u8 {
    if (big_endian) { ... } else { ... }  // evaluated at compile time!
}

// Comptime parameter eliminates dead branch at compile time
// Both versions exist as separate functions
```

### Force Inlining for Hot Paths

```zig
inline fn decodeFast(bytes: []const u8) u32 {
    // Compiler MUST inline - no function call overhead
}
```

### Comptime String Operations

```zig
// BAD - runtime format
const msg = std.fmt.allocPrint(alloc, "error: {s}", .{name});

// GOOD - comptime format validation, but still runtime allocation
const msg = try std.fmt.allocPrint(alloc, "error: {s}", .{name});

// BEST - comptime when possible
const msg = comptime std.fmt.comptimePrint("error: {s}", .{"known"});
```

### Comptime State Machines

```zig
// Generate DFA transition table at compile time from regex
const dfa = comptime buildDFA("identifier|number|string");

fn lex(input: []const u8) Token {
    var state: u8 = 0;
    for (input) |c| {
        state = dfa.transition[state][c];  // single lookup
    }
    return dfa.accept[state];
}
```

## CRITICAL: ArrayList is Unmanaged

In Zig 0.15, `std.ArrayList(T)` no longer stores an allocator. You MUST pass the allocator to every method.

```zig
// OLD (pre-0.15) - WRONG:
var list = std.ArrayList(T).init(allocator);
try list.append(item);
const slice = list.toOwnedSlice();
list.deinit();

// NEW (0.15) - CORRECT:
const allocator = std.testing.allocator;
var list: std.ArrayList(T) = .empty;
defer list.deinit(allocator);
try list.append(allocator, item);
const slice = try list.toOwnedSlice(allocator);
```

## StringHashMap - Still Managed

`std.StringHashMap(V)` still uses `.init(allocator)` - it's managed.

```zig
var map = std.StringHashMap([]const u8).init(allocator);
defer map.deinit();
try map.put(key, value);
```

## I/O Changes

### stdout Pattern

```zig
const std = @import("std");
const fs = std.fs;

pub fn main() !void {
    const stdout_file = fs.File.stdout();
    var buf: [4096]u8 = undefined;
    var file_writer = stdout_file.writer(&buf);
    const w = &file_writer.interface;  // std.Io.Writer

    try w.print("Hello {s}\n", .{"world"});
    try w.writeAll("raw bytes");
    try w.writeByte('x');
    try w.flush();
}
```

### File.Writer Structure

```zig
pub const Writer = struct {
    file: File,
    err: ?WriteError = null,
    interface: std.Io.Writer,  // <-- use this for print/writeAll
    // ...
};
```

### std.Io.Writer Methods

| Method      | Signature                                              | Notes            |
| ----------- | ------------------------------------------------------ | ---------------- |
| `print`     | `fn(*Writer, comptime []const u8, anytype) Error!void` | Formatted output |
| `writeAll`  | `fn(*Writer, []const u8) Error!void`                   | Write all bytes  |
| `writeByte` | `fn(*Writer, u8) Error!void`                           | Single byte      |
| `write`     | `fn(*Writer, []const u8) Error!usize`                  | Partial write OK |
| `flush`     | `fn(*Writer) Error!void`                               | Drain buffer     |

### No writeByteNTimes - Use Loop

```zig
fn writeByteNTimes(w: *std.Io.Writer, byte: u8, n: usize) !void {
    for (0..n) |_| try w.writeByte(byte);
}
```

### File Reading

```zig
const file = try fs.openFileAbsolute(path, .{});
defer file.close();
const content = try file.readToEndAlloc(allocator, max_size);
defer allocator.free(content);
```

### File.Reader (buffered line reading)

```zig
const file = try fs.openFileAbsolute(path, .{});
defer file.close();

var read_buf: [64 * 1024]u8 = undefined;
var file_reader = fs.File.Reader.init(file, &read_buf);
const reader = &file_reader.interface;

while (true) {
    const line = reader.takeDelimiter('\n') catch |err| switch (err) {
        error.StreamTooLong => {
            _ = reader.discardDelimiterExclusive('\n') catch break;
            continue;
        },
        error.ReadFailed => break,
    } orelse break;
    // process line...
}
```

## Threading with ArenaAllocator

```zig
// Per-thread arena to avoid allocator contention
var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
const allocator = arena.allocator();
// allocator.free() is a no-op - arena frees all at once

// Atomic work stealing
var work_index = std.atomic.Value(usize).init(0);
const idx = work_index.fetchAdd(1, .monotonic);
```

## JSON Parsing

### Parse JSON string into typed struct (PREFERRED)

```zig
const MyParams = struct {
    name: []const u8,
    count: i32 = 0,
    optional_field: ?[]const u8 = null,
};

const parsed = try std.json.parseFromSlice(MyParams, allocator, json_string, .{});
defer parsed.deinit();
const params = parsed.value;
// Use params.name, params.count, params.optional_field
```

### Parse json.Value into typed struct

When you already have a `std.json.Value` (e.g., from JSON-RPC params):

```zig
const parsed = try std.json.parseFromValue(MyParams, allocator, json_value, .{});
defer parsed.deinit();
const params = parsed.value;
```

### Parse into dynamic Value (avoid if possible)

```zig
const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json_string, .{});
defer parsed.deinit();
const obj = parsed.value.object;
```

## JSON Stringify

Use `std.json.Stringify` for writing JSON:

```zig
var out: std.io.Writer.Allocating = .init(allocator);
defer out.deinit();
var jw: std.json.Stringify = .{ .writer = &out.writer };

try jw.beginObject();
try jw.objectField("name");
try jw.write("value");
try jw.objectField("count");
try jw.write(42);
try jw.objectField("nested");
try jw.beginObject();
try jw.objectField("inner");
try jw.write(true);
try jw.endObject();
try jw.endObject();

const result = try out.toOwnedSlice();  // {"name":"value","count":42,"nested":{"inner":true}}
```

For encoding strings with escapes:

```zig
try std.json.Stringify.encodeJsonString(my_string, .{}, &out.writer);
```

**WRONG**: `value.jsonStringify(array_list.writer())` - ArrayList.Writer is NOT a Stringify!

**RIGHT**: Create a `std.json.Stringify` and pass it to `jsonStringify`.

<!-- ZIG-TOOLS-END -->

## Naming and Structure Conventions

Zig 0.15+ encourages the "file-as-struct" pattern for better modularity and cleaner imports.

### Rule 1: File-as-Struct Pattern

Files that export a primary struct should be **Capitalized** to match the type name:

```zig
// Encoder.zig exports the Encoder struct
const Encoder = @This();

weights: Weights,
config: Config,

pub fn init(...) !Encoder { ... }
pub fn forward(...) !void { ... }

pub const Weights = struct { ... };
pub const LayerWeights = struct { ... };
```

**Naming Guidelines:**

- Struct files: `Encoder.zig`, `Decoder.zig`, `Config.zig`, `Tokenizer.zig`
- Module/utility files: `utils.zig`, `math.zig`, `kernels.zig`
- The struct name matches the filename (`Encoder` in `Encoder.zig`)

### Rule 2: No Redundant Prefixes

Inside a struct file, use **simple names** for nested types:

```zig
// WRONG: Encoder.zig with redundant prefixes
pub const EncoderWeights = struct { ... };
pub const EncoderLayerWeights = struct { ... };
pub const EncoderConfig = struct { ... };

// RIGHT: Clean names within module namespace
pub const Weights = struct { ... };
pub const LayerWeights = struct { ... };
pub const Config = struct { ... };
```

Cross-file references naturally namespace the type:

```zig
const Encoder = @import("Encoder.zig");
const Decoder = @import("Decoder.zig");

var encoder_weights: Encoder.Weights = ...;
var decoder_weights: Decoder.Weights = ...;  // no conflict!
```

**Exception:** Keep prefixes for types that would conflict with std lib or are truly ambiguous (e.g., `Error` vs `MyError`).

### Rule 3: Declaration Literals

Use `.enum` or `.{}` syntax when the type is inferred from context:

```zig
// ArrayList initialization (Zig 0.15)
var list = ArrayList(u8){};  // not ArrayList(u8).init()
var list2: ArrayList(u8) = .empty;  // equivalent

// Struct literals with inferred type
fn setColor(color: Color) void { ... }
setColor(.{ .r = 255, .g = 0, .b = 0 });  // type inferred from parameter

// Array literals
var array: [3]u8 = .{ 1, 2, 3 };

// Optional/Union initialization
var opt: ?i32 = null;  // not ?i32(null)
var result: Result = .{ .ok = value };
```

**When to use full type:**

```zig
// Type cannot be inferred
var list = ArrayList(u8){};  // need to specify T
const ptr = @ptrCast(*Foo, raw_ptr);  // need target type
```

### Rule 4: Import Patterns

Import structs with **Capitalized** names matching the file:

```zig
// WRONG: lowercase import for struct file
const encoder = @import("encoder.zig");
var e = try encoder.Encoder.init(...);  // redundant!

// RIGHT: Capitalized import matching struct name
const Encoder = @import("Encoder.zig");
var e = try Encoder.init(...);  // clean!
```

**Access nested types through the import:**

```zig
const Encoder = @import("Encoder.zig");
const Decoder = @import("Decoder.zig");

var enc_weights: Encoder.Weights = .{};
var dec_weights: Decoder.Weights = .{};
var layer: Encoder.LayerWeights = .{};
```

**Module imports remain lowercase:**

```zig
const utils = @import("utils.zig");
const math = @import("math.zig");

const result = utils.clamp(value, min, max);
const norm = math.l2_norm(vector);
```
