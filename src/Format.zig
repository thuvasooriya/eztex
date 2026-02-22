// Format.zig -- read/write XeTeX binary .fmt format files.
// implements the exact binary layout from xetex-ini.c store_fmt_file/load_fmt_file.
// all on-disk data is big-endian. memory_word is 8 bytes (b32x2 union with b16x4/f64).
const std = @import("std");
const Allocator = std.mem.Allocator;
const Format = @This();

// format constants (must match C engine exactly)
pub const header_magic: i32 = 0x54544E43; // "TTNC"
pub const footer_magic: i32 = 0x0000029A;
pub const format_serial: i32 = 33;

pub const mem_top: i32 = 4_999_999;
pub const eqtb_size: i32 = 8_941_458;
pub const hash_prime: i32 = 8_501;
pub const active_base: i32 = 1;
pub const int_base: i32 = 7_826_729;
pub const hash_base: i32 = 2_228_226;
pub const frozen_control_sequence: i32 = 2_243_226;
pub const undefined_control_sequence: i32 = 2_254_339;
pub const prim_size: i32 = 2_100;
pub const font_base: i32 = 0;
pub const too_big_char: i32 = 65_536; // 0x10000 (from xetex-constants.h)
pub const biggest_lang: i32 = 255;
pub const trie_op_size: i32 = 35_111;
pub const hash_offset: i32 = 514;
pub const hash_extra_default: i32 = 600_000;
pub const hyph_prime_const: i32 = 607;

// 8-byte memory word, stored on disk as big-endian
pub const MemoryWord = [8]u8;

// b32x2: two i32 fields (s0, s1)
pub const B32x2 = struct {
    s0: i32,
    s1: i32,
};

pub const Header = struct {
    hash_high: i32,
    hyph_prime: i32,
};

pub const StringPool = struct {
    pool_ptr: i32,
    str_ptr: i32,
    str_start: []i32, // length: str_ptr - too_big_char + 1
    str_pool: []u16, // length: pool_ptr
};

pub const Memory = struct {
    lo_mem_max: i32,
    rover: i32,
    sa_root: [7]i32, // INT_VAL..INTER_CHAR_VAL
    lo_mem: []MemoryWord, // mem[0..lo_mem_max+1]
    hi_mem_min: i32,
    avail: i32,
    hi_mem: []MemoryWord, // mem[hi_mem_min..mem_end+1]
    var_used: i32,
    dyn_used: i32,
};

pub const EquivTable = struct {
    // RLE-compressed runs stored as flat segments
    segments: []RleSegment,
    // if hash_high > 0, extra eqtb entries
    extra: []MemoryWord,
};

pub const RleSegment = struct {
    unique_data: []MemoryWord,
    n_copies: i32, // how many copies of the last entry
};

pub const Primitives = struct {
    par_loc: i32,
    write_loc: i32,
    prim: []B32x2, // prim_size + 1 entries
};

pub const HashTable = struct {
    hash_used: i32,
    sparse_entries: []SparseHashEntry, // entries where text != 0 for p <= hash_used
    dense_hash: []B32x2, // hash[hash_used+1..undefined_control_sequence-1]
    extra_hash: []B32x2, // hash[eqtb_size+1..+hash_high] if hash_high > 0
    cs_count: i32,
};

pub const SparseHashEntry = struct {
    index: i32,
    value: B32x2,
};

pub const FontArrays = struct {
    fmem_ptr: i32,
    font_info: []MemoryWord,
    font_ptr: i32,
    // 24 parallel arrays, each font_ptr+1 long
    // stored as raw bytes since they have mixed types
    font_check: []MemoryWord, // b16x4 = 8 bytes each (memory_word sized)
    font_size: []i32,
    font_dsize: []i32,
    font_params: []i32,
    hyphen_char: []i32,
    skew_char: []i32,
    font_name: []i32,
    font_area: []i32,
    font_bc: []u16,
    font_ec: []u16,
    char_base: []i32,
    width_base: []i32,
    height_base: []i32,
    depth_base: []i32,
    italic_base: []i32,
    lig_kern_base: []i32,
    kern_base: []i32,
    exten_base: []i32,
    param_base: []i32,
    font_glue: []i32,
    bchar_label: []i32,
    font_bchar: []i32, // nine_bits = int32_t = 4 bytes on disk
    font_false_bchar: []i32,
};

pub const HyphEntry = struct {
    packed_key: i32, // k + 65536 * hyph_link[k]
    word: i32,
    list: i32,
};

pub const LangTrieUsed = struct {
    lang: i32,
    used: i32,
};

pub const HyphTrie = struct {
    hyph_count: i32,
    hyph_next: i32,
    hyph_entries: []HyphEntry,
    trie_max: i32,
    hyph_start: i32,
    trie_trl: []i32,
    trie_tro: []i32,
    trie_trc: []u16,
    max_hyph_char: i32,
    trie_op_ptr: i32,
    hyf_distance: []i16, // small_number = i16
    hyf_num: []i16,
    hyf_next: []u16, // trie_opcode = u16
    lang_trie_used: []LangTrieUsed,
};

// top-level format structure
header: Header,
string_pool: StringPool,
memory: Memory,
equiv_table: EquivTable,
primitives: Primitives,
hash_table: HashTable,
font_arrays: FontArrays,
hyph_trie: HyphTrie,

pub const LoadError = error{
    InvalidMagic,
    InvalidSerial,
    InvalidConstant,
    InvalidFormat,
    OutOfMemory,
    EndOfStream,
    ReadError,
};

pub const SaveError = error{
    WriteError,
};

// read a big-endian i32
fn read_i32(data: []const u8, pos: *usize) LoadError!i32 {
    if (pos.* + 4 > data.len) return error.EndOfStream;
    const result = std.mem.readInt(i32, data[pos.*..][0..4], .big);
    pos.* += 4;
    return result;
}

// read n big-endian i32s
fn read_i32_array(allocator: Allocator, data: []const u8, pos: *usize, count: usize) LoadError![]i32 {
    if (count == 0) {
        const empty = allocator.alloc(i32, 0) catch return error.OutOfMemory;
        return empty;
    }
    if (pos.* + count * 4 > data.len) return error.EndOfStream;
    const result = allocator.alloc(i32, count) catch return error.OutOfMemory;
    for (0..count) |i| {
        result[i] = std.mem.readInt(i32, data[pos.*..][0..4], .big);
        pos.* += 4;
    }
    return result;
}

