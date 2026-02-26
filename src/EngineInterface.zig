const config = @import("engine/config.zig");

pub const EngineConfig = config.EngineConfig;
pub const EngineResult = config.EngineResult;
pub const Format = config.Format;
pub const OutputFormat = config.OutputFormat;
pub const Value = config.Value;
pub const Variable = config.Variable;

pub const Engine = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        destroy: *const fn (ctx: *anyopaque) void,
        setVariable: *const fn (ctx: *anyopaque, variable: Variable, value: Value) anyerror!void,
        setPrimaryInput: *const fn (ctx: *anyopaque, path: []const u8) anyerror!void,
        setFormat: *const fn (ctx: *anyopaque, format: Format) anyerror!void,
        run: *const fn (ctx: *anyopaque) anyerror!EngineResult,
        outputFormat: *const fn (ctx: *anyopaque) OutputFormat,
        formatDumpName: *const fn (ctx: *anyopaque, format: Format) []const u8,
        formatFileName: *const fn (ctx: *anyopaque, format: Format) []const u8,

        generatedFormatPath: *const fn (ctx: *anyopaque, format: Format) []const u8,
        initexInput: *const fn (ctx: *anyopaque, format: Format) []const u8,
        initexBasename: *const fn (ctx: *anyopaque, format: Format) []const u8,
        initexOutputFile: *const fn (ctx: *anyopaque, format: Format) []const u8,
        initexLogFile: *const fn (ctx: *anyopaque, format: Format) []const u8,
        initexContent: *const fn (ctx: *anyopaque, format: Format) []const u8,
        prepareInitex: *const fn (ctx: *anyopaque, output_dir: []const u8) anyerror!void,
        finishInitex: *const fn (ctx: *anyopaque) anyerror!void,
        // Orchestration callbacks kept here until workflow control moves out of Engine.
        postProcess: *const fn (ctx: *anyopaque, input_path: []const u8, output_path: []const u8) anyerror!EngineResult,
        runBibtex: *const fn (ctx: *anyopaque, aux_path: []const u8) anyerror!EngineResult,
        errorMessage: *const fn (ctx: *anyopaque) []const u8,
        name: *const fn (ctx: *anyopaque) []const u8,
    };

    pub fn destroy(self: Engine) void {
        self.vtable.destroy(self.ptr);
    }

    pub fn setVariable(self: Engine, variable: Variable, value: Value) !void {
        try self.vtable.setVariable(self.ptr, variable, value);
    }

    pub fn setPrimaryInput(self: Engine, path: []const u8) !void {
        try self.vtable.setPrimaryInput(self.ptr, path);
    }

    pub fn setFormat(self: Engine, format: Format) !void {
        try self.vtable.setFormat(self.ptr, format);
    }

    pub fn run(self: Engine) !EngineResult {
        return self.vtable.run(self.ptr);
    }

    pub fn outputFormat(self: Engine) OutputFormat {
        return self.vtable.outputFormat(self.ptr);
    }

    pub fn formatDumpName(self: Engine, format: Format) []const u8 {
        return self.vtable.formatDumpName(self.ptr, format);
    }

    pub fn formatFileName(self: Engine, format: Format) []const u8 {
        return self.vtable.formatFileName(self.ptr, format);
    }

    pub fn generatedFormatPath(self: Engine, format: Format) []const u8 {
        return self.vtable.generatedFormatPath(self.ptr, format);
    }

    pub fn initexInput(self: Engine, format: Format) []const u8 {
        return self.vtable.initexInput(self.ptr, format);
    }

    pub fn initexBasename(self: Engine, format: Format) []const u8 {
        return self.vtable.initexBasename(self.ptr, format);
    }

    pub fn initexOutputFile(self: Engine, format: Format) []const u8 {
        return self.vtable.initexOutputFile(self.ptr, format);
    }

    pub fn initexLogFile(self: Engine, format: Format) []const u8 {
        return self.vtable.initexLogFile(self.ptr, format);
    }

    pub fn initexContent(self: Engine, format: Format) []const u8 {
        return self.vtable.initexContent(self.ptr, format);
    }

    pub fn prepareInitex(self: Engine, output_dir: []const u8) !void {
        try self.vtable.prepareInitex(self.ptr, output_dir);
    }

    pub fn finishInitex(self: Engine) !void {
        try self.vtable.finishInitex(self.ptr);
    }

    pub fn postProcess(self: Engine, input_path: []const u8, output_path: []const u8) !EngineResult {
        return self.vtable.postProcess(self.ptr, input_path, output_path);
    }

    pub fn runBibtex(self: Engine, aux_path: []const u8) !EngineResult {
        return self.vtable.runBibtex(self.ptr, aux_path);
    }

    pub fn errorMessage(self: Engine) []const u8 {
        return self.vtable.errorMessage(self.ptr);
    }

    pub fn name(self: Engine) []const u8 {
        return self.vtable.name(self.ptr);
    }
};

pub const tectonic = @import("engine/tectonic.zig");
