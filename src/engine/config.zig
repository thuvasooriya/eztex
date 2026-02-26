const std = @import("std");

pub const Format = enum {
    latex,
    plain,
};

pub const OutputFormat = enum {
    pdf,
    xdv,
};

pub const Variable = enum {
    halt_on_error,
    synctex,
    shell_escape,
    initex_mode,
    semantic_pagination,
};

pub const Value = union(enum) {
    boolean: bool,
    integer: c_int,
    string: []const u8,
};

pub const EngineResult = struct {
    code: c_int,

    pub fn succeeded(self: EngineResult) bool {
        return self.code == 0 or self.code == 1;
    }
};

pub const EngineConfig = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    world: *@import("../World.zig"),
    format: Format = .latex,
    build_date: u64 = 0,
    deterministic: bool = false,
    paperspec: []const u8 = "letter",
};