// read n big-endian i16s
fn read_i16_array(allocator: Allocator, data: []const u8, pos: *usize, count: usize) LoadError![]i16 {
    if (count == 0) {
        const empty = allocator.alloc(i16, 0) catch return error.OutOfMemory;
        return empty;
    }
    if (pos.* + count * 2 > data.len) return error.EndOfStream;
    const result = allocator.alloc(i16, count) catch return error.OutOfMemory;
    for (0..count) |i| {
        result[i] = std.mem.readInt(i16, data[pos.*..][0..2], .big);
        pos.* += 2;
    }
    return result;
}

// read n big-endian u16s
fn read_u16_array(allocator: Allocator, data: []const u8, pos: *usize, count: usize) LoadError![]u16 {
    if (count == 0) {
        const empty = allocator.alloc(u16, 0) catch return error.OutOfMemory;
        return empty;
    }
    if (pos.* + count * 2 > data.len) return error.EndOfStream;
    const result = allocator.alloc(u16, count) catch return error.OutOfMemory;
    for (0..count) |i| {
        result[i] = std.mem.readInt(u16, data[pos.*..][0..2], .big);
        pos.* += 2;
    }
    return result;
}

// read n memory words (8 bytes each, stored big-endian on disk)
// we keep them as raw big-endian bytes for round-trip fidelity
fn read_memory_words(allocator: Allocator, data: []const u8, pos: *usize, count: usize) LoadError![]MemoryWord {
    if (count == 0) {
        const empty = allocator.alloc(MemoryWord, 0) catch return error.OutOfMemory;
        return empty;
    }
    if (pos.* + count * 8 > data.len) return error.EndOfStream;
    const result = allocator.alloc(MemoryWord, count) catch return error.OutOfMemory;
    for (0..count) |i| {
        @memcpy(&result[i], data[pos.*..][0..8]);
        pos.* += 8;
    }
    return result;
}

// read a single b32x2 (8 bytes big-endian = s1 first then s0 on disk)
fn read_b32x2(data: []const u8, pos: *usize) LoadError!B32x2 {
    if (pos.* + 8 > data.len) return error.EndOfStream;
    // on-disk big-endian layout for memory_word:
    // bytes 0-3 = s1 (big-endian), bytes 4-7 = s0 (big-endian)
    // this matches the big-endian struct layout: { s1, s0 }
    const s1 = std.mem.readInt(i32, data[pos.*..][0..4], .big);
    const s0 = std.mem.readInt(i32, data[pos.*..][4..8], .big);
    pos.* += 8;
    return .{ .s0 = s0, .s1 = s1 };
}

// read n b32x2 values
fn read_b32x2_array(allocator: Allocator, data: []const u8, pos: *usize, count: usize) LoadError![]B32x2 {
    if (count == 0) {
        const empty = allocator.alloc(B32x2, 0) catch return error.OutOfMemory;
        return empty;
    }
    const result = allocator.alloc(B32x2, count) catch return error.OutOfMemory;
    for (0..count) |i| {
        result[i] = try read_b32x2(data, pos);
    }
    return result;
}

