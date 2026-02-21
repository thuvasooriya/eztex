// Flate.zig -- Zig implementation of tectonic_bridge_flate ABI.
//
// Replaces stubs/bridge_flate_stub.c. Compression delegates to zlib compress2
// (Zig 0.15 flate.Compress is incomplete). Decompression uses std.compress.flate
// with automatic container detection (gzip / zlib / raw).

const std = @import("std");
const builtin = @import("builtin");
const flate = std.compress.flate;
const Io = std.Io;

// FlateResult matching the C ABI enum in tectonic_bridge_flate.h
const FlateResult = enum(c_int) {
    success = 0,
    stream_end = 1,
    buf_error = -1,
    other_error = -2,
};

// zlib extern (resolved at link time via build.zig zlib_lib)
extern fn compress2(
    dest: [*]u8,
    dest_len: *c_ulong,
    source: [*]const u8,
    source_len: c_ulong,
    level: c_int,
) c_int;

const Z_OK: c_int = 0;
const Z_BUF_ERROR: c_int = -5;

// Detect gzip / zlib / raw container from the leading bytes.
fn sniff_container(data: []const u8) flate.Container {
    if (data.len < 2) return .raw;
    // gzip magic: 1f 8b
    if (data[0] == 0x1f and data[1] == 0x8b) return .gzip;
    // zlib header: CM=8 (lower nibble of CMF), (CMF*256 + FLG) % 31 == 0
    if (data[0] & 0x0f == 8) {
        const cmf_flg: u16 = @as(u16, data[0]) << 8 | @as(u16, data[1]);
        if (cmf_flg % 31 == 0) return .zlib;
    }
    return .raw;
}

// -- one-shot compress (zlib format via extern compress2) --

export fn tectonic_flate_compress(
    output_ptr: [*]u8,
    output_len: *u64,
    input_ptr: [*]const u8,
    input_len: u64,
    compression_level: u32,
) FlateResult {
    var dest_len: c_ulong = @intCast(output_len.*);
    const rc = compress2(
        output_ptr,
        &dest_len,
        input_ptr,
        @intCast(input_len),
        @intCast(compression_level),
    );
    output_len.* = dest_len;
    if (rc == Z_OK) return .success;
    if (rc == Z_BUF_ERROR) return .buf_error;
    return .other_error;
}

// -- one-shot decompress (Zig flate with container sniff) --

export fn tectonic_flate_decompress(
    output_ptr: [*]u8,
    output_len: *u64,
    input_ptr: [*]const u8,
    input_len: u64,
) FlateResult {
    const in_len: usize = @intCast(input_len);
    const out_cap: usize = @intCast(output_len.*);
    const input = input_ptr[0..in_len];
    const output = output_ptr[0..out_cap];

    const container = sniff_container(input);
    var reader: Io.Reader = .fixed(input);
    var window_buf: [flate.max_window_len]u8 = undefined;
    var decomp = flate.Decompress.init(&reader, container, &window_buf);

    var writer: Io.Writer = .fixed(output);
    _ = decomp.reader.streamRemaining(&writer) catch |err| {
        output_len.* = @intCast(writer.buffered().len);
        return switch (err) {
            error.WriteFailed => .buf_error,
            error.ReadFailed => .other_error,
        };
    };

    output_len.* = @intCast(writer.buffered().len);
    return .success;
}

// -- streaming decompressor --

const Decompressor = struct {
    input_reader: Io.Reader,
    window_buf: [flate.max_window_len]u8,
    decomp: flate.Decompress,
    done: bool,

    const heap = std.heap.c_allocator;

    fn create(input_ptr: [*]const u8, len: u64) ?*Decompressor {
        const n: usize = @intCast(len);
        const input = input_ptr[0..n];
        const container = sniff_container(input);

        const self = heap.create(Decompressor) catch return null;
        self.input_reader = Io.Reader.fixed(input);
        self.window_buf = undefined;
        self.done = false;
        self.decomp = flate.Decompress.init(&self.input_reader, container, &self.window_buf);
        return self;
    }

    fn destroy(self: *Decompressor) void {
        heap.destroy(self);
    }

    fn read_chunk(self: *Decompressor, output_ptr: [*]u8, output_len: *u64) c_int {
        if (self.done) {
            output_len.* = 0;
            return 0;
        }
        const cap: usize = @intCast(output_len.*);
        const buf = output_ptr[0..cap];
        const n = self.decomp.reader.readSliceShort(buf) catch {
            output_len.* = 0;
            return 1;
        };
        output_len.* = @intCast(n);
        if (n < cap) self.done = true;
        return 0;
    }
};

export fn tectonic_flate_new_decompressor(
    input_ptr: [*]const u8,
    input_len: u64,
) ?*anyopaque {
    const dc = Decompressor.create(input_ptr, input_len) orelse return null;
    return @ptrCast(dc);
}

export fn tectonic_flate_decompress_chunk(
    handle: ?*anyopaque,
    output_ptr: [*]u8,
    output_len: *u64,
) c_int {
    const ptr = handle orelse {
        output_len.* = 0;
        return 0;
    };
    const dc: *Decompressor = @ptrCast(@alignCast(ptr));
    return dc.read_chunk(output_ptr, output_len);
}

export fn tectonic_flate_free_decompressor(handle: ?*anyopaque) void {
    const ptr = handle orelse return;
    const dc: *Decompressor = @ptrCast(@alignCast(ptr));
    dc.destroy();
}

