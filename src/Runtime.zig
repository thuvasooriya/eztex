// Runtime.zig -- centralized runtime state for the eztex compiler.
//
// Owns all long-lived state (io, world, bundle store, diagnostics) and
// provides a single global pointer for the C ABI bridge layer.
// C callbacks (ttbc_*) dereference `instance` to reach this state.
//
// Lifecycle:
//   1. main() calls Runtime.init() to create one.
//   2. rt.activate() sets the global `instance` pointer.
//   3. All engine operations run.
//   4. rt.deactivate() clears the pointer.
//   5. Runtime goes out of scope.

const std = @import("std");
const Io = std.Io;
const World = @import("World.zig");
const BundleStore = @import("BundleStore.zig");
const EngineApi = @import("EngineInterface.zig");

const Runtime = @This();

// the active runtime instance, dereferenced by C ABI bridge functions.
pub var instance: ?*Runtime = null;

pub const CheckpointCallback = struct {
    func: *const fn (userdata: ?*anyopaque, id: c_int) void,
    userdata: ?*anyopaque,
};

io: Io,
world: World,
bundle_store: BundleStore,
active_engine: ?EngineApi.Engine,
diag_handler: ?World.DiagnosticHandler,
checkpoint_handler: ?CheckpointCallback,

pub fn init(io: Io) Runtime {
    return .{
        .io = io,
        .world = .{},
        .bundle_store = BundleStore.init(
            std.heap.c_allocator,
            "https://eztex-cors-proxy.thuva.workers.dev/bundle",
            &@import("Config.zig").default_bundle_digest,
        ),
        .active_engine = null,
        .diag_handler = null,
        .checkpoint_handler = null,
    };
}

pub fn activate(self: *Runtime) void {
    instance = self;
}

pub fn deactivate(self: *Runtime) void {
    _ = self;
    instance = null;
}