pub fn load(allocator: Allocator, data: []const u8) LoadError!Format {
    var pos: usize = 0;

    // header
    const magic = try read_i32(data, &pos);
    if (magic != header_magic) return error.InvalidMagic;

    const serial = try read_i32(data, &pos);
    if (serial != format_serial) return error.InvalidSerial;

    const hash_high = try read_i32(data, &pos);
    if (hash_high < 0) return error.InvalidFormat;

    const check_mem_top = try read_i32(data, &pos);
    if (check_mem_top != mem_top) return error.InvalidConstant;

    const check_eqtb_size = try read_i32(data, &pos);
    if (check_eqtb_size != eqtb_size) return error.InvalidConstant;

    const check_hash_prime = try read_i32(data, &pos);
    if (check_hash_prime != hash_prime) return error.InvalidConstant;

    const hyph_prime_val = try read_i32(data, &pos);

    // string pool
    const pool_ptr = try read_i32(data, &pos);
    if (pool_ptr < 0) return error.InvalidFormat;

    const str_ptr = try read_i32(data, &pos);
    if (str_ptr < 0) return error.InvalidFormat;

    const str_start_len: usize = @intCast(str_ptr - too_big_char + 1);
    const str_start = try read_i32_array(allocator, data, &pos, str_start_len);
    errdefer allocator.free(str_start);

    const str_pool = try read_u16_array(allocator, data, &pos, @intCast(pool_ptr));
    errdefer allocator.free(str_pool);

    // memory
    const lo_mem_max = try read_i32(data, &pos);
    const rover = try read_i32(data, &pos);

    var sa_root: [7]i32 = undefined;
    for (0..7) |k| {
        sa_root[k] = try read_i32(data, &pos);
    }

    // read rover-linked chunks + remaining lo_mem into single buffer
    // the C code reads in chunks following the rover linked list, then the rest up to lo_mem_max
    // we need to reconstruct mem[0..lo_mem_max+1] by reading the same chunks
    const lo_mem_size: usize = @intCast(lo_mem_max + 1);
    const lo_mem = allocator.alloc(MemoryWord, lo_mem_size) catch return error.OutOfMemory;
    errdefer allocator.free(lo_mem);
    @memset(lo_mem, .{0} ** 8);

    // read rover-linked chunks
    {
        var p: i32 = 0;
        var q: i32 = rover;
        while (true) {
            const chunk_len: usize = @intCast(q + 2 - p);
            if (pos + chunk_len * 8 > data.len) return error.EndOfStream;
            const p_usize: usize = @intCast(p);
            for (0..chunk_len) |i| {
                @memcpy(&lo_mem[p_usize + i], data[pos..][0..8]);
                pos += 8;
            }
            // p = q + mem[q].b32.s0
            const q_usize: usize = @intCast(q);
            const mem_q_s0 = decode_b32x2_s0(lo_mem[q_usize]);
            p = q + mem_q_s0;
            // q = mem[q + 1].b32.s1
            const mem_q1_s1 = decode_b32x2_s1(lo_mem[q_usize + 1]);
            q = mem_q1_s1;
            if (q == rover) break;
        }
        // read remaining: mem[p..lo_mem_max+1]
        const remaining: usize = @intCast(lo_mem_max + 1 - p);
        if (pos + remaining * 8 > data.len) return error.EndOfStream;
        const p_usize2: usize = @intCast(p);
        for (0..remaining) |i| {
            @memcpy(&lo_mem[p_usize2 + i], data[pos..][0..8]);
            pos += 8;
        }
    }

    const hi_mem_min = try read_i32(data, &pos);
    const avail = try read_i32(data, &pos);

    // hi_mem: mem[hi_mem_min..mem_top+1]
    const hi_mem_len: usize = @intCast(mem_top + 1 - hi_mem_min);
    const hi_mem = try read_memory_words(allocator, data, &pos, hi_mem_len);
    errdefer allocator.free(hi_mem);

    const var_used = try read_i32(data, &pos);
    const dyn_used = try read_i32(data, &pos);

    // equiv table: RLE compressed
    // loop 1: ACTIVE_BASE to INT_BASE
    var segments: std.ArrayList(RleSegment) = .empty;
    errdefer {
        for (segments.items) |seg| allocator.free(seg.unique_data);
        segments.deinit(allocator);
    }

    {
        var k: i32 = active_base;
        while (k != int_base) {
            const n_unique = try read_i32(data, &pos);
            if (n_unique < 1) return error.InvalidFormat;
            const unique_data = try read_memory_words(allocator, data, &pos, @intCast(n_unique));
            const n_copies = try read_i32(data, &pos);
            if (n_copies < 0) return error.InvalidFormat;
            segments.append(allocator, .{
                .unique_data = unique_data,
                .n_copies = n_copies,
            }) catch return error.OutOfMemory;
            k += n_unique + n_copies;
        }
    }

    // loop 2: INT_BASE to EQTB_SIZE
    {
        var k: i32 = int_base;
        while (k <= eqtb_size) {
            const n_unique = try read_i32(data, &pos);
            if (n_unique < 1) return error.InvalidFormat;
            const unique_data = try read_memory_words(allocator, data, &pos, @intCast(n_unique));
            const n_copies = try read_i32(data, &pos);
            if (n_copies < 0) return error.InvalidFormat;
            segments.append(allocator, .{
                .unique_data = unique_data,
                .n_copies = n_copies,
            }) catch return error.OutOfMemory;
            k += n_unique + n_copies;
        }
    }

    const eqtb_segments = segments.toOwnedSlice(allocator) catch return error.OutOfMemory;
    errdefer {
        for (eqtb_segments) |seg| allocator.free(seg.unique_data);
        allocator.free(eqtb_segments);
    }

    // extra eqtb entries if hash_high > 0
    const eqtb_extra = if (hash_high > 0)
        try read_memory_words(allocator, data, &pos, @intCast(hash_high))
    else
        try read_memory_words(allocator, data, &pos, 0);
    errdefer allocator.free(eqtb_extra);

    // primitives
    const par_loc = try read_i32(data, &pos);
    const write_loc = try read_i32(data, &pos);

    const prim_count: usize = @intCast(prim_size + 1);
    const prim = try read_b32x2_array(allocator, data, &pos, prim_count);
    errdefer allocator.free(prim);

    // hash table
    const hash_used = try read_i32(data, &pos);

    // sparse entries: read pairs of (p, hash[p]) until p == hash_used (C do-while protocol)
    var sparse_list: std.ArrayList(SparseHashEntry) = .empty;
    errdefer {
        sparse_list.deinit(allocator);
    }

    {
        var p: i32 = hash_base - 1;
        while (true) {
            const x = try read_i32(data, &pos);
            if (x < p + 1 or x > hash_used) return error.InvalidFormat;
            p = x;
            const val = try read_b32x2(data, &pos);
            sparse_list.append(allocator, .{ .index = p, .value = val }) catch return error.OutOfMemory;
            if (p == hash_used) break;
        }
    }

    const sparse_entries = sparse_list.toOwnedSlice(allocator) catch return error.OutOfMemory;
    errdefer allocator.free(sparse_entries);

    // dense hash: hash[hash_used+1..undefined_control_sequence-1]
    const dense_count: usize = @intCast(undefined_control_sequence - 1 - hash_used);
    const dense_hash = try read_b32x2_array(allocator, data, &pos, dense_count);
    errdefer allocator.free(dense_hash);

    // extra hash if hash_high > 0
    const extra_hash = if (hash_high > 0)
        try read_b32x2_array(allocator, data, &pos, @intCast(hash_high))
    else
        try read_b32x2_array(allocator, data, &pos, 0);
    errdefer allocator.free(extra_hash);

    const cs_count = try read_i32(data, &pos);

    // fonts
    const fmem_ptr = try read_i32(data, &pos);
    if (fmem_ptr < 7) return error.InvalidFormat;

    const font_info = try read_memory_words(allocator, data, &pos, @intCast(fmem_ptr));
    errdefer allocator.free(font_info);

    const font_ptr = try read_i32(data, &pos);
    if (font_ptr < font_base) return error.InvalidFormat;

    const font_count: usize = @intCast(font_ptr + 1);

    // 24 parallel font arrays
    // font_check is b16x4 but sizeof(b16x4) == sizeof(memory_word) == 8 for dump_things
    // actually wait -- font_check is b16x4* which is 8 bytes. dump_things uses sizeof(base).
    // font_check[FONT_BASE] is b16x4, sizeof(b16x4) = 8 bytes. so it's memory-word sized.
    const f_font_check = try read_memory_words(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_check);
    const f_font_size = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_size);
    const f_font_dsize = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_dsize);
    const f_font_params = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_params);
    const f_hyphen_char = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_hyphen_char);
    const f_skew_char = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_skew_char);
    const f_font_name = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_name);
    const f_font_area = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_area);
    const f_font_bc = try read_u16_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_bc);
    const f_font_ec = try read_u16_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_ec);
    const f_char_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_char_base);
    const f_width_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_width_base);
    const f_height_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_height_base);
    const f_depth_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_depth_base);
    const f_italic_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_italic_base);
    const f_lig_kern_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_lig_kern_base);
    const f_kern_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_kern_base);
    const f_exten_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_exten_base);
    const f_param_base = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_param_base);
    const f_font_glue = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_glue);
    const f_bchar_label = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_bchar_label);
    // font_bchar and font_false_bchar are nine_bits = i16 (sizeof(short) = 2)
    // WAIT: nine_bits is typedef int32_t nine_bits in xetex-xetexd.h!
    // Let me recheck... "typedef int32_t nine_bits" -- so it's actually i32 on disk.
    // But dump_things uses sizeof(base), and font_bchar is `nine_bits*`...
    // nine_bits = int32_t, so sizeof = 4. Stored as 4-byte big-endian i32.
    const f_font_bchar = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_bchar);
    const f_font_false_bchar = try read_i32_array(allocator, data, &pos, font_count);
    errdefer allocator.free(f_font_false_bchar);

    // hyphenation
    const hyph_count = try read_i32(data, &pos);
    if (hyph_count < 0) return error.InvalidFormat;

    const hyph_next = try read_i32(data, &pos);

    const hyph_entries = allocator.alloc(HyphEntry, @intCast(hyph_count)) catch return error.OutOfMemory;
    errdefer allocator.free(hyph_entries);
    for (0..@as(usize, @intCast(hyph_count))) |i| {
        hyph_entries[i] = .{
            .packed_key = try read_i32(data, &pos),
            .word = try read_i32(data, &pos),
            .list = try read_i32(data, &pos),
        };
    }

    const trie_max = try read_i32(data, &pos);
    if (trie_max < 0) return error.InvalidFormat;

    const hyph_start = try read_i32(data, &pos);

    const trie_count: usize = @intCast(trie_max + 1);
    const trie_trl = try read_i32_array(allocator, data, &pos, trie_count);
    errdefer allocator.free(trie_trl);
    const trie_tro = try read_i32_array(allocator, data, &pos, trie_count);
    errdefer allocator.free(trie_tro);
    // trie_trc: uint16_t array (trie_opcode in the dump context is actually uint16_t for trie_trc)
    // wait - trie_trc is declared as uint16_t* in load_fmt_file. Let me check the C source.
    // In store: dump_things(trie_trc[0], trie_max + 1) where trie_trc is uint16_t*
    // But wait -- in xetex-xetexd.h, what type is trie_trc?
    // The variable declarations show trie_trl and trie_tro as trie_pointer (int32_t),
    // but trie_trc would be... let me check. Actually in the load code it allocates
    // trie_trc as uint16_t*. But dump_things uses sizeof(base) which is sizeof(uint16_t) = 2.
    // Hmm but that contradicts - trie_trl is trie_pointer=i32, trie_trc should be different.
    // Actually looking at load_fmt_file line 2878-2880:
    //   trie_trc = xmalloc_array(uint16_t, j + 1);
    //   undump_things(trie_trc[0], j + 1);
    // So trie_trc elements are uint16_t = 2 bytes each on disk.
    // BUT WAIT - undump_things uses sizeof(base) = sizeof(trie_trc[0]) = sizeof(uint16_t) = 2
    // So yes, trie_trc is u16 on disk.
    const trie_trc = try read_u16_array(allocator, data, &pos, trie_count);
    errdefer allocator.free(trie_trc);

    const max_hyph_char = try read_i32(data, &pos);
    const trie_op_ptr = try read_i32(data, &pos);
    if (trie_op_ptr < 0) return error.InvalidFormat;

    const op_count: usize = @intCast(trie_op_ptr);
    // hyf_distance: small_number = short = i16, sizeof = 2
    // wait: small_number is `typedef short small_number` = sizeof(short) = 2
    const hyf_distance = try read_i16_array(allocator, data, &pos, op_count);
    errdefer allocator.free(hyf_distance);
    const hyf_num = try read_i16_array(allocator, data, &pos, op_count);
    errdefer allocator.free(hyf_num);
    // hyf_next: trie_opcode = unsigned short = u16
    const hyf_next_arr = try read_u16_array(allocator, data, &pos, op_count);
    errdefer allocator.free(hyf_next_arr);

    // language trie_used pairs: read while trie_op_ptr > 0 (consuming pairs)
    var lang_list: std.ArrayList(LangTrieUsed) = .empty;
    errdefer lang_list.deinit(allocator);
    {
        var remaining_ops = trie_op_ptr;
        while (remaining_ops > 0) {
            const lang = try read_i32(data, &pos);
            const used = try read_i32(data, &pos);
            lang_list.append(allocator, .{ .lang = lang, .used = used }) catch return error.OutOfMemory;
            remaining_ops -= used;
        }
    }
    const lang_trie_used = lang_list.toOwnedSlice(allocator) catch return error.OutOfMemory;
    errdefer allocator.free(lang_trie_used);

    // footer
    const footer = try read_i32(data, &pos);
    if (footer != footer_magic) return error.InvalidFormat;

    return .{
        .header = .{
            .hash_high = hash_high,
            .hyph_prime = hyph_prime_val,
        },
        .string_pool = .{
            .pool_ptr = pool_ptr,
            .str_ptr = str_ptr,
            .str_start = str_start,
            .str_pool = str_pool,
        },
        .memory = .{
            .lo_mem_max = lo_mem_max,
            .rover = rover,
            .sa_root = sa_root,
            .lo_mem = lo_mem,
            .hi_mem_min = hi_mem_min,
            .avail = avail,
            .hi_mem = hi_mem,
            .var_used = var_used,
            .dyn_used = dyn_used,
        },
        .equiv_table = .{
            .segments = eqtb_segments,
            .extra = eqtb_extra,
        },
        .primitives = .{
            .par_loc = par_loc,
            .write_loc = write_loc,
            .prim = prim,
        },
        .hash_table = .{
            .hash_used = hash_used,
            .sparse_entries = sparse_entries,
            .dense_hash = dense_hash,
            .extra_hash = extra_hash,
            .cs_count = cs_count,
        },
        .font_arrays = .{
            .fmem_ptr = fmem_ptr,
            .font_info = font_info,
            .font_ptr = font_ptr,
            .font_check = f_font_check,
            .font_size = f_font_size,
            .font_dsize = f_font_dsize,
            .font_params = f_font_params,
            .hyphen_char = f_hyphen_char,
            .skew_char = f_skew_char,
            .font_name = f_font_name,
            .font_area = f_font_area,
            .font_bc = f_font_bc,
            .font_ec = f_font_ec,
            .char_base = f_char_base,
            .width_base = f_width_base,
            .height_base = f_height_base,
            .depth_base = f_depth_base,
            .italic_base = f_italic_base,
            .lig_kern_base = f_lig_kern_base,
            .kern_base = f_kern_base,
            .exten_base = f_exten_base,
            .param_base = f_param_base,
            .font_glue = f_font_glue,
            .bchar_label = f_bchar_label,
            .font_bchar = f_font_bchar,
            .font_false_bchar = f_font_false_bchar,
        },
        .hyph_trie = .{
            .hyph_count = hyph_count,
            .hyph_next = hyph_next,
            .hyph_entries = hyph_entries,
            .trie_max = trie_max,
            .hyph_start = hyph_start,
            .trie_trl = trie_trl,
            .trie_tro = trie_tro,
            .trie_trc = trie_trc,
            .max_hyph_char = max_hyph_char,
            .trie_op_ptr = trie_op_ptr,
            .hyf_distance = hyf_distance,
            .hyf_num = hyf_num,
            .hyf_next = hyf_next_arr,
            .lang_trie_used = lang_trie_used,
        },
    };
}