// -- tests (run via: zig build test-flate) --

const testing = std.testing;

// gzip-compressed "hello" -- verified via: printf 'hello' | gzip -nc | xxd -i
const gzip_hello = [_]u8{
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
    0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x86, 0xa6, 0x10,
    0x36, 0x05, 0x00, 0x00, 0x00,
};

test "sniff_container detects gzip" {
    try testing.expectEqual(flate.Container.gzip, sniff_container(&gzip_hello));
}

test "sniff_container detects zlib" {
    // CMF=0x78 (CM=8, CINFO=7), FLG=0x9C -> 0x789C % 31 == 0
    const zlib_hdr = [_]u8{ 0x78, 0x9C, 0x01, 0x02 };
    try testing.expectEqual(flate.Container.zlib, sniff_container(&zlib_hdr));
}

test "sniff_container falls back to raw" {
    try testing.expectEqual(flate.Container.raw, sniff_container(&[_]u8{ 0x00, 0x05 }));
    try testing.expectEqual(flate.Container.raw, sniff_container(&[_]u8{0x42}));
    try testing.expectEqual(flate.Container.raw, sniff_container(&[_]u8{}));
}

test "gzip decompress" {
    var out: [64]u8 = undefined;
    var out_len: u64 = out.len;
    const rc = tectonic_flate_decompress(&out, &out_len, &gzip_hello, gzip_hello.len);
    try testing.expectEqual(FlateResult.success, rc);
    try testing.expectEqualStrings("hello", out[0..@intCast(out_len)]);
}

test "compress then decompress roundtrip (zlib container)" {
    const input = "The quick brown fox jumps over the lazy dog";
    var compressed: [256]u8 = undefined;
    var comp_len: u64 = compressed.len;

    const crc = tectonic_flate_compress(&compressed, &comp_len, input.ptr, input.len, 6);
    try testing.expectEqual(FlateResult.success, crc);
    try testing.expect(comp_len > 0);

    // verify sniff detects zlib container
    const comp_slice = compressed[0..@intCast(comp_len)];
    try testing.expectEqual(flate.Container.zlib, sniff_container(comp_slice));

    var decompressed: [256]u8 = undefined;
    var decomp_len: u64 = decompressed.len;
    const drc = tectonic_flate_decompress(&decompressed, &decomp_len, &compressed, comp_len);
    try testing.expectEqual(FlateResult.success, drc);
    try testing.expectEqualStrings(input, decompressed[0..@intCast(decomp_len)]);
}

test "streaming chunk decode returns 0 at end" {
    const input = "hello streaming world";
    var compressed: [256]u8 = undefined;
    var comp_len: u64 = compressed.len;
    try testing.expectEqual(FlateResult.success, tectonic_flate_compress(
        &compressed,
        &comp_len,
        input.ptr,
        input.len,
        6,
    ));

    const handle = tectonic_flate_new_decompressor(&compressed, comp_len);
    try testing.expect(handle != null);
    defer tectonic_flate_free_decompressor(handle);

    // read all output in one large chunk
    var output: [256]u8 = undefined;
    var out_len: u64 = output.len;
    const rc1 = tectonic_flate_decompress_chunk(handle, &output, &out_len);
    try testing.expectEqual(@as(c_int, 0), rc1);
    try testing.expectEqualStrings(input, output[0..@intCast(out_len)]);

    // next call must return 0 bytes (stream exhausted)
    var tail_len: u64 = output.len;
    const rc2 = tectonic_flate_decompress_chunk(handle, &output, &tail_len);
    try testing.expectEqual(@as(c_int, 0), rc2);
    try testing.expectEqual(@as(u64, 0), tail_len);
}

test "streaming small chunks reassemble correctly" {
    const input = "abcdefghijklmnopqrstuvwxyz";
    var compressed: [256]u8 = undefined;
    var comp_len: u64 = compressed.len;
    _ = tectonic_flate_compress(&compressed, &comp_len, input.ptr, input.len, 6);

    const handle = tectonic_flate_new_decompressor(&compressed, comp_len);
    try testing.expect(handle != null);
    defer tectonic_flate_free_decompressor(handle);

    var result: [256]u8 = undefined;
    var total: usize = 0;
    while (total < result.len) {
        var chunk: [4]u8 = undefined;
        var chunk_len: u64 = chunk.len;
        const rc = tectonic_flate_decompress_chunk(handle, &chunk, &chunk_len);
        try testing.expectEqual(@as(c_int, 0), rc);
        const n: usize = @intCast(chunk_len);
        if (n == 0) break;
        @memcpy(result[total..][0..n], chunk[0..n]);
        total += n;
    }
    try testing.expectEqualStrings(input, result[0..total]);
}

test "decompress buf_error on undersized output" {
    const input = "this string is longer than four bytes";
    var compressed: [256]u8 = undefined;
    var comp_len: u64 = compressed.len;
    _ = tectonic_flate_compress(&compressed, &comp_len, input.ptr, input.len, 6);

    var tiny: [4]u8 = undefined;
    var tiny_len: u64 = tiny.len;
    const rc = tectonic_flate_decompress(&tiny, &tiny_len, &compressed, comp_len);
    try testing.expectEqual(FlateResult.buf_error, rc);
}
