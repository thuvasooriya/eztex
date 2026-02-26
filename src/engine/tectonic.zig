const std = @import("std");
const Io = std.Io;
const EngineApi = @import("../EngineInterface.zig");
const Log = @import("../Log.zig");
const World = @import("../World.zig");

const Engine = EngineApi.Engine;
const EngineConfig = EngineApi.EngineConfig;
const EngineResult = EngineApi.EngineResult;
const Format = EngineApi.Format;
const OutputFormat = EngineApi.OutputFormat;
const Value = EngineApi.Value;
const Variable = EngineApi.Variable;

extern fn tt_engine_xetex_main(
    dump_name: [*:0]const u8,
    input_file_name: [*:0]const u8,
    build_date: u64,
) c_int;

extern fn tt_xetex_set_int_variable(
    var_name: [*:0]const u8,
    value: c_int,
) c_int;

const XdvipdfmxConfig = extern struct {
    paperspec: [*:0]const u8,
    enable_compression: u8,
    deterministic_tags: u8,
    build_date: u64,
};

extern fn tt_engine_xdvipdfmx_main(
    cfg: *const XdvipdfmxConfig,
    dviname: [*:0]const u8,
    pdfname: [*:0]const u8,
) c_int;

extern fn bibtex_main(aux_file_name: [*:0]const u8) c_int;
extern fn _ttbc_get_error_message() [*:0]const u8;

const TectonicEngine = struct {
    allocator: std.mem.Allocator,
    io: Io,
    world: *World,
    format: Format,
    build_date: u64,
    deterministic: bool,
    paperspec: []const u8,
    primary_input: [512]u8 = @splat(0),
    primary_input_len: usize = 0,
};

pub fn create(config: *const EngineConfig) !Engine {
    const ctx = try config.allocator.create(TectonicEngine);
    ctx.* = .{
        .allocator = config.allocator,
        .io = config.io,
        .world = config.world,
        .format = config.format,
        .build_date = config.build_date,
        .deterministic = config.deterministic,
        .paperspec = config.paperspec,
    };
    return .{ .ptr = ctx, .vtable = &vtable };
}

fn destroy(ctx: *anyopaque) void {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    self.allocator.destroy(self);
}

fn setVariable(ctx: *anyopaque, variable: Variable, value: Value) !void {
    // XeTeX variables are process-global C state, so ctx is intentionally unused.
    _ = ctx;
    switch (value) {
        .boolean => |v| try setIntVariable(variable, if (v) 1 else 0),
        .integer => |v| try setIntVariable(variable, v),
        .string => return error.UnsupportedVariableValue,
    }
}

fn setPrimaryInput(ctx: *anyopaque, path: []const u8) !void {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    if (path.len >= self.primary_input.len) return error.PathTooLong;
    @memcpy(self.primary_input[0..path.len], path);
    self.primary_input[path.len] = 0;
    self.primary_input_len = path.len;
    self.world.set_primary_input(path);
}

fn setFormat(ctx: *anyopaque, format: Format) !void {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    self.format = format;
}

fn run(ctx: *anyopaque) !EngineResult {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    if (self.primary_input_len == 0) return error.PrimaryInputNotSet;
    const input_z: [*:0]const u8 = self.primary_input[0..self.primary_input_len :0];
    return .{ .code = tt_engine_xetex_main(formatDumpNameZ(self.format), input_z, self.build_date) };
}

fn outputFormat(_: *anyopaque) OutputFormat {
    return .xdv;
}

fn formatDumpName(_: *anyopaque, format: Format) []const u8 {
    return std.mem.span(formatDumpNameZ(format));
}

fn formatFileName(_: *anyopaque, format: Format) []const u8 {
    return std.mem.span(formatFileNameZ(format));
}

fn generatedFormatPath(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "tmp/xelatex.fmt",
        .plain => "tmp/plain-xetex.fmt",
    };
}

fn initexInput(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "tmp/_make_xelatex_fmt.tex",
        .plain => "tmp/_make_plain_fmt.tex",
    };
}

fn initexBasename(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "_make_xelatex_fmt.tex",
        .plain => "_make_plain_fmt.tex",
    };
}

fn initexOutputFile(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "tmp/_make_xelatex_fmt.fmt",
        .plain => "tmp/_make_plain_fmt.fmt",
    };
}

fn initexLogFile(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "tmp/_make_xelatex_fmt.log",
        .plain => "tmp/_make_plain_fmt.log",
    };
}

fn initexContent(_: *anyopaque, format: Format) []const u8 {
    return switch (format) {
        .latex => "\\input tectonic-format-latex.tex\n",
        .plain => "\\input plain \\dump\n",
    };
}