// write helpers
fn write_i32(buf: *std.ArrayList(u8), allocator: Allocator, val: i32) SaveError!void {
    var bytes: [4]u8 = undefined;
    std.mem.writeInt(i32, &bytes, val, .big);
    buf.appendSlice(allocator, &bytes) catch return error.WriteError;
}

fn write_i32_array(buf: *std.ArrayList(u8), allocator: Allocator, vals: []const i32) SaveError!void {
    for (vals) |val| {
        try write_i32(buf, allocator, val);
    }
}

fn write_i16_array(buf: *std.ArrayList(u8), allocator: Allocator, vals: []const i16) SaveError!void {
    for (vals) |val| {
        var bytes: [2]u8 = undefined;
        std.mem.writeInt(i16, &bytes, val, .big);
        buf.appendSlice(allocator, &bytes) catch return error.WriteError;
    }
}

fn write_u16_array(buf: *std.ArrayList(u8), allocator: Allocator, vals: []const u16) SaveError!void {
    for (vals) |val| {
        var bytes: [2]u8 = undefined;
        std.mem.writeInt(u16, &bytes, val, .big);
        buf.appendSlice(allocator, &bytes) catch return error.WriteError;
    }
}

fn write_memory_words(buf: *std.ArrayList(u8), allocator: Allocator, words: []const MemoryWord) SaveError!void {
    for (words) |word| {
        buf.appendSlice(allocator, &word) catch return error.WriteError;
    }
}

