// lib.zig -- public API surface for the eztex library.
//
// All consumers (CLI, WASM, future engines) import through this file.
// Internal modules (MainDetect, FormatCache, etc.) are not re-exported
// unless needed by a consumer.

pub const Compiler = @import("Compiler.zig");
pub const Config = @import("Config.zig");
pub const Digest = @import("Digest.zig");
pub const Engine = @import("Engine.zig");
pub const engine = @import("EngineInterface.zig");
pub const EngineInterface = engine.Engine;
pub const EngineConfig = engine.EngineConfig;
pub const EngineResult = engine.EngineResult;
pub const EngineVariable = engine.Variable;
pub const EngineValue = engine.Value;
pub const EngineOutputFormat = engine.OutputFormat;
pub const Host = @import("Host.zig");
pub const Log = @import("Log.zig");
pub const Runtime = @import("Runtime.zig");
pub const BundleStore = @import("BundleStore.zig");
pub const Watcher = @import("Watcher.zig");
pub const seeds = @import("seeds.zig");

// re-export commonly used types for convenience
pub const Backend = Compiler.Backend;
pub const Format = Compiler.Format;
pub const CompileConfig = Compiler.CompileConfig;
pub const CompileMode = Compiler.CompileMode;
pub const engine_display_name = Compiler.engine_display_name;
