// Digest.zig -- unified SHA-256 hex digest utilities.
//
// Single source of truth for computing SHA-256 hashes and converting
// them to lowercase hex strings. All functions are comptime-capable.

const std = @import("std");
const Sha256 = std.crypto.hash.sha2.Sha256;

// convert 32 raw bytes to 64-char lowercase hex string.
pub fn toHex(raw: [32]u8) [64]u8 {
    const hex_chars = "0123456789abcdef";
    var hex: [64]u8 = undefined;
    for (raw, 0..) |byte, i| {
        hex[i * 2] = hex_chars[byte >> 4];
        hex[i * 2 + 1] = hex_chars[byte & 0x0f];
    }
    return hex;
}

// compute raw SHA-256 hash of input bytes.
pub fn hashBytes(input: []const u8) [32]u8 {
    var hash: [32]u8 = undefined;
    Sha256.hash(input, &hash, .{});
    return hash;
}

// compute SHA-256 hash and return as 64-char hex string.
pub fn hexDigest(input: []const u8) [64]u8 {
    return toHex(hashBytes(input));
}