fn write_b32x2(buf: *std.ArrayList(u8), allocator: Allocator, val: B32x2) SaveError!void {
    // on disk big-endian: s1 first (bytes 0-3), then s0 (bytes 4-7)
    var bytes: [8]u8 = undefined;
    std.mem.writeInt(i32, bytes[0..4], val.s1, .big);
    std.mem.writeInt(i32, bytes[4..8], val.s0, .big);
    buf.appendSlice(allocator, &bytes) catch return error.WriteError;
}

fn write_b32x2_array(buf: *std.ArrayList(u8), allocator: Allocator, vals: []const B32x2) SaveError!void {
    for (vals) |val| {
        try write_b32x2(buf, allocator, val);
    }
}

pub fn save(self: *const Format, allocator: Allocator) (SaveError || Allocator.Error)![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);

    // header
    try write_i32(&buf, allocator, header_magic);
    try write_i32(&buf, allocator, format_serial);
    try write_i32(&buf, allocator, self.header.hash_high);
    try write_i32(&buf, allocator, mem_top);
    try write_i32(&buf, allocator, eqtb_size);
    try write_i32(&buf, allocator, hash_prime);
    try write_i32(&buf, allocator, self.header.hyph_prime);

    // string pool
    try write_i32(&buf, allocator, self.string_pool.pool_ptr);
    try write_i32(&buf, allocator, self.string_pool.str_ptr);
    try write_i32_array(&buf, allocator, self.string_pool.str_start);
    try write_u16_array(&buf, allocator, self.string_pool.str_pool);

    // memory: we need to write it in the same rover-linked-chunk order
    // lo_mem is stored as mem[0..lo_mem_max+1], we need to reconstruct the rover walk
    const lo_mem = self.memory.lo_mem;
    const rover_val = self.memory.rover;

    // write lo_mem_max, rover, sa_root
    try write_i32(&buf, allocator, self.memory.lo_mem_max);
    try write_i32(&buf, allocator, rover_val);
    for (self.memory.sa_root) |root| {
        try write_i32(&buf, allocator, root);
    }

    // write rover-linked chunks
    {
        var p: i32 = 0;
        var q: i32 = rover_val;
        while (true) {
            const chunk_len: usize = @intCast(q + 2 - p);
            const p_usize: usize = @intCast(p);
            try write_memory_words(&buf, allocator, lo_mem[p_usize..][0..chunk_len]);

            const q_usize: usize = @intCast(q);
            const mem_q_s0 = decode_b32x2_s0(lo_mem[q_usize]);
            p = q + mem_q_s0;
            const mem_q1_s1 = decode_b32x2_s1(lo_mem[q_usize + 1]);
            q = mem_q1_s1;
            if (q == rover_val) break;
        }
        // remaining lo_mem
        const remaining_start: usize = @intCast(p);
        const remaining_end: usize = @intCast(self.memory.lo_mem_max + 1);
        try write_memory_words(&buf, allocator, lo_mem[remaining_start..remaining_end]);
    }

    // hi_mem
    try write_i32(&buf, allocator, self.memory.hi_mem_min);
    try write_i32(&buf, allocator, self.memory.avail);
    try write_memory_words(&buf, allocator, self.memory.hi_mem);
    try write_i32(&buf, allocator, self.memory.var_used);
    try write_i32(&buf, allocator, self.memory.dyn_used);

    // equiv table RLE segments
    for (self.equiv_table.segments) |seg| {
        try write_i32(&buf, allocator, @intCast(seg.unique_data.len));
        try write_memory_words(&buf, allocator, seg.unique_data);
        try write_i32(&buf, allocator, seg.n_copies);
    }

    // extra eqtb
    if (self.header.hash_high > 0) {
        try write_memory_words(&buf, allocator, self.equiv_table.extra);
    }

    // primitives
    try write_i32(&buf, allocator, self.primitives.par_loc);
    try write_i32(&buf, allocator, self.primitives.write_loc);
    try write_b32x2_array(&buf, allocator, self.primitives.prim);

    // hash table: sparse entries as (index, b32x2) pairs, must end with hash_used (C do-while protocol)
    try write_i32(&buf, allocator, self.hash_table.hash_used);

    for (self.hash_table.sparse_entries) |entry| {
        try write_i32(&buf, allocator, entry.index);
        try write_b32x2(&buf, allocator, entry.value);
    }

    try write_b32x2_array(&buf, allocator, self.hash_table.dense_hash);

    if (self.header.hash_high > 0) {
        try write_b32x2_array(&buf, allocator, self.hash_table.extra_hash);
    }

    try write_i32(&buf, allocator, self.hash_table.cs_count);

    // fonts
    try write_i32(&buf, allocator, self.font_arrays.fmem_ptr);
    try write_memory_words(&buf, allocator, self.font_arrays.font_info);
    try write_i32(&buf, allocator, self.font_arrays.font_ptr);
    try write_memory_words(&buf, allocator, self.font_arrays.font_check);
    try write_i32_array(&buf, allocator, self.font_arrays.font_size);
    try write_i32_array(&buf, allocator, self.font_arrays.font_dsize);
    try write_i32_array(&buf, allocator, self.font_arrays.font_params);
    try write_i32_array(&buf, allocator, self.font_arrays.hyphen_char);
    try write_i32_array(&buf, allocator, self.font_arrays.skew_char);
    try write_i32_array(&buf, allocator, self.font_arrays.font_name);
    try write_i32_array(&buf, allocator, self.font_arrays.font_area);
    try write_u16_array(&buf, allocator, self.font_arrays.font_bc);
    try write_u16_array(&buf, allocator, self.font_arrays.font_ec);
    try write_i32_array(&buf, allocator, self.font_arrays.char_base);
    try write_i32_array(&buf, allocator, self.font_arrays.width_base);
    try write_i32_array(&buf, allocator, self.font_arrays.height_base);
    try write_i32_array(&buf, allocator, self.font_arrays.depth_base);
    try write_i32_array(&buf, allocator, self.font_arrays.italic_base);
    try write_i32_array(&buf, allocator, self.font_arrays.lig_kern_base);
    try write_i32_array(&buf, allocator, self.font_arrays.kern_base);
    try write_i32_array(&buf, allocator, self.font_arrays.exten_base);
    try write_i32_array(&buf, allocator, self.font_arrays.param_base);
    try write_i32_array(&buf, allocator, self.font_arrays.font_glue);
    try write_i32_array(&buf, allocator, self.font_arrays.bchar_label);
    try write_i32_array(&buf, allocator, self.font_arrays.font_bchar);
    try write_i32_array(&buf, allocator, self.font_arrays.font_false_bchar);

    // hyphenation
    try write_i32(&buf, allocator, self.hyph_trie.hyph_count);
    try write_i32(&buf, allocator, self.hyph_trie.hyph_next);
    for (self.hyph_trie.hyph_entries) |entry| {
        try write_i32(&buf, allocator, entry.packed_key);
        try write_i32(&buf, allocator, entry.word);
        try write_i32(&buf, allocator, entry.list);
    }

    try write_i32(&buf, allocator, self.hyph_trie.trie_max);
    try write_i32(&buf, allocator, self.hyph_trie.hyph_start);
    try write_i32_array(&buf, allocator, self.hyph_trie.trie_trl);
    try write_i32_array(&buf, allocator, self.hyph_trie.trie_tro);
    try write_u16_array(&buf, allocator, self.hyph_trie.trie_trc);
    try write_i32(&buf, allocator, self.hyph_trie.max_hyph_char);
    try write_i32(&buf, allocator, self.hyph_trie.trie_op_ptr);
    try write_i16_array(&buf, allocator, self.hyph_trie.hyf_distance);
    try write_i16_array(&buf, allocator, self.hyph_trie.hyf_num);
    try write_u16_array(&buf, allocator, self.hyph_trie.hyf_next);

    for (self.hyph_trie.lang_trie_used) |entry| {
        try write_i32(&buf, allocator, entry.lang);
        try write_i32(&buf, allocator, entry.used);
    }

    // footer
    try write_i32(&buf, allocator, footer_magic);

    return buf.toOwnedSlice(allocator);
}