fn prepareInitex(ctx: *anyopaque, output_dir: []const u8) !void {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    self.world.set_output_dir(output_dir);
    try setIntVariable(.initex_mode, 1);
    try setIntVariable(.halt_on_error, 1);
    try setIntVariable(.synctex, 0);
}

fn finishInitex(_: *anyopaque) !void {
    try setIntVariable(.initex_mode, 0);
}

fn postProcess(ctx: *anyopaque, input_path: []const u8, output_path: []const u8) !EngineResult {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    var input_buf: [512]u8 = undefined;
    var output_buf: [512]u8 = undefined;
    var paperspec_buf: [64]u8 = undefined;
    if (input_path.len >= input_buf.len or output_path.len >= output_buf.len) return error.PathTooLong;

    @memcpy(input_buf[0..input_path.len], input_path);
    input_buf[input_path.len] = 0;
    const input_z: [*:0]const u8 = input_buf[0..input_path.len :0];

    @memcpy(output_buf[0..output_path.len], output_path);
    output_buf[output_path.len] = 0;
    const output_z: [*:0]const u8 = output_buf[0..output_path.len :0];

    if (self.paperspec.len >= paperspec_buf.len) return error.PathTooLong;
    @memcpy(paperspec_buf[0..self.paperspec.len], self.paperspec);
    paperspec_buf[self.paperspec.len] = 0;
    const paperspec_z: [*:0]const u8 = paperspec_buf[0..self.paperspec.len :0];

    const cfg = XdvipdfmxConfig{
        .paperspec = paperspec_z,
        .enable_compression = 1,
        .deterministic_tags = if (self.deterministic) 1 else 0,
        .build_date = self.build_date,
    };

    Log.dbg(self.io, "eztex", "calling xdvipdfmx('{s}' -> '{s}')...", .{ input_path, output_path });
    const result = tt_engine_xdvipdfmx_main(&cfg, input_z, output_z);
    Log.dbg(self.io, "eztex", "xdvipdfmx returned: {d}", .{result});
    return .{ .code = result };
}

fn runBibtex(ctx: *anyopaque, aux_path: []const u8) !EngineResult {
    const self: *TectonicEngine = @ptrCast(@alignCast(ctx));
    var aux_buf: [512]u8 = undefined;
    if (aux_path.len >= aux_buf.len) return error.PathTooLong;
    @memcpy(aux_buf[0..aux_path.len], aux_path);
    aux_buf[aux_path.len] = 0;
    const aux_z: [*:0]const u8 = aux_buf[0..aux_path.len :0];

    Log.log(self.io, "eztex", .info, "running bibtex on '{s}'...", .{aux_path});
    self.world.reset_io(self.io);
    const result = bibtex_main(aux_z);
    Log.dbg(self.io, "eztex", "bibtex returned: {d}", .{result});
    return .{ .code = result };
}

fn errorMessage(_: *anyopaque) []const u8 {
    return std.mem.span(_ttbc_get_error_message());
}

fn name(_: *anyopaque) []const u8 {
    return "tectonic-zig";
}

fn setIntVariable(variable: Variable, value: c_int) !void {
    if (tt_xetex_set_int_variable(variableName(variable), value) != 0) return error.EngineVariableRejected;
}

fn variableName(variable: Variable) [*:0]const u8 {
    return switch (variable) {
        .halt_on_error => "halt_on_error_p",
        .initex_mode => "in_initex_mode",
        .synctex => "synctex_enabled",
        .semantic_pagination => "semantic_pagination_enabled",
        .shell_escape => "shell_escape_enabled",
    };
}

fn formatDumpNameZ(format: Format) [*:0]const u8 {
    return switch (format) {
        .latex => "xelatex",
        .plain => "plain",
    };
}

fn formatFileNameZ(format: Format) [*:0]const u8 {
    return switch (format) {
        .latex => "xelatex.fmt",
        .plain => "plain.fmt",
    };
}

const vtable = Engine.VTable{
    .destroy = destroy,
    .setVariable = setVariable,
    .setPrimaryInput = setPrimaryInput,
    .setFormat = setFormat,
    .run = run,
    .outputFormat = outputFormat,
    .formatDumpName = formatDumpName,
    .formatFileName = formatFileName,
    .generatedFormatPath = generatedFormatPath,
    .initexInput = initexInput,
    .initexBasename = initexBasename,
    .initexOutputFile = initexOutputFile,
    .initexLogFile = initexLogFile,
    .initexContent = initexContent,
    .prepareInitex = prepareInitex,
    .finishInitex = finishInitex,
    .postProcess = postProcess,
    .runBibtex = runBibtex,
    .errorMessage = errorMessage,
    .name = name,
};