pub fn deinit(self: *Format, allocator: Allocator) void {
    // string pool
    allocator.free(self.string_pool.str_start);
    allocator.free(self.string_pool.str_pool);

    // memory
    allocator.free(self.memory.lo_mem);
    allocator.free(self.memory.hi_mem);

    // equiv table
    for (self.equiv_table.segments) |seg| {
        allocator.free(seg.unique_data);
    }
    allocator.free(self.equiv_table.segments);
    allocator.free(self.equiv_table.extra);

    // primitives
    allocator.free(self.primitives.prim);

    // hash table
    allocator.free(self.hash_table.sparse_entries);
    allocator.free(self.hash_table.dense_hash);
    allocator.free(self.hash_table.extra_hash);

    // fonts
    allocator.free(self.font_arrays.font_info);
    allocator.free(self.font_arrays.font_check);
    allocator.free(self.font_arrays.font_size);
    allocator.free(self.font_arrays.font_dsize);
    allocator.free(self.font_arrays.font_params);
    allocator.free(self.font_arrays.hyphen_char);
    allocator.free(self.font_arrays.skew_char);
    allocator.free(self.font_arrays.font_name);
    allocator.free(self.font_arrays.font_area);
    allocator.free(self.font_arrays.font_bc);
    allocator.free(self.font_arrays.font_ec);
    allocator.free(self.font_arrays.char_base);
    allocator.free(self.font_arrays.width_base);
    allocator.free(self.font_arrays.height_base);
    allocator.free(self.font_arrays.depth_base);
    allocator.free(self.font_arrays.italic_base);
    allocator.free(self.font_arrays.lig_kern_base);
    allocator.free(self.font_arrays.kern_base);
    allocator.free(self.font_arrays.exten_base);
    allocator.free(self.font_arrays.param_base);
    allocator.free(self.font_arrays.font_glue);
    allocator.free(self.font_arrays.bchar_label);
    allocator.free(self.font_arrays.font_bchar);
    allocator.free(self.font_arrays.font_false_bchar);

    // hyph trie
    allocator.free(self.hyph_trie.hyph_entries);
    allocator.free(self.hyph_trie.trie_trl);
    allocator.free(self.hyph_trie.trie_tro);
    allocator.free(self.hyph_trie.trie_trc);
    allocator.free(self.hyph_trie.hyf_distance);
    allocator.free(self.hyph_trie.hyf_num);
    allocator.free(self.hyph_trie.hyf_next);
    allocator.free(self.hyph_trie.lang_trie_used);
}

// decode s0 from a big-endian memory word (b32x2 interpretation)
// on disk big-endian: bytes 0-3 = s1, bytes 4-7 = s0
fn decode_b32x2_s0(word: MemoryWord) i32 {
    return std.mem.readInt(i32, word[4..8], .big);
}

// decode s1 from a big-endian memory word
fn decode_b32x2_s1(word: MemoryWord) i32 {
    return std.mem.readInt(i32, word[0..4], .big);
}

// -- tests --

fn make_memory_word(s1: i32, s0: i32) MemoryWord {
    var word: MemoryWord = undefined;
    std.mem.writeInt(i32, word[0..4], s1, .big);
    std.mem.writeInt(i32, word[4..8], s0, .big);
    return word;
}

test "read/write i32 big-endian" {
    const bytes = [_]u8{ 0x54, 0x54, 0x4E, 0x43 };
    var pos: usize = 0;
    const val = try read_i32(&bytes, &pos);
    try std.testing.expectEqual(header_magic, val);
    try std.testing.expectEqual(@as(usize, 4), pos);
}

test "read/write b32x2" {
    // s1=0x00000001, s0=0x00000002 in big-endian
    const bytes = [_]u8{
        0x00, 0x00, 0x00, 0x01, // s1
        0x00, 0x00, 0x00, 0x02, // s0
    };
    var pos: usize = 0;
    const val = try read_b32x2(&bytes, &pos);
    try std.testing.expectEqual(@as(i32, 1), val.s1);
    try std.testing.expectEqual(@as(i32, 2), val.s0);
}

test "decode memory word b32x2 fields" {
    const word = make_memory_word(42, 99);
    try std.testing.expectEqual(@as(i32, 42), decode_b32x2_s1(word));
    try std.testing.expectEqual(@as(i32, 99), decode_b32x2_s0(word));
}

test "invalid magic returns error" {
    const bytes = [_]u8{ 0x00, 0x00, 0x00, 0x00 } ++ ([_]u8{0} ** 100);
    const result = load(std.testing.allocator, &bytes);
    try std.testing.expectError(error.InvalidMagic, result);
}

test "invalid serial returns error" {
    var bytes: [100]u8 = undefined;
    @memset(&bytes, 0);
    var pos: usize = 0;
    // write valid magic
    std.mem.writeInt(i32, bytes[pos..][0..4], header_magic, .big);
    pos += 4;
    // write wrong serial
    std.mem.writeInt(i32, bytes[pos..][0..4], 99, .big);
    const result = load(std.testing.allocator, &bytes);
    try std.testing.expectError(error.InvalidSerial, result);
}

test "round-trip minimal format" {
    const allocator = std.testing.allocator;

    // helper to allocate a zeroed slice
    const H = struct {
        fn zi32(a: Allocator, n: usize) ![]i32 {
            const s = try a.alloc(i32, n);
            @memset(s, 0);
            return s;
        }
        fn zu16(a: Allocator, n: usize) ![]u16 {
            const s = try a.alloc(u16, n);
            @memset(s, 0);
            return s;
        }
        fn zmw(a: Allocator, n: usize) ![]MemoryWord {
            const s = try a.alloc(MemoryWord, n);
            @memset(s, .{0} ** 8);
            return s;
        }
    };

    // rover must point to a valid node in lo_mem with a circular linked list
    const lo_mem_max: i32 = 1_020;
    const lo_mem = try H.zmw(allocator, @intCast(lo_mem_max + 1));
    defer allocator.free(lo_mem);

    // rover at position 20: single free node covering everything, circular
    lo_mem[20] = make_memory_word(0, lo_mem_max + 1 - 20);
    lo_mem[21] = make_memory_word(20, 0);

    const hi_mem_min: i32 = mem_top - 14;
    const hi_mem = try H.zmw(allocator, @intCast(mem_top + 1 - hi_mem_min));
    defer allocator.free(hi_mem);

    // eqtb: two RLE segments covering ACTIVE_BASE..INT_BASE and INT_BASE..EQTB_SIZE
    const seg1_data = try H.zmw(allocator, @intCast(int_base - active_base));
    const seg2_data = try H.zmw(allocator, 1);
    const segments = try allocator.alloc(RleSegment, 2);
    segments[0] = .{ .unique_data = seg1_data, .n_copies = 0 };
    segments[1] = .{ .unique_data = seg2_data, .n_copies = eqtb_size - int_base };

    const prim_data = try allocator.alloc(B32x2, prim_size + 1);
    @memset(prim_data, .{ .s0 = 0, .s1 = 0 });

    const dense_count: usize = @intCast(undefined_control_sequence - 1 - frozen_control_sequence);
    const dense_hash = try allocator.alloc(B32x2, dense_count);
    @memset(dense_hash, .{ .s0 = 0, .s1 = 0 });

    var fmt = Format{
        .header = .{ .hash_high = 0, .hyph_prime = hyph_prime_const },
        .string_pool = .{
            .pool_ptr = 0,
            .str_ptr = too_big_char,
            .str_start = try allocator.dupe(i32, &.{0}),
            .str_pool = try allocator.alloc(u16, 0),
        },
        .memory = .{
            .lo_mem_max = lo_mem_max,
            .rover = 20,
            .sa_root = .{ 0, 0, 0, 0, 0, 0, 0 },
            .lo_mem = try allocator.dupe(MemoryWord, lo_mem),
            .hi_mem_min = hi_mem_min,
            .avail = 0,
            .hi_mem = try allocator.dupe(MemoryWord, hi_mem),
            .var_used = 0,
            .dyn_used = 0,
        },
        .equiv_table = .{
            .segments = segments,
            .extra = try allocator.alloc(MemoryWord, 0),
        },
        .primitives = .{
            .par_loc = hash_base,
            .write_loc = hash_base,
            .prim = prim_data,
        },
        .hash_table = .{
            .hash_used = frozen_control_sequence,
            .sparse_entries = try allocator.dupe(SparseHashEntry, &.{.{
                .index = frozen_control_sequence,
                .value = .{ .s0 = 0, .s1 = 0 },
            }}),
            .dense_hash = dense_hash,
            .extra_hash = try allocator.alloc(B32x2, 0),
            .cs_count = 0,
        },
        .font_arrays = .{
            .fmem_ptr = 7,
            .font_info = try H.zmw(allocator, 7),
            .font_ptr = 0,
            .font_check = try H.zmw(allocator, 1),
            .font_size = try H.zi32(allocator, 1),
            .font_dsize = try H.zi32(allocator, 1),
            .font_params = try H.zi32(allocator, 1),
            .hyphen_char = try H.zi32(allocator, 1),
            .skew_char = try H.zi32(allocator, 1),
            .font_name = try H.zi32(allocator, 1),
            .font_area = try H.zi32(allocator, 1),
            .font_bc = try H.zu16(allocator, 1),
            .font_ec = try H.zu16(allocator, 1),
            .char_base = try H.zi32(allocator, 1),
            .width_base = try H.zi32(allocator, 1),
            .height_base = try H.zi32(allocator, 1),
            .depth_base = try H.zi32(allocator, 1),
            .italic_base = try H.zi32(allocator, 1),
            .lig_kern_base = try H.zi32(allocator, 1),
            .kern_base = try H.zi32(allocator, 1),
            .exten_base = try H.zi32(allocator, 1),
            .param_base = try H.zi32(allocator, 1),
            .font_glue = try H.zi32(allocator, 1),
            .bchar_label = try H.zi32(allocator, 1),
            .font_bchar = try H.zi32(allocator, 1),
            .font_false_bchar = try H.zi32(allocator, 1),
        },
        .hyph_trie = .{
            .hyph_count = 0,
            .hyph_next = hyph_prime_const,
            .hyph_entries = try allocator.alloc(HyphEntry, 0),
            .trie_max = 0,
            .hyph_start = 0,
            .trie_trl = try allocator.dupe(i32, &.{0}),
            .trie_tro = try allocator.dupe(i32, &.{0}),
            .trie_trc = try allocator.dupe(u16, &.{0}),
            .max_hyph_char = 0,
            .trie_op_ptr = 0,
            .hyf_distance = try allocator.alloc(i16, 0),
            .hyf_num = try allocator.alloc(i16, 0),
            .hyf_next = try allocator.alloc(u16, 0),
            .lang_trie_used = try allocator.alloc(LangTrieUsed, 0),
        },
    };
    defer fmt.deinit(allocator);

    const saved = try fmt.save(allocator);
    defer allocator.free(saved);

    var loaded = try load(allocator, saved);
    defer loaded.deinit(allocator);

    // verify key fields round-tripped
    try std.testing.expectEqual(fmt.header.hash_high, loaded.header.hash_high);
    try std.testing.expectEqual(fmt.header.hyph_prime, loaded.header.hyph_prime);
    try std.testing.expectEqual(fmt.string_pool.pool_ptr, loaded.string_pool.pool_ptr);
    try std.testing.expectEqual(fmt.memory.lo_mem_max, loaded.memory.lo_mem_max);
    try std.testing.expectEqual(fmt.memory.rover, loaded.memory.rover);
    try std.testing.expectEqual(fmt.font_arrays.fmem_ptr, loaded.font_arrays.fmem_ptr);
    try std.testing.expectEqual(fmt.hyph_trie.hyph_count, loaded.hyph_trie.hyph_count);

    // verify byte-exact round-trip
    const saved2 = try loaded.save(allocator);
    defer allocator.free(saved2);
    try std.testing.expectEqualSlices(u8, saved, saved2);
}

test "constants match expected values" {
    try std.testing.expectEqual(@as(i32, 0x54544E43), header_magic);
    try std.testing.expectEqual(@as(i32, 0x0000029A), footer_magic);
    try std.testing.expectEqual(@as(i32, 33), format_serial);
    try std.testing.expectEqual(@as(i32, 4_999_999), mem_top);
    try std.testing.expectEqual(@as(i32, 8_941_458), eqtb_size);
    try std.testing.expectEqual(@as(i32, 8_501), hash_prime);
    try std.testing.expectEqual(@as(i32, 0x10000), too_big_char);
}

test "truncated input returns EndOfStream" {
    // just the magic, no serial
    var bytes: [4]u8 = undefined;
    std.mem.writeInt(i32, &bytes, header_magic, .big);
    const result = load(std.testing.allocator, &bytes);
    try std.testing.expectError(error.EndOfStream, result);
}

test "round-trip real xelatex.fmt" {
    const home = std.posix.getenv("HOME") orelse return error.SkipZigTest;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/Library/Caches/eztex/v1/formats/xelatex.fmt", .{home}) catch return error.SkipZigTest;

    const file = std.fs.openFileAbsolute(path, .{}) catch return error.SkipZigTest;
    defer file.close();

    const allocator = std.testing.allocator;
    const bytes = file.readToEndAlloc(allocator, 100 * 1024 * 1024) catch return error.SkipZigTest;
    defer allocator.free(bytes);

    var fmt = try Format.load(allocator, bytes);
    defer fmt.deinit(allocator);

    const out = try fmt.save(allocator);
    defer allocator.free(out);

    try std.testing.expectEqual(bytes.len, out.len);
    try std.testing.expectEqualSlices(u8, bytes, out);
}
