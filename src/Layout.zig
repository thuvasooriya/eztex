// Layout.zig -- Zig implementation of xetex_layout functions
//
// Replaces the following from stubs/xetex_layout.c:
// - BBox cache (getCachedGlyphBBox, cacheGlyphBBox)
// - Character protrusion codes (set_cp_code, get_cp_code)
// - Graphite stubs (12 functions, all return 0/null/false)
// - Font unit conversion (ttxl_font_units_to_points/points_to_units/get_point_size)
// - Engine accessors (getFont, getExtendFactor, getSlantFactor, getEmboldenFactor,
//   getPointSize, getAscentAndDescent, getCapAndXHeight, getDefaultDirection, getRgbValue)
// - loaded_font_design_size getter/setter
// - req_engine global (getReqEngine, setReqEngine)
// - Shaper queries (usingGraphite, usingOpenType)
// - Font filename (getFontFilename, freeFontFilename)
// - Design size (getDesignSize)
// - OpenType table query (hasFontTable)
// - Font layout direction (setFontLayoutDir)
// - OT script/language/feature enumeration (countScripts, getIndScript,
//   countLanguages, getIndLanguage, countFeatures, getIndFeature)
// - OT math font detection (isOpenTypeMathFont)
// - HarfBuzz font accessor (ttxl_get_hb_font)
// - Font slant (getSlant)
// - Glyph name query (getGlyphName, freeGlyphName)
// - Glyph count (countGlyphs)
// - Glyph width (getGlyphWidth) -- uses FT_Get_Advance, no extend factor
// - Engine glyph queries: getGlyphWidthFromEngine, getGlyphBounds,
//   getGlyphHeightDepth, getGlyphSidebearings, getGlyphItalCorr
// - Internal helper: get_glyph_bounds_internal (FT_Load_Glyph + FT_Get_Glyph + FT_Glyph_Get_CBox)
// - Char mapping: mapCharToGlyph, mapGlyphToIndex, getFontCharRange
// - Engine lifecycle: createLayoutEngine, createLayoutEngineBorrowed, deleteLayoutEngine
// - Font creation/deletion: createFontFromFile, deleteFont
// - Glyph output: getGlyphs, getGlyphAdvances, getGlyphPositions
// - Text shaping: layoutChars (HarfBuzz shape plan with cached/fallback logic)
// - Font manager lifecycle: destroy_font_manager (FT shutdown + HB font funcs singleton destroy)
// - Platform font functions (non-Mac only, via conditional @export):
//   findFontByName, getFullName, ttxl_platfont_get_desc, createFont
// - Platform font functions (macOS CoreText, via conditional @export):
//   findFontByName, getFullName, ttxl_platfont_get_desc, createFont,
//   getFileNameFromCTFont, register_bundle_fonts

const std = @import("std");
const builtin = @import("builtin");
const Log = @import("Log.zig");

// -- Extern struct layouts matching C definitions in xetex_layout.c --

const XeTeXFont_rec = extern struct {
    units_per_em: u16,
    point_size: f32,
    ascent: f32,
    descent: f32,
    cap_height: f32,
    x_height: f32,
    italic_angle: f32,
    vertical: c_int,
    filename: ?[*:0]u8,
    index: u32,
    ft_face: ?*anyopaque, // FT_Face
    hb_font: ?*anyopaque, // hb_font_t*
    font_data: ?*anyopaque,
    font_data_size: usize,
};

const XeTeXLayoutEngine_rec = extern struct {
    font: ?*XeTeXFont_rec,
    owns_font: c_int,
    script: u32, // hb_tag_t
    language: ?*anyopaque, // hb_language_t (const hb_language_impl_t*)
    features: ?*anyopaque, // hb_feature_t*
    n_features: c_int,
    shaper_list: ?*anyopaque, // char**
    n_shapers: c_int,
    used_shaper: ?[*:0]const u8, // char* (shaper name, e.g. "ot", "graphite2")
    rgb_value: u32,
    extend: f32,
    slant: f32,
    embolden: f32,
    hb_buffer: ?*anyopaque, // hb_buffer_t*
};

const GlyphBBox = extern struct {
    x_min: f32,
    y_min: f32,
    x_max: f32,
    y_max: f32,
};

// -- HarfBuzz externs (resolved at link time) --
// hb_script_t and hb_direction_t are C enums -> c_uint in ABI
extern fn hb_buffer_get_script(*anyopaque) c_uint;
extern fn hb_script_get_horizontal_direction(c_uint) c_uint;

// HarfBuzz glyph info/position structs (only fields we use).
// Full hb_glyph_info_t is 20 bytes: codepoint(u32) + mask(u32) + cluster(u32) + 2 internal u32.
// Full hb_glyph_position_t is 20 bytes: x_advance + y_advance + x_offset + y_offset (all i32) + 1 internal u32.
const hb_glyph_info_t = extern struct {
    codepoint: u32,
    mask: u32,
    cluster: u32,
    _var1: u32,
    _var2: u32,
};

const hb_glyph_position_t = extern struct {
    x_advance: i32,
    y_advance: i32,
    x_offset: i32,
    y_offset: i32,
    _var: u32,
};

// HarfBuzz buffer glyph query externs.
extern fn hb_buffer_get_length(buf: *anyopaque) c_uint;
extern fn hb_buffer_get_glyph_infos(buf: *anyopaque, length: *c_uint) [*]const hb_glyph_info_t;
extern fn hb_buffer_get_glyph_positions(buf: *anyopaque, length: *c_uint) [*]const hb_glyph_position_t;

// HarfBuzz buffer manipulation externs (for layoutChars).
extern fn hb_buffer_reset(buf: *anyopaque) void;
extern fn hb_buffer_add_utf16(buf: *anyopaque, text: [*]const u16, text_length: c_int, item_offset: c_uint, item_length: c_int) void;
extern fn hb_buffer_set_direction(buf: *anyopaque, direction: c_uint) void;
extern fn hb_buffer_set_script(buf: *anyopaque, script: c_uint) void;
extern fn hb_buffer_set_language(buf: *anyopaque, language: ?*anyopaque) void;
extern fn hb_buffer_guess_segment_properties(buf: *anyopaque) void;
extern fn hb_buffer_get_segment_properties(buf: *anyopaque, props: *hb_segment_properties_t) void;

// HarfBuzz script conversion.
extern fn hb_ot_tag_to_script(tag: u32) c_uint; // hb_tag_t -> hb_script_t

// HarfBuzz shape plan externs.
const hb_shape_plan_t = opaque {};
extern fn hb_shape_plan_create_cached(face: *hb_face_t, props: *const hb_segment_properties_t, user_features: ?*anyopaque, num_user_features: c_uint, shaper_list: ?[*]const ?[*:0]const u8) ?*hb_shape_plan_t;
extern fn hb_shape_plan_create(face: *hb_face_t, props: *const hb_segment_properties_t, user_features: ?*anyopaque, num_user_features: c_uint, shaper_list: ?[*]const ?[*:0]const u8) ?*hb_shape_plan_t;
extern fn hb_shape_plan_execute(plan: *hb_shape_plan_t, font: *hb_font_t, buf: *anyopaque, features: ?*anyopaque, num_features: c_uint) c_int;
extern fn hb_shape_plan_destroy(plan: *hb_shape_plan_t) void;
extern fn hb_shape_plan_get_shaper(plan: *hb_shape_plan_t) ?[*:0]const u8;

// hb_segment_properties_t -- matches HarfBuzz struct exactly:
// direction (hb_direction_t = c_uint), script (hb_script_t = c_uint),
// language (hb_language_t = pointer), reserved1/reserved2 (pointers).
const hb_segment_properties_t = extern struct {
    direction: c_uint,
    script: c_uint,
    language: ?*anyopaque,
    reserved1: ?*anyopaque,
    reserved2: ?*anyopaque,
};

// HarfBuzz direction constants (from hb_direction_t enum).
const HB_DIRECTION_LTR: c_uint = 4;
const HB_DIRECTION_RTL: c_uint = 5;
const HB_DIRECTION_TTB: c_uint = 6;

// FloatPoint matches C typedef in tectonic_xetex_layout.h: { float x; float y; }
const FloatPoint = extern struct {
    x: f32,
    y: f32,
};

// -- Internal helpers --

fn font_units_to_points(f: *const XeTeXFont_rec, units: f64) f64 {
    return (units * @as(f64, @floatCast(f.point_size))) / @as(f64, @floatFromInt(f.units_per_em));
}

fn font_points_to_units(f: *const XeTeXFont_rec, points: f64) f64 {
    return (points * @as(f64, @floatFromInt(f.units_per_em))) / @as(f64, @floatCast(f.point_size));
}

// ========================================
// BBox cache
// ========================================

const max_cached_boxes = 65536;

const CachedBBox = struct {
    key: u32 = 0,
    bbox: GlyphBBox = .{ .x_min = 0, .y_min = 0, .x_max = 0, .y_max = 0 },
    valid: bool = false,
};

var bbox_cache: [max_cached_boxes]CachedBBox = [1]CachedBBox{.{}} ** max_cached_boxes;

export fn getCachedGlyphBBox(font_id: u16, glyph_id: u16, bbox: *GlyphBBox) i32 {
    const key: u32 = (@as(u32, font_id) << 16) | glyph_id;
    const idx = key % max_cached_boxes;
    const entry = &bbox_cache[idx];
    if (entry.valid and entry.key == key) {
        bbox.* = entry.bbox;
        return 1;
    }
    return 0;
}

export fn cacheGlyphBBox(font_id: u16, glyph_id: u16, bbox: *const GlyphBBox) void {
    const key: u32 = (@as(u32, font_id) << 16) | glyph_id;
    const idx = key % max_cached_boxes;
    bbox_cache[idx] = .{
        .key = key,
        .bbox = bbox.*,
        .valid = true,
    };
}

// ========================================
// Character protrusion codes
// ========================================

const max_cp_entries = 4096;

const CpEntry = struct {
    font_num: i32 = 0,
    code: u32 = 0,
    value: i32 = 0,
    valid: bool = false,
};

var left_prot: [max_cp_entries]CpEntry = [1]CpEntry{.{}} ** max_cp_entries;
var right_prot: [max_cp_entries]CpEntry = [1]CpEntry{.{}} ** max_cp_entries;

export fn set_cp_code(font_num: i32, code: u32, side: i32, value: i32) void {
    const table = if (side == 0) &left_prot else &right_prot;
    const idx = (@as(u32, @bitCast(font_num)) *% 31 +% code) % max_cp_entries;
    table[idx] = .{
        .font_num = font_num,
        .code = code,
        .value = value,
        .valid = true,
    };
}

export fn get_cp_code(font_num: i32, code: u32, side: i32) i32 {
    const table = if (side == 0) &left_prot else &right_prot;
    const idx = (@as(u32, @bitCast(font_num)) *% 31 +% code) % max_cp_entries;
    const entry = &table[idx];
    if (entry.valid and entry.font_num == font_num and entry.code == code)
        return entry.value;
    return 0;
}

// ========================================
// Font unit conversion
// ========================================

export fn ttxl_font_units_to_points(font: ?*XeTeXFont_rec, units: f32) f32 {
    const f = font orelse return units;
    return @floatCast(font_units_to_points(f, @as(f64, @floatCast(units))));
}

export fn ttxl_font_points_to_units(font: ?*XeTeXFont_rec, points: f32) f32 {
    const f = font orelse return points;
    return @floatCast(font_points_to_units(f, @as(f64, @floatCast(points))));
}

export fn ttxl_font_get_point_size(font: ?*XeTeXFont_rec) f32 {
    const f = font orelse return 10.0;
    return f.point_size;
}

// ========================================
// Engine accessors
// ========================================

export fn getFont(engine: ?*XeTeXLayoutEngine_rec) ?*XeTeXFont_rec {
    const e = engine orelse return null;
    return e.font;
}

export fn getExtendFactor(engine: ?*XeTeXLayoutEngine_rec) f32 {
    const e = engine orelse return 1.0;
    return e.extend;
}

export fn getSlantFactor(engine: ?*XeTeXLayoutEngine_rec) f32 {
    const e = engine orelse return 0.0;
    return e.slant;
}

export fn getEmboldenFactor(engine: ?*XeTeXLayoutEngine_rec) f32 {
    const e = engine orelse return 0.0;
    return e.embolden;
}

export fn getPointSize(engine: ?*XeTeXLayoutEngine_rec) f32 {
    const e = engine orelse return 10.0;
    const f = e.font orelse return 10.0;
    return f.point_size;
}

export fn getAscentAndDescent(engine: ?*XeTeXLayoutEngine_rec, ascent: ?*f32, descent: ?*f32) void {
    if (engine) |e| {
        if (e.font) |f| {
            if (ascent) |a| a.* = f.ascent;
            if (descent) |d| d.* = f.descent;
            return;
        }
    }
    if (ascent) |a| a.* = 0.0;
    if (descent) |d| d.* = 0.0;
}

export fn getCapAndXHeight(engine: ?*XeTeXLayoutEngine_rec, capheight: ?*f32, xheight: ?*f32) void {
    if (engine) |e| {
        if (e.font) |f| {
            if (capheight) |c| c.* = f.cap_height;
            if (xheight) |x| x.* = f.x_height;
            return;
        }
    }
    if (capheight) |c| c.* = 0.0;
    if (xheight) |x| x.* = 0.0;
}

export fn getDefaultDirection(engine: ?*XeTeXLayoutEngine_rec) c_int {
    const e = engine orelse return 0xFE; // UBIDI_DEFAULT_LTR
    const buf = e.hb_buffer orelse return 0xFE;
    const script = hb_buffer_get_script(buf);
    const dir = hb_script_get_horizontal_direction(script);
    return if (dir == 5) 0xFF else 0xFE; // 5 = HB_DIRECTION_RTL
}

export fn getRgbValue(engine: ?*XeTeXLayoutEngine_rec) u32 {
    const e = engine orelse return 0x000000FF;
    return e.rgb_value;
}

// ========================================
// loaded_font_design_size
// ========================================

var loaded_font_design_size: i32 = 655360; // 10pt in 16.16 fixed-point

export fn get_loaded_font_design_size() i32 {
    return loaded_font_design_size;
}

export fn set_loaded_font_design_size(val: i32) void {
    loaded_font_design_size = val;
}

// ========================================
// Graphite2 extern declarations
// ========================================

const gr_face_ops = extern struct {
    size: usize,
    get_table: ?*const fn (?*const anyopaque, c_uint, *usize) callconv(.c) ?*const anyopaque,
    release_table: ?*const fn (?*const anyopaque, ?*const anyopaque) callconv(.c) void,
};

extern fn gr_make_face_with_ops(app_face_handle: ?*const anyopaque, face_ops: *const gr_face_ops, face_options: c_uint) ?*anyopaque;
extern fn gr_make_font(ppm: f32, face: *const anyopaque) ?*anyopaque;
extern fn gr_face_destroy(face: *anyopaque) void;
extern fn gr_font_destroy(font: *anyopaque) void;
extern fn gr_face_n_fref(face: *const anyopaque) u16;
extern fn gr_face_fref(face: *const anyopaque, i: u16) ?*const anyopaque;
extern fn gr_face_find_fref(face: *const anyopaque, feat_id: u32) ?*const anyopaque;
extern fn gr_face_featureval_for_lang(face: *const anyopaque, langname: u32) ?*anyopaque;
extern fn gr_featureval_destroy(feats: *anyopaque) void;
extern fn gr_fref_id(fref: *const anyopaque) u32;
extern fn gr_fref_n_values(fref: *const anyopaque) u16;
extern fn gr_fref_value(fref: *const anyopaque, settingno: u16) i16;
extern fn gr_fref_feature_value(fref: *const anyopaque, feats: *const anyopaque) u16;
extern fn gr_fref_label(fref: *const anyopaque, lang_id: *u16, utf: c_uint, length: *u32) ?*anyopaque;
extern fn gr_fref_value_label(fref: *const anyopaque, settingno: u16, lang_id: *u16, utf: c_uint, length: *u32) ?*anyopaque;
extern fn gr_label_destroy(label: ?*anyopaque) void;
extern fn gr_str_to_tag(str: [*:0]const u8) u32;
extern fn gr_make_seg(font: ?*const anyopaque, face: *const anyopaque, script: u32, feats: ?*const anyopaque, enc: c_uint, start: ?*const anyopaque, n_chars: usize, dir: c_int) ?*anyopaque;
extern fn gr_seg_destroy(seg: *anyopaque) void;
extern fn gr_seg_first_slot(seg: *const anyopaque) ?*anyopaque;
extern fn gr_slot_next_in_segment(slot: *const anyopaque) ?*anyopaque;
extern fn gr_slot_attr(slot: *const anyopaque, seg: *const anyopaque, attr: c_uint, subindex: u8) c_int;

// ========================================
// Graphite2 table callback (FT_Face -> gr_face bridge)
// ========================================

fn gr_get_table(app_face_handle: ?*const anyopaque, name: c_uint, len: *usize) callconv(.c) ?*const anyopaque {
    const ft_face = @as(*anyopaque, @ptrCast(@constCast(app_face_handle orelse return null)));
    var table_len: c_ulong = 0;
    if (FT_Load_Sfnt_Table(ft_face, @intCast(name), 0, null, &table_len) != 0) return null;
    if (table_len == 0) return null;
    const buf = malloc(@intCast(table_len)) orelse return null;
    if (FT_Load_Sfnt_Table(ft_face, @intCast(name), 0, buf, &table_len) != 0) {
        free(@ptrCast(buf));
        return null;
    }
    len.* = @intCast(table_len);
    return @ptrCast(buf);
}

fn gr_release_table(_: ?*const anyopaque, table_buffer: ?*const anyopaque) callconv(.c) void {
    if (table_buffer) |buf| {
        free(@ptrCast(@constCast(buf)));
    }
}

// ========================================
// Graphite2 gr_face on-demand cache
// ========================================

const GrCacheEntry = struct {
    gr_face: *anyopaque,
    gr_font: *anyopaque,
};

var gr_cache: ?std.AutoHashMap(usize, GrCacheEntry) = null;

fn get_gr_cache() *std.AutoHashMap(usize, GrCacheEntry) {
    if (gr_cache) |*c| return c;
    gr_cache = std.AutoHashMap(usize, GrCacheEntry).init(std.heap.page_allocator);
    return &gr_cache.?;
}

fn get_or_create_gr_face(engine: *XeTeXLayoutEngine_rec) ?*anyopaque {
    const font = engine.font orelse return null;
    const ft_face = font.ft_face orelse return null;
    const key = @intFromPtr(ft_face);

    const cache = get_gr_cache();
    if (cache.get(key)) |entry| return entry.gr_face;

    const ops = gr_face_ops{
        .size = @sizeOf(gr_face_ops),
        .get_table = &gr_get_table,
        .release_table = &gr_release_table,
    };
    const gr_face_ptr = gr_make_face_with_ops(ft_face, &ops, 0) orelse return null;

    const ppm = font.point_size;
    const gr_font_ptr = gr_make_font(ppm, gr_face_ptr) orelse {
        gr_face_destroy(gr_face_ptr);
        return null;
    };

    cache.put(key, .{ .gr_face = gr_face_ptr, .gr_font = gr_font_ptr }) catch return null;
    return gr_face_ptr;
}

// ========================================
// Graphite2 feature query functions
// ========================================

export fn countGraphiteFeatures(engine: ?*XeTeXLayoutEngine_rec) u32 {
    const face = get_or_create_gr_face(engine orelse return 0) orelse return 0;
    return gr_face_n_fref(face);
}

export fn getGraphiteFeatureCode(engine: ?*XeTeXLayoutEngine_rec, idx: u32) u32 {
    const face = get_or_create_gr_face(engine orelse return 0) orelse return 0;
    const n = gr_face_n_fref(face);
    if (idx >= @as(u32, n)) return 0;
    const fref = gr_face_fref(face, @intCast(idx)) orelse return 0;
    return gr_fref_id(fref);
}

export fn countGraphiteFeatureSettings(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32) u32 {
    const face = get_or_create_gr_face(engine orelse return 0) orelse return 0;
    const fref = gr_face_find_fref(face, feat_id) orelse return 0;
    return gr_fref_n_values(fref);
}

export fn getGraphiteFeatureSettingCode(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32, idx: u32) u32 {
    const face = get_or_create_gr_face(engine orelse return 0) orelse return 0;
    const fref = gr_face_find_fref(face, feat_id) orelse return 0;
    const n = gr_fref_n_values(fref);
    if (idx >= @as(u32, n)) return 0;
    return @bitCast(@as(i32, gr_fref_value(fref, @intCast(idx))));
}

export fn getGraphiteFeatureDefaultSetting(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32) u32 {
    const face = get_or_create_gr_face(engine orelse return 0) orelse return 0;
    const fref = gr_face_find_fref(face, feat_id) orelse return 0;
    const feats = gr_face_featureval_for_lang(face, 0) orelse return 0;
    defer gr_featureval_destroy(feats);
    return gr_fref_feature_value(fref, feats);
}

export fn getGraphiteFeatureLabel(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32) ?[*:0]const u8 {
    const face = get_or_create_gr_face(engine orelse return null) orelse return null;
    const fref = gr_face_find_fref(face, feat_id) orelse return null;
    var lang_id: u16 = 0x0409;
    var length: u32 = 0;
    const label = gr_fref_label(fref, &lang_id, 1, &length) orelse return null;
    return @ptrCast(label);
}

export fn getGraphiteFeatureSettingLabel(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32, idx: u32) ?[*:0]const u8 {
    const face = get_or_create_gr_face(engine orelse return null) orelse return null;
    const fref = gr_face_find_fref(face, feat_id) orelse return null;
    var lang_id: u16 = 0x0409;
    var length: u32 = 0;
    const label = gr_fref_value_label(fref, @intCast(idx), &lang_id, 1, &length) orelse return null;
    return @ptrCast(label);
}

export fn findGraphiteFeature(
    engine: ?*XeTeXLayoutEngine_rec,
    s: ?[*]const u8,
    e: ?[*]const u8,
    feat: ?*u32,
    val: ?*c_int,
) bool {
    const face = get_or_create_gr_face(engine orelse return false) orelse return false;
    const start = s orelse return false;
    const end = e orelse return false;
    var tag_buf: [4:0]u8 = .{ 0, 0, 0, 0 };
    const len = @min(@intFromPtr(end) - @intFromPtr(start), 4);
    @memcpy(tag_buf[0..len], start[0..len]);
    const tag = gr_str_to_tag(&tag_buf);
    const fref = gr_face_find_fref(face, tag) orelse return false;
    const feats = gr_face_featureval_for_lang(face, 0) orelse return false;
    defer gr_featureval_destroy(feats);
    if (feat) |f| f.* = tag;
    if (val) |v| v.* = @intCast(gr_fref_feature_value(fref, feats));
    return true;
}

export fn findGraphiteFeatureNamed(engine: ?*XeTeXLayoutEngine_rec, name: ?[*]const u8, name_len: c_int) c_long {
    const face = get_or_create_gr_face(engine orelse return -1) orelse return -1;
    const s = name orelse return -1;
    const slen: usize = if (name_len >= 0) @intCast(name_len) else return -1;
    const n = gr_face_n_fref(face);
    var i: u16 = 0;
    while (i < n) : (i += 1) {
        const fref = gr_face_fref(face, i) orelse continue;
        var lang_id: u16 = 0x0409;
        var label_len: u32 = 0;
        const label = gr_fref_label(fref, &lang_id, 1, &label_len) orelse continue;
        defer gr_label_destroy(label);
        const label_str: [*]const u8 = @ptrCast(label);
        if (label_len == @as(u32, @intCast(slen)) and
            std.mem.eql(u8, label_str[0..label_len], s[0..slen]))
        {
            return @intCast(gr_fref_id(fref));
        }
    }
    return -1;
}

export fn findGraphiteFeatureSettingNamed(engine: ?*XeTeXLayoutEngine_rec, feat_id: u32, name: ?[*]const u8, name_len: c_int) c_long {
    const face = get_or_create_gr_face(engine orelse return -1) orelse return -1;
    const s = name orelse return -1;
    const slen: usize = if (name_len >= 0) @intCast(name_len) else return -1;
    const fref = gr_face_find_fref(face, feat_id) orelse return -1;
    const n = gr_fref_n_values(fref);
    var i: u16 = 0;
    while (i < n) : (i += 1) {
        var lang_id: u16 = 0x0409;
        var label_len: u32 = 0;
        const label = gr_fref_value_label(fref, i, &lang_id, 1, &label_len) orelse continue;
        defer gr_label_destroy(label);
        const label_str: [*]const u8 = @ptrCast(label);
        if (label_len == @as(u32, @intCast(slen)) and
            std.mem.eql(u8, label_str[0..slen], s[0..slen]))
        {
            return @intCast(gr_fref_value(fref, i));
        }
    }
    return -1;
}

export fn initGraphiteBreaking(_: ?*XeTeXLayoutEngine_rec, _: ?[*]const u16, _: c_uint) bool {
    return false;
}

export fn findNextGraphiteBreak(_: ?*XeTeXLayoutEngine_rec) c_int {
    return 0;
}

// ========================================
// Phase 1b: req_engine global
// ========================================

var req_engine: u8 = 0;

export fn getReqEngine() c_char {
    return @bitCast(req_engine);
}

export fn setReqEngine(engine: c_char) void {
    req_engine = @bitCast(engine);
}

// ========================================
// Phase 1b: Shaper queries
// ========================================

extern fn strcmp(a: [*:0]const u8, b: [*:0]const u8) c_int;

export fn usingGraphite(engine: ?*XeTeXLayoutEngine_rec) bool {
    const e = engine orelse return false;
    // Check used_shaper first (set after layoutChars)
    if (e.used_shaper) |shaper| {
        return strcmp(shaper, "graphite2") == 0;
    }
    // Fallback: check shaper_list[0] (set at engine creation for /GR fonts)
    if (e.shaper_list) |list_raw| {
        const list: [*]const ?[*:0]const u8 = @ptrCast(@alignCast(list_raw));
        if (list[0]) |first| {
            return strcmp(first, "graphite2") == 0;
        }
    }
    return false;
}

export fn usingOpenType(engine: ?*XeTeXLayoutEngine_rec) bool {
    const e = engine orelse return false;
    const shaper = e.used_shaper orelse return false;
    return strcmp(shaper, "ot") == 0;
}

// ========================================
// Phase 1b: Font filename
// ========================================

extern fn strdup(s: [*:0]const u8) ?[*:0]u8;
extern fn free(ptr: ?*anyopaque) void;

export fn getFontFilename(engine: ?*XeTeXLayoutEngine_rec, index: ?*u32) ?[*:0]const u8 {
    const e = engine orelse {
        if (index) |p| p.* = 0;
        return null;
    };
    const font = e.font orelse {
        if (index) |p| p.* = 0;
        return null;
    };
    if (index) |p| p.* = font.index;
    const fname = font.filename orelse return null;
    return strdup(fname);
}

export fn freeFontFilename(filename: ?[*:0]const u8) void {
    // strdup returns mutable; cast back for free (matches C: free((void*)filename))
    const ptr: ?*anyopaque = if (filename) |p| @ptrCast(@constCast(p)) else null;
    free(ptr);
}

// ========================================
// Phase 1b: Design size
// ========================================

export fn getDesignSize(_: ?*XeTeXFont_rec) f64 {
    return 10.0;
}

// ========================================
// Phase 2: OpenType query functions
// ========================================

// -- Opaque HarfBuzz types (pointer targets only, never dereferenced in Zig) --
const hb_font_t = opaque {};
const hb_face_t = opaque {};

// -- HarfBuzz tag construction (big-endian fourcc, matches HB_TAG macro) --
fn hb_tag(a: u8, b: u8, c: u8, d: u8) u32 {
    return (@as(u32, a) << 24) | (@as(u32, b) << 16) | (@as(u32, c) << 8) | @as(u32, d);
}

const HB_OT_TAG_GSUB = hb_tag('G', 'S', 'U', 'B'); // 0x47535542
const HB_OT_TAG_GPOS = hb_tag('G', 'P', 'O', 'S'); // 0x47504F53

// -- HarfBuzz extern declarations (resolved at link time) --
extern fn hb_font_get_face(*hb_font_t) ?*hb_face_t;
extern fn hb_ot_math_has_data(*hb_face_t) c_int;
extern fn hb_ot_layout_table_get_script_tags(*hb_face_t, u32, c_uint, *c_uint, ?[*]u32) c_uint;
extern fn hb_ot_layout_table_find_script(*hb_face_t, u32, u32, *c_uint) c_int;
extern fn hb_ot_layout_script_get_language_tags(*hb_face_t, u32, c_uint, c_uint, *c_uint, ?[*]u32) c_uint;
extern fn hb_ot_layout_script_select_language(*hb_face_t, u32, c_uint, c_uint, [*]const u32, *c_uint) c_int;
extern fn hb_ot_layout_language_get_feature_tags(*hb_face_t, u32, c_uint, c_uint, c_uint, *c_uint, ?[*]u32) c_uint;

// -- FreeType extern (FT_Load_Sfnt_Table) --
// FT_Face is opaque here (stored as ?*anyopaque in XeTeXFont_rec).
// FT_ULong = unsigned long = c_ulong, FT_Long = long = c_long, FT_Error = int = c_int.
extern fn FT_Load_Sfnt_Table(*anyopaque, c_ulong, c_long, ?[*]u8, *c_ulong) c_int;

// -- Phase 2 internal helpers --

fn get_hb_face_from_font(font: ?*XeTeXFont_rec) ?*hb_face_t {
    const f = font orelse return null;
    const hb: *hb_font_t = @ptrCast(f.hb_font orelse return null);
    return hb_font_get_face(hb);
}

// Pick the larger of GSUB/GPOS script tables (same logic as C).
fn get_ot_table_tag(face: *hb_face_t) u32 {
    var gsub_count: c_uint = 0;
    var gpos_count: c_uint = 0;
    _ = hb_ot_layout_table_get_script_tags(face, HB_OT_TAG_GSUB, 0, &gsub_count, null);
    _ = hb_ot_layout_table_get_script_tags(face, HB_OT_TAG_GPOS, 0, &gpos_count, null);
    return if (gsub_count > gpos_count) HB_OT_TAG_GSUB else HB_OT_TAG_GPOS;
}

// -- Phase 2 exported functions --

export fn hasFontTable(font: ?*XeTeXFont_rec, table_tag: u32) bool {
    const f = font orelse return false;
    const face: *anyopaque = f.ft_face orelse return false;
    var length: c_ulong = 0;
    const err = FT_Load_Sfnt_Table(face, @intCast(table_tag), 0, null, &length);
    return err == 0 and length > 0;
}

export fn setFontLayoutDir(font: ?*XeTeXFont_rec, vertical: c_int) void {
    const f = font orelse return;
    f.vertical = if (vertical != 0) 1 else 0;
}

export fn countScripts(font: ?*XeTeXFont_rec) c_uint {
    const face = get_hb_face_from_font(font) orelse return 0;
    var gsub_count: c_uint = 0;
    var gpos_count: c_uint = 0;
    _ = hb_ot_layout_table_get_script_tags(face, HB_OT_TAG_GSUB, 0, &gsub_count, null);
    _ = hb_ot_layout_table_get_script_tags(face, HB_OT_TAG_GPOS, 0, &gpos_count, null);
    return if (gsub_count > gpos_count) gsub_count else gpos_count;
}

export fn getIndScript(font: ?*XeTeXFont_rec, index: c_uint) u32 {
    const face = get_hb_face_from_font(font) orelse return 0;
    const table_tag = get_ot_table_tag(face);
    var tags = [1]u32{0};
    var count: c_uint = 1;
    _ = hb_ot_layout_table_get_script_tags(face, table_tag, index, &count, &tags);
    return if (count == 0) 0 else tags[0];
}

export fn countLanguages(font: ?*XeTeXFont_rec, script: u32) c_uint {
    const face = get_hb_face_from_font(font) orelse return 0;
    const table_tag = get_ot_table_tag(face);
    var script_index: c_uint = 0;
    if (hb_ot_layout_table_find_script(face, table_tag, script, &script_index) == 0)
        return 0;
    var lang_count: c_uint = 0;
    _ = hb_ot_layout_script_get_language_tags(face, table_tag, script_index, 0, &lang_count, null);
    return lang_count;
}

export fn getIndLanguage(font: ?*XeTeXFont_rec, script: u32, index: c_uint) u32 {
    const face = get_hb_face_from_font(font) orelse return 0;
    const table_tag = get_ot_table_tag(face);
    var script_index: c_uint = 0;
    if (hb_ot_layout_table_find_script(face, table_tag, script, &script_index) == 0)
        return 0;
    var tags = [1]u32{0};
    var count: c_uint = 1;
    _ = hb_ot_layout_script_get_language_tags(face, table_tag, script_index, index, &count, &tags);
    return if (count == 0) 0 else tags[0];
}

export fn countFeatures(font: ?*XeTeXFont_rec, script: u32, language: u32) c_uint {
    const face = get_hb_face_from_font(font) orelse return 0;
    const table_tags = [2]u32{ HB_OT_TAG_GSUB, HB_OT_TAG_GPOS };
    var rval: c_uint = 0;
    for (table_tags) |table_tag| {
        var script_index: c_uint = 0;
        if (hb_ot_layout_table_find_script(face, table_tag, script, &script_index) == 0)
            continue;
        const lang_arr = [1]u32{language};
        var lang_index: c_uint = 0;
        const found = hb_ot_layout_script_select_language(face, table_tag, script_index, 1, &lang_arr, &lang_index);
        if (found == 0 and language != 0) continue;
        var feat_count: c_uint = 0;
        _ = hb_ot_layout_language_get_feature_tags(face, table_tag, script_index, lang_index, 0, &feat_count, null);
        rval += feat_count;
    }
    return rval;
}

export fn getIndFeature(font: ?*XeTeXFont_rec, script: u32, language: u32, index: c_uint) u32 {
    const face = get_hb_face_from_font(font) orelse return 0;
    const table_tags = [2]u32{ HB_OT_TAG_GSUB, HB_OT_TAG_GPOS };
    var idx = index;
    for (table_tags) |table_tag| {
        var script_index: c_uint = 0;
        if (hb_ot_layout_table_find_script(face, table_tag, script, &script_index) == 0)
            continue;
        const lang_arr = [1]u32{language};
        var lang_index: c_uint = 0;
        const found = hb_ot_layout_script_select_language(face, table_tag, script_index, 1, &lang_arr, &lang_index);
        if (found == 0 and language != 0) continue;
        var feat_count: c_uint = 0;
        _ = hb_ot_layout_language_get_feature_tags(face, table_tag, script_index, lang_index, 0, &feat_count, null);
        if (idx < feat_count) {
            var ftags = [1]u32{0};
            var fcount: c_uint = 1;
            _ = hb_ot_layout_language_get_feature_tags(face, table_tag, script_index, lang_index, idx, &fcount, &ftags);
            return if (fcount > 0) ftags[0] else 0;
        }
        idx -= feat_count;
    }
    return 0;
}

export fn isOpenTypeMathFont(engine: ?*XeTeXLayoutEngine_rec) bool {
    const e = engine orelse return false;
    const f = e.font orelse return false;
    const hb: *hb_font_t = @ptrCast(f.hb_font orelse return false);
    const face = hb_font_get_face(hb) orelse return false;
    return hb_ot_math_has_data(face) != 0;
}

export fn ttxl_get_hb_font(engine: ?*XeTeXLayoutEngine_rec) ?*hb_font_t {
    const e = engine orelse return null;
    const f = e.font orelse return null;
    return @ptrCast(f.hb_font);
}

// ========================================
// Phase 2b: Font metric functions (getSlant, getGlyphName, freeGlyphName)
// ========================================

// -- Fixed-point 16.16 conversion (matches C d_to_fix) --
fn d_to_fix(d: f64) i32 {
    return @intFromFloat(d * 65536.0 + 0.5);
}

// -- FreeType embedded struct types (used inside FT_FaceRec_ layout) --

// FT_Generic: { void* data; void (*finalizer)(void*); } -- 2 pointer-sized fields.
const FT_Generic = extern struct {
    data: ?*anyopaque,
    finalizer: ?*const fn (?*anyopaque) callconv(.c) void,
};

// FT_BBox with FT_Pos (c_long) fields -- used by FT_Glyph_Get_CBox and embedded in FT_FaceRec_.
const FT_BBox_Long = extern struct {
    x_min: c_long,
    y_min: c_long,
    x_max: c_long,
    y_max: c_long,
};

// -- Partial FT_FaceRec_ layout (all fields through `glyph`) --
// FT_FaceRec_ field order verified against FreeType 2.13 freetype.h (~line 1229).
// FT_Long = c_long, FT_Int = c_int, FT_UShort = c_ushort, FT_Short = c_short.
// On LP64 (macOS ARM64): c_long = i64, pointers = 8 bytes. glyph at offset 152.
// On ILP32 (WASM32): c_long = i32, pointers = 4 bytes. glyph at offset 84.
// Assumption: only fields up to `glyph` are accessed. Layout is portable via extern struct
// which follows C ABI padding rules on all targets.
const FT_FacePartial = extern struct {
    num_faces: c_long,
    face_index: c_long,
    face_flags: c_long,
    style_flags: c_long,
    num_glyphs: c_long,
    family_name: ?[*:0]u8,
    style_name: ?[*:0]u8,
    num_fixed_sizes: c_int,
    available_sizes: ?*anyopaque,
    num_charmaps: c_int,
    charmaps: ?*anyopaque,
    generic: FT_Generic,
    bbox: FT_BBox_Long,
    units_per_em: c_ushort,
    ascender: c_short,
    descender: c_short,
    height: c_short,
    max_advance_width: c_short,
    max_advance_height: c_short,
    underline_position: c_short,
    underline_thickness: c_short,
    glyph: ?*anyopaque, // FT_GlyphSlot (pointer to FT_GlyphSlotRec_)
};
const FT_FACE_FLAG_GLYPH_NAMES: c_long = 1 << 9;

fn ft_has_glyph_names(face_ptr: *anyopaque) bool {
    const face: *const FT_FacePartial = @ptrCast(@alignCast(face_ptr));
    return (face.face_flags & FT_FACE_FLAG_GLYPH_NAMES) != 0;
}

// -- FreeType extern (FT_Get_Glyph_Name) --
// FT_UInt = unsigned int = c_uint
extern fn FT_Get_Glyph_Name(*anyopaque, c_uint, [*]u8, c_uint) c_int;

// -- libc externs (free already declared above) --
extern fn malloc(usize) ?[*]u8;
extern fn memcpy([*]u8, [*]const u8, usize) [*]u8;

export fn getSlant(font: ?*XeTeXFont_rec) i32 {
    const f = font orelse return 0;
    const angle: f64 = @floatCast(f.italic_angle);
    return d_to_fix(std.math.tan(-angle * std.math.pi / 180.0));
}

export fn getGlyphName(font: ?*XeTeXFont_rec, gid: u16, len: ?*c_int) ?[*]const u8 {
    const f = font orelse {
        if (len) |p| p.* = 0;
        return null;
    };
    const face = f.ft_face orelse {
        if (len) |p| p.* = 0;
        return null;
    };
    if (!ft_has_glyph_names(face)) {
        if (len) |p| p.* = 0;
        return null;
    }

    var buf: [256]u8 = undefined;
    const err = FT_Get_Glyph_Name(face, @as(c_uint, gid), &buf, 256);
    if (err != 0 or buf[0] == 0) {
        if (len) |p| p.* = 0;
        return null;
    }

    const slen = strlen(@ptrCast(&buf));
    const result = malloc(slen + 1) orelse {
        if (len) |p| p.* = 0;
        return null;
    };
    _ = memcpy(result, @ptrCast(&buf), slen + 1);
    if (len) |p| p.* = @intCast(slen);
    return result;
}

export fn freeGlyphName(name: ?[*]u8) void {
    const ptr: ?*anyopaque = if (name) |p| @ptrCast(p) else null;
    free(ptr);
}

// ========================================
// Phase 2c: countGlyphs, getGlyphWidth
// ========================================

// FT_Get_Advance: returns advance in font units when FT_LOAD_NO_SCALE is set.
// Despite the FT_Fixed return type, with NO_SCALE the value is raw font units (not 16.16).
// Signature: FT_Error FT_Get_Advance(FT_Face, FT_UInt gindex, FT_Int32 load_flags, FT_Fixed *padvance)
extern fn FT_Get_Advance(face: *anyopaque, gindex: c_uint, load_flags: i32, padvance: *c_long) c_int;

const FT_LOAD_NO_SCALE: i32 = 1 << 0;

export fn countGlyphs(font: ?*XeTeXFont_rec) c_uint {
    const f = font orelse return 0;
    const face_ptr: *anyopaque = f.ft_face orelse return 0;
    const face: *const FT_FacePartial = @ptrCast(@alignCast(face_ptr));
    return @intCast(face.num_glyphs);
}

export fn getGlyphWidth(font: ?*XeTeXFont_rec, gid: u32) f32 {
    const f = font orelse return 0.0;
    const face: *anyopaque = f.ft_face orelse return 0.0;
    var advance: c_long = 0;
    const err = FT_Get_Advance(face, @intCast(gid), FT_LOAD_NO_SCALE, &advance);
    if (err != 0) return 0.0;
    return @floatCast(font_units_to_points(f, @floatFromInt(advance)));
}

// ========================================
// Phase 2d: Engine glyph queries
// ========================================

// FreeType extern functions for glyph bounds computation.
// FT_Load_Glyph populates face->glyph (the glyph slot).
// FT_Get_Glyph extracts a standalone glyph object from the slot.
// FT_Glyph_Get_CBox computes the bounding box of a glyph object.
// FT_Done_Glyph frees the standalone glyph object.
extern fn FT_Load_Glyph(face: *anyopaque, glyph_index: c_uint, load_flags: i32) c_int;
extern fn FT_Get_Glyph(slot: *anyopaque, aglyph: *?*anyopaque) c_int;
extern fn FT_Glyph_Get_CBox(glyph: *anyopaque, bbox_mode: c_uint, acbox: *FT_BBox_Long) void;
extern fn FT_Done_Glyph(glyph: ?*anyopaque) void;

const FT_GLYPH_BBOX_UNSCALED: c_uint = 0;

// Internal helper: compute glyph bounding box in points (matches C get_glyph_bounds_internal).
// Uses FT_Load_Glyph + FT_Get_Glyph + FT_Glyph_Get_CBox to avoid accessing FT_GlyphSlotRec_
// fields directly. Only accesses face->glyph pointer via FT_FacePartial.
fn get_glyph_bounds_internal(font: ?*XeTeXFont_rec, gid: u16) GlyphBBox {
    const zero: GlyphBBox = .{ .x_min = 0, .y_min = 0, .x_max = 0, .y_max = 0 };
    const f = font orelse return zero;
    const face_ptr: *anyopaque = f.ft_face orelse return zero;

    // Load glyph at NO_SCALE to get raw font units.
    if (FT_Load_Glyph(face_ptr, @as(c_uint, gid), FT_LOAD_NO_SCALE) != 0) return zero;

    // Access face->glyph (the glyph slot pointer) via partial struct layout.
    const face: *const FT_FacePartial = @ptrCast(@alignCast(face_ptr));
    const slot: *anyopaque = face.glyph orelse return zero;

    // Extract standalone glyph object from slot and compute its cbox.
    var glyph_obj: ?*anyopaque = null;
    if (FT_Get_Glyph(slot, &glyph_obj) != 0) return zero;
    const glyph = glyph_obj orelse return zero;

    var ft_bbox: FT_BBox_Long = .{ .x_min = 0, .y_min = 0, .x_max = 0, .y_max = 0 };
    FT_Glyph_Get_CBox(glyph, FT_GLYPH_BBOX_UNSCALED, &ft_bbox);
    FT_Done_Glyph(glyph);

    // Convert from font units to points.
    return .{
        .x_min = @floatCast(font_units_to_points(f, @floatFromInt(ft_bbox.x_min))),
        .y_min = @floatCast(font_units_to_points(f, @floatFromInt(ft_bbox.y_min))),
        .x_max = @floatCast(font_units_to_points(f, @floatFromInt(ft_bbox.x_max))),
        .y_max = @floatCast(font_units_to_points(f, @floatFromInt(ft_bbox.y_max))),
    };
}

export fn getGlyphWidthFromEngine(engine: ?*XeTeXLayoutEngine_rec, gid: u32) f32 {
    const e = engine orelse return 0.0;
    const font = e.font orelse return 0.0;
    return e.extend * getGlyphWidth(font, gid);
}

export fn getGlyphBounds(engine: ?*XeTeXLayoutEngine_rec, gid: u32, bbox: ?*GlyphBBox) void {
    const b = bbox orelse return;
    const e = engine orelse return;
    b.* = get_glyph_bounds_internal(e.font, @intCast(gid));
    if (e.extend != 0.0) {
        b.x_min *= e.extend;
        b.x_max *= e.extend;
    }
}

export fn getGlyphHeightDepth(engine: ?*XeTeXLayoutEngine_rec, gid: u32, height: ?*f32, depth: ?*f32) void {
    if (engine) |e| {
        if (e.font != null) {
            const bb = get_glyph_bounds_internal(e.font, @intCast(gid));
            if (height) |h| h.* = bb.y_max;
            if (depth) |d| d.* = -bb.y_min;
            return;
        }
    }
    if (height) |h| h.* = 0.0;
    if (depth) |d| d.* = 0.0;
}

export fn getGlyphSidebearings(engine: ?*XeTeXLayoutEngine_rec, gid: u32, lsb: ?*f32, rsb: ?*f32) void {
    if (engine) |e| {
        if (e.font) |font| {
            const width = getGlyphWidth(font, gid);
            const bb = get_glyph_bounds_internal(font, @intCast(gid));
            if (lsb) |l| l.* = bb.x_min;
            if (rsb) |r| r.* = width - bb.x_max;
            if (e.extend != 0.0) {
                if (lsb) |l| l.* *= e.extend;
                if (rsb) |r| r.* *= e.extend;
            }
            return;
        }
    }
    if (lsb) |l| l.* = 0.0;
    if (rsb) |r| r.* = 0.0;
}

export fn getGlyphItalCorr(engine: ?*XeTeXLayoutEngine_rec, gid: u32) f32 {
    const e = engine orelse return 0.0;
    const font = e.font orelse return 0.0;
    const width = getGlyphWidth(font, gid);
    const bb = get_glyph_bounds_internal(font, @intCast(gid));
    const corr: f32 = if (bb.x_max > width) bb.x_max - width else 0.0;
    return e.extend * corr;
}

// ========================================
// Phase 2e: Font char mapping helpers
// ========================================

// FreeType charmap externs (resolved at link time).
// FT_ULong = c_ulong, FT_UInt = c_uint.
// FT_Get_Char_Index: maps Unicode codepoint -> glyph index (0 = undefined).
// FT_Get_First_Char / FT_Get_Next_Char: iterate charmap entries.
// FT_Get_Name_Index: maps PostScript glyph name -> glyph index (0 = undefined).
extern fn FT_Get_Char_Index(face: *anyopaque, charcode: c_ulong) c_uint;
extern fn FT_Get_First_Char(face: *anyopaque, agindex: *c_uint) c_ulong;
extern fn FT_Get_Next_Char(face: *anyopaque, char_code: c_ulong, agindex: *c_uint) c_ulong;
extern fn FT_Get_Name_Index(face: *anyopaque, glyph_name: [*:0]const u8) c_uint;

export fn mapCharToGlyph(engine: ?*XeTeXLayoutEngine_rec, char_code: u32) u32 {
    const e = engine orelse return 0;
    const font = e.font orelse return 0;
    const face: *anyopaque = font.ft_face orelse return 0;
    return @intCast(FT_Get_Char_Index(face, @intCast(char_code)));
}

export fn getFontCharRange(engine: ?*XeTeXLayoutEngine_rec, req_first: c_int) c_int {
    const e = engine orelse return 0;
    const font = e.font orelse return 0;
    const face: *anyopaque = font.ft_face orelse return 0;

    var gindex: c_uint = 0;
    if (req_first != 0) {
        // Return the first mapped character codepoint.
        const ch = FT_Get_First_Char(face, &gindex);
        return @intCast(ch);
    } else {
        // Walk the full charmap to find the last mapped codepoint.
        var ch = FT_Get_First_Char(face, &gindex);
        var prev = ch;
        while (gindex != 0) {
            prev = ch;
            ch = FT_Get_Next_Char(face, ch, &gindex);
        }
        return @intCast(prev);
    }
}

export fn mapGlyphToIndex(engine: ?*XeTeXLayoutEngine_rec, glyph_name: ?[*:0]const u8) c_int {
    const e = engine orelse return 0;
    const font = e.font orelse return 0;
    const face: *anyopaque = font.ft_face orelse return 0;
    const name = glyph_name orelse return 0;
    return @intCast(FT_Get_Name_Index(face, name));
}

// ========================================
// Phase 2f: Layout engine lifecycle
// ========================================

// hb_feature_t: extern struct matching HarfBuzz layout (4 x u32 = 16 bytes).
const hb_feature_t = extern struct {
    tag: u32,
    value: u32,
    start: c_uint,
    end: c_uint,
};

// HarfBuzz externs for engine lifecycle (resolved at link time).
extern fn hb_tag_from_string(str: [*]const u8, len: c_int) u32;
extern fn hb_ot_tag_to_language(tag: u32) ?*anyopaque; // hb_language_t
extern fn hb_buffer_create() ?*anyopaque; // hb_buffer_t*
extern fn hb_buffer_destroy(buf: *anyopaque) void;

// libc calloc (malloc/free/strdup/memcpy already declared above).
extern fn calloc(nmemb: usize, size: usize) ?[*]u8;

fn create_engine_common(
    font: ?*XeTeXFont_rec,
    owns_font: c_int,
    script: u32,
    language: ?[*:0]u8,
    features: ?[*]const hb_feature_t,
    n_features: c_int,
    shapers: ?[*]const ?[*:0]const u8,
    rgb_value: u32,
    extend: f32,
    slant: f32,
    embolden: f32,
) ?*XeTeXLayoutEngine_rec {
    const raw = calloc(1, @sizeOf(XeTeXLayoutEngine_rec)) orelse return null;
    const e: *XeTeXLayoutEngine_rec = @ptrCast(@alignCast(raw));

    e.font = font;
    e.owns_font = owns_font;
    e.script = script;
    e.rgb_value = rgb_value;
    e.extend = extend;
    e.slant = slant;
    e.embolden = embolden;

    // Parse language tag (same as C: hb_tag_from_string -> hb_ot_tag_to_language).
    // Default (calloc zero) = null = HB_LANGUAGE_INVALID.
    if (language) |lang| {
        e.language = hb_ot_tag_to_language(hb_tag_from_string(@ptrCast(lang), -1));
    }

    // Clone features array.
    if (features) |feat_ptr| {
        if (n_features > 0) {
            const n: usize = @intCast(n_features);
            const nbytes = n * @sizeOf(hb_feature_t);
            if (malloc(nbytes)) |mem| {
                _ = memcpy(mem, @ptrCast(feat_ptr), nbytes);
                e.features = @ptrCast(mem);
                e.n_features = n_features;
            }
        }
    }

    // Clone shaper list (null-terminated array of strdup'd strings).
    if (shapers) |shaper_ptr| {
        var count: usize = 0;
        while (shaper_ptr[count] != null) : (count += 1) {}
        const list_bytes = (count + 1) * @sizeOf(?[*:0]u8);
        if (malloc(list_bytes)) |list_raw| {
            const list: [*]?[*:0]u8 = @ptrCast(@alignCast(list_raw));
            for (0..count) |i| {
                list[i] = if (shaper_ptr[i]) |s| strdup(s) else null;
            }
            list[count] = null;
            e.shaper_list = @ptrCast(list_raw);
            e.n_shapers = @intCast(count);
        }
    }

    e.hb_buffer = hb_buffer_create();
    return e;
}

export fn createLayoutEngine(
    font: ?*XeTeXFont_rec,
    script: u32,
    language: ?[*:0]u8,
    features: ?[*]const hb_feature_t,
    n_features: c_int,
    shapers: ?[*]const ?[*:0]const u8,
    rgb_value: u32,
    extend: f32,
    slant: f32,
    embolden: f32,
) ?*XeTeXLayoutEngine_rec {
    return create_engine_common(font, 1, script, language, features, n_features, shapers, rgb_value, extend, slant, embolden);
}

export fn createLayoutEngineBorrowed(
    font: ?*XeTeXFont_rec,
    script: u32,
    language: ?[*:0]u8,
    features: ?[*]const hb_feature_t,
    n_features: c_int,
    shapers: ?[*]const ?[*:0]const u8,
    rgb_value: u32,
    extend: f32,
    slant: f32,
    embolden: f32,
) ?*XeTeXLayoutEngine_rec {
    return create_engine_common(font, 0, script, language, features, n_features, shapers, rgb_value, extend, slant, embolden);
}

export fn deleteLayoutEngine(engine: ?*XeTeXLayoutEngine_rec) void {
    const e = engine orelse return;
    if (e.owns_font != 0 and e.font != null) deleteFont(e.font);
    free(e.features);
    if (e.shaper_list) |list_raw| {
        const list: [*]?[*:0]u8 = @ptrCast(@alignCast(list_raw));
        const n: usize = if (e.n_shapers > 0) @intCast(e.n_shapers) else 0;
        for (0..n) |i| {
            if (list[i]) |s| {
                const ptr: ?*anyopaque = @ptrCast(s);
                free(ptr);
            }
        }
        free(list_raw);
    }
    if (e.used_shaper) |shaper| {
        const ptr: ?*anyopaque = @ptrCast(@constCast(shaper));
        free(ptr);
    }
    if (e.hb_buffer) |buf| hb_buffer_destroy(buf);
    free(@ptrCast(e));
}

// ========================================
// Phase 2g: Font creation and deletion
// ========================================

// -- Fixed-point 16.16 inverse: FT_Fixed/Fixed -> f64 --
fn fix_to_d(f: i32) f64 {
    return @as(f64, @floatFromInt(f)) / 65536.0;
}

// -- FreeType face flag constants --
const FT_FACE_FLAG_SCALABLE: c_long = 1 << 0;
const FT_FACE_FLAG_SFNT: c_long = 1 << 3;

// -- FreeType SFNT table tags --
const FT_SFNT_OS2: c_int = 2;
const FT_SFNT_POST: c_int = 5;

// -- FT_Open_Args for AFM attach --
const FT_OPEN_MEMORY: c_uint = 0x1;

const FT_Open_Args = extern struct {
    flags: c_uint,
    memory_base: ?[*]const u8,
    memory_size: c_long,
    pathname: ?[*:0]const u8,
    stream: ?*anyopaque,
    driver: ?*anyopaque,
    num_params: c_int,
    params: ?*anyopaque,
};

// -- TT_OS2 partial (through sCapHeight, field offset 68 on all platforms) --
// Fields: version(u16), xAvgCharWidth(i16), usWeightClass(u16), usWidthClass(u16),
// fsType(u16), ySubscriptXSize(i16), ySubscriptYSize(i16), ySubscriptXOffset(i16),
// ySubscriptYOffset(i16), ySuperscriptXSize(i16), ySuperscriptYSize(i16),
// ySuperscriptXOffset(i16), ySuperscriptYOffset(i16), yStrikeoutSize(i16),
// yStrikeoutPosition(i16), sFamilyClass(i16), panose[10](u8), ulUnicodeRange1-4(u32),
// achVendID[4](u8), fsSelection(u16), usFirstCharIndex(u16), usLastCharIndex(u16),
// sTypoAscender(i16), sTypoDescender(i16), sTypoLineGap(i16), usWinAscent(u16),
// usWinDescent(u16), ulCodePageRange1(u32), ulCodePageRange2(u32),
// sxHeight(i16), sCapHeight(i16)
const TT_OS2_Partial = extern struct {
    version: u16,
    x_avg_char_width: i16,
    us_weight_class: u16,
    us_width_class: u16,
    fs_type: u16,
    y_subscript_x_size: i16,
    y_subscript_y_size: i16,
    y_subscript_x_offset: i16,
    y_subscript_y_offset: i16,
    y_superscript_x_size: i16,
    y_superscript_y_size: i16,
    y_superscript_x_offset: i16,
    y_superscript_y_offset: i16,
    y_strikeout_size: i16,
    y_strikeout_position: i16,
    s_family_class: i16,
    panose: [10]u8,
    ul_unicode_range1: u32,
    ul_unicode_range2: u32,
    ul_unicode_range3: u32,
    ul_unicode_range4: u32,
    ach_vend_id: [4]u8,
    fs_selection: u16,
    us_first_char_index: u16,
    us_last_char_index: u16,
    s_typo_ascender: i16,
    s_typo_descender: i16,
    s_typo_line_gap: i16,
    us_win_ascent: u16,
    us_win_descent: u16,
    ul_code_page_range1: u32,
    ul_code_page_range2: u32,
    sx_height: i16,
    s_cap_height: i16,
};

// -- TT_Postscript partial (first two fields: FormatType + italicAngle, both FT_Fixed = c_long) --
const TT_Postscript_Partial = extern struct {
    format_type: c_long,
    italic_angle: c_long,
};

// -- Tectonic bridge I/O file format constants --
const TTBC_FILE_FORMAT_OPEN_TYPE: c_int = 47;
const TTBC_FILE_FORMAT_TRUE_TYPE: c_int = 36;
const TTBC_FILE_FORMAT_TYPE1: c_int = 32;
const TTBC_FILE_FORMAT_AFM: c_int = 4;

// -- FreeType externs (Phase 2g) --
extern fn FT_New_Memory_Face(library: *anyopaque, file_base: [*]const u8, file_size: c_long, face_index: c_long, aface: *?*anyopaque) c_int;
extern fn FT_Done_Face(face: *anyopaque) c_int;
extern fn FT_Get_Sfnt_Table(face: *anyopaque, tag: c_int) ?*anyopaque;
extern fn FT_Attach_Stream(face: *anyopaque, parameters: *const FT_Open_Args) c_int;

// -- HarfBuzz externs (Phase 2g) --
extern fn hb_font_destroy(font: *anyopaque) void;

// -- C helper (Phase 2g): encapsulates HB face+font creation with custom font funcs --
extern fn initialize_hb_font(font: *XeTeXFont_rec) c_int;

// -- FT singleton state and helpers (non-static in C, Phase 2g) --
extern var ft_face_count: c_int;
extern fn get_ft_library() ?*anyopaque;
extern fn maybe_shutdown_ft() void;

// -- Tectonic bridge I/O externs --
extern fn ttstub_input_open(path: [*:0]const u8, format: c_int, is_gz: c_int) usize;
extern fn ttstub_input_get_size(handle: usize) usize;
extern fn ttstub_input_read(handle: usize, data: [*]u8, len: usize) isize;
extern fn ttstub_input_close(handle: usize) c_int;

// -- libc externs (strlen, strrchr, strcpy, strcat, memset already have malloc/free/strdup above) --
// -- libc externs (Phase 2g additions: strrchr, strcpy, strcat, memset) --
extern fn strlen(s: [*:0]const u8) usize;
extern fn strrchr(s: [*:0]u8, c: c_int) ?[*:0]u8;
extern fn strcpy(dst: [*]u8, src: [*:0]const u8) [*]u8;
extern fn strcat(dst: [*]u8, src: [*:0]const u8) [*]u8;
extern fn memset(s: ?*anyopaque, c: c_int, n: usize) ?*anyopaque;

// initialize_ft_internal: Zig port of C static initialize_ft().
// Opens font file via bridge I/O (fallback chain: OT -> TT -> T1), creates FT_Face,
// reads metrics, loads AFM for non-SFNT Type1 fonts, then calls C initialize_hb_font.
fn initialize_ft_internal(font: *XeTeXFont_rec, pathname: [*:0]const u8, index: c_int) c_int {
    const lib = get_ft_library() orelse return -1;

    // open via bridge I/O with fallback chain
    var handle: usize = ttstub_input_open(pathname, TTBC_FILE_FORMAT_OPEN_TYPE, 0);
    if (handle == 0) handle = ttstub_input_open(pathname, TTBC_FILE_FORMAT_TRUE_TYPE, 0);
    if (handle == 0) handle = ttstub_input_open(pathname, TTBC_FILE_FORMAT_TYPE1, 0);
    if (handle == 0) return -1;

    const sz = ttstub_input_get_size(handle);
    const data_raw = malloc(sz) orelse {
        _ = ttstub_input_close(handle);
        return -1;
    };

    const nread = ttstub_input_read(handle, data_raw, sz);
    _ = ttstub_input_close(handle);
    if (nread < 0 or @as(usize, @intCast(nread)) != sz) {
        free(data_raw);
        return -1;
    }

    font.font_data = @ptrCast(data_raw);
    font.font_data_size = sz;

    var ft_face_out: ?*anyopaque = null;
    const ft_err = FT_New_Memory_Face(lib, data_raw, @intCast(sz), @intCast(index), &ft_face_out);
    if (ft_err != 0) {
        free(data_raw);
        font.font_data = null;
        return -1;
    }
    font.ft_face = ft_face_out;
    ft_face_count += 1;

    // check scalability
    const face: *const FT_FacePartial = @ptrCast(@alignCast(ft_face_out.?));
    if ((face.face_flags & FT_FACE_FLAG_SCALABLE) == 0) {
        _ = FT_Done_Face(ft_face_out.?);
        ft_face_count -= 1;
        font.ft_face = null;
        free(data_raw);
        font.font_data = null;
        return -1;
    }

    // for non-SFNT fonts (Type1), try loading companion .afm
    if (index == 0 and (face.face_flags & FT_FACE_FLAG_SFNT) == 0) {
        const plen = strlen(pathname);
        const afm_raw = malloc(plen + 5);
        if (afm_raw) |afm_name| {
            _ = strcpy(afm_name, pathname);
            const afm_z: [*:0]u8 = @ptrCast(afm_name);
            const dot = strrchr(afm_z, '.');
            if (dot) |d| {
                _ = strcpy(@ptrCast(d), ".afm");
            } else {
                _ = strcat(afm_name, ".afm");
            }

            const afm_handle = ttstub_input_open(afm_z, TTBC_FILE_FORMAT_AFM, 0);
            if (afm_handle != 0) {
                const afm_sz = ttstub_input_get_size(afm_handle);
                const afm_data = malloc(afm_sz);
                if (afm_data) |ad| {
                    const afm_nread = ttstub_input_read(afm_handle, ad, afm_sz);
                    if (afm_nread > 0) {
                        var open_args: FT_Open_Args = undefined;
                        _ = memset(@ptrCast(&open_args), 0, @sizeOf(FT_Open_Args));
                        open_args.flags = FT_OPEN_MEMORY;
                        open_args.memory_base = ad;
                        open_args.memory_size = @intCast(afm_sz);
                        _ = FT_Attach_Stream(ft_face_out.?, &open_args);
                    }
                    // afm_data must remain valid while face is alive (intentional leak, same as C)
                }
                _ = ttstub_input_close(afm_handle);
            }
            free(afm_raw);
        }
    }

    font.filename = strdup(pathname);
    font.index = @intCast(index);
    font.units_per_em = face.units_per_em;
    font.ascent = @floatCast(font_units_to_points(font, @floatFromInt(face.ascender)));
    font.descent = @floatCast(font_units_to_points(font, @floatFromInt(face.descender)));

    // italic angle from PostScript table
    const post_ptr = FT_Get_Sfnt_Table(ft_face_out.?, FT_SFNT_POST);
    if (post_ptr) |pp| {
        const post: *const TT_Postscript_Partial = @ptrCast(@alignCast(pp));
        font.italic_angle = @floatCast(fix_to_d(@intCast(post.italic_angle)));
    }

    // cap_height and x_height from OS/2 table
    const os2_ptr = FT_Get_Sfnt_Table(ft_face_out.?, FT_SFNT_OS2);
    if (os2_ptr) |op| {
        const os2: *const TT_OS2_Partial = @ptrCast(@alignCast(op));
        font.cap_height = @floatCast(font_units_to_points(font, @floatFromInt(os2.s_cap_height)));
        font.x_height = @floatCast(font_units_to_points(font, @floatFromInt(os2.sx_height)));
    }

    // create HarfBuzz font via C helper (encapsulates custom font funcs)
    return initialize_hb_font(font);
}

export fn createFontFromFile(filename: [*:0]const u8, index: c_int, point_size: i32) ?*XeTeXFont_rec {
    const raw = calloc(1, @sizeOf(XeTeXFont_rec)) orelse return null;
    const font: *XeTeXFont_rec = @ptrCast(@alignCast(raw));

    font.point_size = @floatCast(fix_to_d(point_size));

    if (initialize_ft_internal(font, filename, index) != 0) {
        free(@ptrCast(raw));
        return null;
    }

    return font;
}

export fn deleteFont(font_opt: ?*XeTeXFont_rec) void {
    const font = font_opt orelse return;
    if (font.ft_face) |face| {
        _ = FT_Done_Face(face);
        font.ft_face = null;
        ft_face_count -= 1;
    }
    if (font.hb_font) |hf| {
        hb_font_destroy(hf);
        font.hb_font = null;
    }
    if (font.font_data) |fd| free(fd);
    if (font.filename) |f| {
        const ptr: ?*anyopaque = @ptrCast(@constCast(f));
        free(ptr);
    }
    free(@ptrCast(font));
    maybe_shutdown_ft();
}

// ========================================
// Glyph output functions (Phase 2h part 1)
// ========================================

export fn getGlyphs(engine: ?*XeTeXLayoutEngine_rec, glyphs: ?[*]u32) void {
    const e = engine orelse return;
    const buf = e.hb_buffer orelse return;
    const out = glyphs orelse return;

    var count: c_uint = undefined;
    const info = hb_buffer_get_glyph_infos(buf, &count);

    for (0..count) |i| {
        out[i] = info[i].codepoint;
    }
}

export fn getGlyphAdvances(engine: ?*XeTeXLayoutEngine_rec, advances: ?[*]f32) void {
    const e = engine orelse return;
    const buf = e.hb_buffer orelse return;
    const out = advances orelse return;
    const font = e.font orelse return;

    var count: c_uint = undefined;
    const pos = hb_buffer_get_glyph_positions(buf, &count);

    for (0..count) |i| {
        const advance: i32 = if (font.vertical != 0) pos[i].y_advance else pos[i].x_advance;
        out[i] = @floatCast(font_units_to_points(font, @as(f64, @floatFromInt(advance))));
    }
}

export fn getGlyphPositions(engine: ?*XeTeXLayoutEngine_rec, positions: ?[*]FloatPoint) void {
    const e = engine orelse return;
    const buf = e.hb_buffer orelse return;
    const out = positions orelse return;
    const font = e.font orelse return;

    var count: c_uint = undefined;
    const pos = hb_buffer_get_glyph_positions(buf, &count);

    var x: f32 = 0.0;
    var y: f32 = 0.0;

    if (font.vertical != 0) {
        for (0..count) |i| {
            out[i].x = -@as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(x + @as(f32, @floatFromInt(pos[i].y_offset)))))));
            out[i].y = @as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(y - @as(f32, @floatFromInt(pos[i].x_offset)))))));
            x += @as(f32, @floatFromInt(pos[i].y_advance));
            y += @as(f32, @floatFromInt(pos[i].x_advance));
        }
        out[count].x = -@as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(x)))));
        out[count].y = @as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(y)))));
    } else {
        for (0..count) |i| {
            out[i].x = @as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(x + @as(f32, @floatFromInt(pos[i].x_offset)))))));
            out[i].y = -@as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(y + @as(f32, @floatFromInt(pos[i].y_offset)))))));
            x += @as(f32, @floatFromInt(pos[i].x_advance));
            y += @as(f32, @floatFromInt(pos[i].y_advance));
        }
        out[count].x = @as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(x)))));
        out[count].y = -@as(f32, @floatCast(font_units_to_points(font, @as(f64, @floatCast(y)))));
    }

    // apply extend and slant transform
    if (e.extend != 1.0 or e.slant != 0.0) {
        for (0..count + 1) |i| {
            out[i].x = out[i].x * e.extend - out[i].y * e.slant;
        }
    }
}

// ========================================
// Text shaping (Phase 2h part 2)
// ========================================

export fn layoutChars(
    engine: ?*XeTeXLayoutEngine_rec,
    chars: ?[*]const u16,
    offset: i32,
    count: i32,
    max: i32,
    rtl: bool,
) c_int {
    const e = engine orelse return 0;
    const font = e.font orelse return 0;
    if (font.hb_font == null) return 0;
    if (chars == null) return 0;

    const buf = e.hb_buffer orelse return 0;
    hb_buffer_reset(buf);

    // add UTF-16 text
    hb_buffer_add_utf16(buf, chars.?, max, @intCast(offset), count);

    // compute direction
    const direction: c_uint = if (font.vertical != 0)
        HB_DIRECTION_TTB
    else if (rtl)
        HB_DIRECTION_RTL
    else
        HB_DIRECTION_LTR;

    hb_buffer_set_direction(buf, direction);
    hb_buffer_set_script(buf, hb_ot_tag_to_script(e.script));
    hb_buffer_set_language(buf, e.language);
    hb_buffer_guess_segment_properties(buf);

    var seg_props: hb_segment_properties_t = .{
        .direction = 0,
        .script = 0,
        .language = null,
        .reserved1 = null,
        .reserved2 = null,
    };
    hb_buffer_get_segment_properties(buf, &seg_props);

    // build shaper list -- default to {"ot", NULL} if none specified
    const default_shaper_ot: [*:0]const u8 = "ot";
    var default_shapers = [2]?[*:0]const u8{ default_shaper_ot, null };

    const shapers_to_use: ?[*]const ?[*:0]const u8 = if (e.shaper_list != null and e.n_shapers > 0)
        @ptrCast(@alignCast(e.shaper_list.?))
    else
        &default_shapers;

    const hb_font_ptr: *hb_font_t = @ptrCast(font.hb_font.?);
    const hb_face_ptr: *hb_face_t = hb_font_get_face(hb_font_ptr) orelse return 0;

    const n_feat: c_uint = if (e.n_features > 0) @intCast(e.n_features) else 0;

    // try cached shape plan first
    var plan = hb_shape_plan_create_cached(hb_face_ptr, &seg_props, e.features, n_feat, shapers_to_use) orelse return 0;

    var success = hb_shape_plan_execute(plan, hb_font_ptr, buf, e.features, n_feat);

    // free prior used_shaper
    if (e.used_shaper) |shaper| {
        const ptr: ?*anyopaque = @ptrCast(@constCast(shaper));
        free(ptr);
        e.used_shaper = null;
    }

    if (success != 0) {
        const shaper = hb_shape_plan_get_shaper(plan);
        if (shaper) |s| {
            e.used_shaper = strdup(s);
        }
    } else {
        // retry with default (no shaper list), non-cached
        hb_shape_plan_destroy(plan);
        plan = hb_shape_plan_create(hb_face_ptr, &seg_props, e.features, n_feat, null) orelse return 0;
        success = hb_shape_plan_execute(plan, hb_font_ptr, buf, e.features, n_feat);
        if (success != 0) {
            const shaper = hb_shape_plan_get_shaper(plan);
            if (shaper) |s| {
                e.used_shaper = strdup(s);
            }
        }
    }

    hb_shape_plan_destroy(plan);

    return @intCast(hb_buffer_get_length(buf));
}

// ========================================
// Font manager lifecycle (Phase 2i)
// ========================================

// Opaque HarfBuzz font funcs type (the actual struct lives in HarfBuzz C code).
const hb_font_funcs_t = opaque {};

// Globals made non-static in C for Zig access (Phase 2i).
extern var ft_lib_shutdown_pending: c_int;
extern var custom_font_funcs: ?*hb_font_funcs_t;

// HarfBuzz font funcs destroy (resolved at link time).
extern fn hb_font_funcs_destroy(funcs: *hb_font_funcs_t) void;

// destroy_font_manager: signals FT shutdown and destroys the HB custom font funcs singleton.
// Called by xetex-ini.c BEFORE the font cleanup loop, so FT shutdown is deferred
// (ft_lib_shutdown_pending + maybe_shutdown_ft pattern).
export fn destroy_font_manager() void {
    ft_lib_shutdown_pending = 1;
    maybe_shutdown_ft();
    if (custom_font_funcs) |funcs| {
        hb_font_funcs_destroy(funcs);
        custom_font_funcs = null;
    }
}

// ========================================
// Platform font functions (Phase 2j + Phase 2m)
// ========================================
// Zig provides all platform font symbols on all targets.
// macOS: CoreText-based font discovery via extern fn declarations.
// non-Mac (WASM): filesystem search with FcPattern struct.

const is_mac = builtin.os.tag == .macos;

// FcPattern -- minimal fontconfig-like struct for non-Mac platforms.
// Mirrors pkg/tectonic/src/wasm_stubs/fontconfig/fontconfig.h: struct _FcPattern { const char *file; int index; }
const FcPattern = extern struct {
    file: ?[*:0]const u8,
    index: c_int,
};

// libc externs for file existence check (non-Mac path) and general use.
extern fn access(path: [*:0]const u8, mode: c_int) c_int;
extern fn getenv(name: [*:0]const u8) ?[*:0]const u8;
extern fn snprintf(buf: [*]u8, size: usize, fmt: [*:0]const u8, ...) c_int;
const F_OK: c_int = 0;

// -- FreeType externs (Phase 2m: needed by getFileNameFromCTFont) --
extern fn FT_New_Face(library: *anyopaque, filepathname: [*:0]const u8, face_index: c_long, aface: *?*anyopaque) c_int;
extern fn FT_Get_Postscript_Name(face: *anyopaque) ?[*:0]const u8;

// -- CoreText/CoreFoundation extern declarations (macOS only, resolved at link time) --
// All CF/CT types are opaque pointers in Zig. The C ABI uses void* equivalents.
const CFAllocatorRef = ?*anyopaque;
const CFTypeRef = *anyopaque;
const CFStringRef = *anyopaque;
const CFURLRef = *anyopaque;
const CFDictionaryRef = *anyopaque;
const CFSetRef = *anyopaque;
const CFArrayRef = *anyopaque;
const CTFontDescriptorRef = *anyopaque;
const CTFontRef = *anyopaque;
const CFIndex = isize;
const CFStringEncoding = u32;
const CFURLPathStyle = isize;
const CTFontManagerScope = u32;
const CFStringCompareFlags = usize;
const CFCompareEqualTo: isize = 0;
const kCFStringEncodingUTF8: CFStringEncoding = 0x08000100;
const kCFURLPOSIXPathStyle: CFURLPathStyle = 0;
const kCTFontManagerScopeProcess: CTFontManagerScope = 1;

// CoreFoundation externs
extern fn CFRelease(cf: *anyopaque) void;
extern fn CFRetain(cf: *anyopaque) *anyopaque;
extern fn CFStringCreateWithCString(alloc: CFAllocatorRef, c_str: [*:0]const u8, encoding: CFStringEncoding) ?CFStringRef;
extern fn CFStringGetCString(the_string: CFStringRef, buffer: [*]u8, buffer_size: CFIndex, encoding: CFStringEncoding) u8;
extern fn CFStringCompare(s1: CFStringRef, s2: CFStringRef, flags: CFStringCompareFlags) isize;
extern fn CFURLCreateWithFileSystemPath(alloc: CFAllocatorRef, path: CFStringRef, style: CFURLPathStyle, is_directory: u8) ?CFURLRef;
extern fn CFURLGetFileSystemRepresentation(url: CFURLRef, resolve: u8, buffer: [*]u8, max_len: CFIndex) u8;
extern fn CFDictionaryCreate(alloc: CFAllocatorRef, keys: [*]const ?*const anyopaque, values: [*]const ?*const anyopaque, count: CFIndex, key_cbs: ?*const anyopaque, value_cbs: ?*const anyopaque) ?CFDictionaryRef;
extern fn CFSetCreate(alloc: CFAllocatorRef, values: [*]const ?*const anyopaque, count: CFIndex, cbs: ?*const anyopaque) ?CFSetRef;
extern fn CFArrayGetCount(array: CFArrayRef) CFIndex;
extern fn CFArrayGetValueAtIndex(array: CFArrayRef, idx: CFIndex) *anyopaque;
extern const kCFTypeDictionaryKeyCallBacks: anyopaque;
extern const kCFTypeDictionaryValueCallBacks: anyopaque;
extern const kCFTypeSetCallBacks: anyopaque;

// CoreText externs
extern fn CTFontDescriptorCreateWithAttributes(attrs: CFDictionaryRef) ?CTFontDescriptorRef;
extern fn CTFontDescriptorCreateMatchingFontDescriptors(descriptor: CTFontDescriptorRef, mandatory: ?CFSetRef) ?CFArrayRef;
extern fn CTFontCreateWithFontDescriptor(descriptor: CTFontDescriptorRef, size: f64, matrix: ?*const anyopaque) ?CTFontRef;
extern fn CTFontCopyAttribute(font: CTFontRef, attr: *const anyopaque) ?*anyopaque;
extern fn CTFontCopyFullName(font: CTFontRef) ?CFStringRef;
extern fn CTFontCopyPostScriptName(font: CTFontRef) ?CFStringRef;
extern fn CTFontManagerRegisterFontsForURL(url: CFURLRef, scope: CTFontManagerScope, errors: ?*anyopaque) u8;
extern const kCTFontNameAttribute: anyopaque;
extern const kCTFontDisplayNameAttribute: anyopaque;
extern const kCTFontFamilyNameAttribute: anyopaque;
extern const kCTFontURLAttribute: anyopaque;

// -- shared helpers --

fn starts_with_icase(s: []const u8, prefix: []const u8) bool {
    if (s.len < prefix.len) return false;
    return std.ascii.eqlIgnoreCase(s[0..prefix.len], prefix);
}

// parse /AAT, /OT, /ICU, /GR engine variant prefix (shared by Mac and non-Mac findFontByName)
fn parse_engine_variant(variant: ?[*]u8) void {
    setReqEngine(0);
    if (variant) |v| {
        const v_slice = std.mem.span(@as([*:0]const u8, @ptrCast(v)));
        if (v_slice.len > 0 and v_slice[0] == '/') {
            if (starts_with_icase(v_slice, "/AAT"))
                setReqEngine(@bitCast(@as(u8, 'A')))
            else if (starts_with_icase(v_slice, "/OT") or starts_with_icase(v_slice, "/ICU"))
                setReqEngine(@bitCast(@as(u8, 'O')))
            else if (starts_with_icase(v_slice, "/GR"))
                setReqEngine(@bitCast(@as(u8, 'G')));
        }
    }
}

// ----------------------------------------
// macOS CoreText implementations (Phase 2m)
// ----------------------------------------

var fonts_registered: bool = false;

fn register_bundle_fonts() void {
    if (fonts_registered) return;
    fonts_registered = true;

    const home = getenv("HOME") orelse return;

    var cache_path: [1024]u8 = undefined;
    const cp_len = snprintf(&cache_path, cache_path.len, "%s/Library/Caches/Tectonic/files", home);
    if (cp_len <= 0) return;

    // register the top-level cache directory
    const path_str = CFStringCreateWithCString(null, @ptrCast(&cache_path), kCFStringEncodingUTF8) orelse return;
    const dir_url = CFURLCreateWithFileSystemPath(null, path_str, kCFURLPOSIXPathStyle, 1);
    CFRelease(path_str);

    if (dir_url) |url| {
        _ = CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopeProcess, null);
        CFRelease(url);
    }

    // also register individual 2-char hex prefix subdirectories
    var i: u32 = 0;
    while (i < 256) : (i += 1) {
        var subdir: [1040]u8 = undefined;
        _ = snprintf(&subdir, subdir.len, "%s/%02x", home, i);
        // snprintf wrote the path including the hex suffix -- but we need to use the cache_path base
        // redo with proper format
        _ = snprintf(&subdir, subdir.len, "%s/%02x", @as([*:0]const u8, @ptrCast(&cache_path)), i);
        const sub_str = CFStringCreateWithCString(null, @ptrCast(&subdir), kCFStringEncodingUTF8) orelse continue;
        const sub_url = CFURLCreateWithFileSystemPath(null, sub_str, kCFURLPOSIXPathStyle, 1);
        CFRelease(sub_str);
        if (sub_url) |url| {
            _ = CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopeProcess, null);
            CFRelease(url);
        }
    }
}

// try matching a CoreText font descriptor by a specific attribute key
fn ct_try_match_by_attr(name_str: CFStringRef, attr_key: *const anyopaque) ?CTFontDescriptorRef {
    var keys = [1]?*const anyopaque{attr_key};
    var values = [1]?*const anyopaque{@ptrCast(name_str)};
    const attrs = CFDictionaryCreate(null, &keys, &values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) orelse return null;
    const descriptor = CTFontDescriptorCreateWithAttributes(attrs) orelse {
        CFRelease(attrs);
        return null;
    };
    CFRelease(attrs);

    const mandatory = CFSetCreate(null, &keys, 1, &kCFTypeSetCallBacks) orelse {
        CFRelease(descriptor);
        return null;
    };
    const matches = CTFontDescriptorCreateMatchingFontDescriptors(descriptor, mandatory);
    CFRelease(mandatory);
    CFRelease(descriptor);

    if (matches) |m| {
        if (CFArrayGetCount(m) > 0) {
            const result = CFArrayGetValueAtIndex(m, 0);
            _ = CFRetain(result);
            CFRelease(m);
            return result;
        }
        CFRelease(m);
    }
    return null;
}

// Mac findFontByName: searches CoreText by PostScript, display, then family name.
fn find_font_by_name_mac(name: ?[*:0]const u8, variant: ?[*]u8, size: f64) callconv(.c) ?*anyopaque {
    _ = size;
    parse_engine_variant(variant);
    register_bundle_fonts();

    const n = name orelse return null;
    const name_str = CFStringCreateWithCString(null, n, kCFStringEncodingUTF8) orelse return null;

    // try PostScript name
    if (ct_try_match_by_attr(name_str, &kCTFontNameAttribute)) |result| {
        CFRelease(name_str);
        return result;
    }

    // try display name
    if (ct_try_match_by_attr(name_str, &kCTFontDisplayNameAttribute)) |result| {
        CFRelease(name_str);
        return result;
    }

    // try family name
    if (ct_try_match_by_attr(name_str, &kCTFontFamilyNameAttribute)) |result| {
        CFRelease(name_str);
        return result;
    }

    CFRelease(name_str);
    return null;
}

// Mac getFileNameFromCTFont: extracts file path from CTFont, resolves face index for multi-face files.
fn get_file_name_from_ct_font(ct_font: ?*anyopaque, index: ?*u32) callconv(.c) ?[*:0]const u8 {
    const font = ct_font orelse {
        if (index) |p| p.* = 0;
        return null;
    };

    const url: CFURLRef = @ptrCast(CTFontCopyAttribute(font, @ptrCast(@constCast(&kCTFontURLAttribute))) orelse {
        if (index) |p| p.* = 0;
        return null;
    });

    var path_buf: [1024]u8 = undefined;
    const ok = CFURLGetFileSystemRepresentation(url, 1, &path_buf, path_buf.len);
    CFRelease(url);
    if (ok == 0) {
        if (index) |p| p.* = 0;
        return null;
    }

    if (index) |idx| {
        idx.* = 0;

        // if multi-face file, find correct face index by matching PostScript name
        const lib = get_ft_library() orelse return strdup(@ptrCast(&path_buf));
        var temp_face: ?*anyopaque = null;
        const err = FT_New_Face(lib, @ptrCast(&path_buf), 0, &temp_face);
        if (err != 0) return strdup(@ptrCast(&path_buf));

        const face: *const FT_FacePartial = @ptrCast(@alignCast(temp_face.?));
        if (face.num_faces > 1) {
            const ps_name: ?CFStringRef = CTFontCopyPostScriptName(font);
            idx.* = std.math.maxInt(u32); // UINT32_MAX sentinel
            var i: c_long = 0;
            while (i < face.num_faces) : (i += 1) {
                var face_i: ?*anyopaque = null;
                if (FT_New_Face(lib, @ptrCast(&path_buf), i, &face_i) == 0) {
                    const ft_ps = FT_Get_Postscript_Name(face_i.?);
                    if (ps_name != null and ft_ps != null) {
                        const ft_ps_str = CFStringCreateWithCString(null, ft_ps.?, kCFStringEncodingUTF8);
                        if (ft_ps_str) |fps| {
                            if (CFStringCompare(ps_name.?, fps, 0) == CFCompareEqualTo) {
                                idx.* = @intCast(i);
                                CFRelease(fps);
                                _ = FT_Done_Face(face_i.?);
                                break;
                            }
                            CFRelease(fps);
                        }
                    } else if (ps_name == null and ft_ps == null) {
                        idx.* = @intCast(i);
                        _ = FT_Done_Face(face_i.?);
                        break;
                    }
                    _ = FT_Done_Face(face_i.?);
                }
            }
            if (ps_name) |psn| CFRelease(psn);
        }
        _ = FT_Done_Face(temp_face.?);

        if (idx.* == std.math.maxInt(u32)) return null;
    }

    return strdup(@ptrCast(&path_buf));
}

// Mac createFont: descriptor -> CTFont -> file path -> initialize_ft_internal.
fn create_font_mac(font_ref: ?*anyopaque, point_size: i32) callconv(.c) ?*XeTeXFont_rec {
    const ref = font_ref orelse return null;

    const pt: f64 = fix_to_d(point_size) * 72.0 / 72.27;
    const ct_font = CTFontCreateWithFontDescriptor(ref, pt, null) orelse return null;

    var font_index: u32 = 0;
    const pathname = get_file_name_from_ct_font(ct_font, &font_index);
    CFRelease(ct_font);

    const path = pathname orelse return null;

    const raw = calloc(1, @sizeOf(XeTeXFont_rec)) orelse {
        free(@ptrCast(@constCast(path)));
        return null;
    };
    const font: *XeTeXFont_rec = @ptrCast(@alignCast(raw));

    font.point_size = @floatCast(fix_to_d(point_size));

    if (initialize_ft_internal(font, path, @intCast(font_index)) != 0) {
        free(@ptrCast(raw));
        free(@ptrCast(@constCast(path)));
        return null;
    }

    free(@ptrCast(@constCast(path)));
    return font;
}

// Mac getFullName: creates CTFont from descriptor, copies full name.
fn get_full_name_mac(font_ref: ?*anyopaque) callconv(.c) [*:0]const u8 {
    const ref = font_ref orelse return "";
    const ct_font = CTFontCreateWithFontDescriptor(ref, 0.0, null) orelse return "";
    const name_cf: ?CFStringRef = CTFontCopyFullName(ct_font);
    CFRelease(ct_font);
    const name = name_cf orelse return "";
    const ok = CFStringGetCString(name, &mac_name_buf, mac_name_buf.len, kCFStringEncodingUTF8);
    CFRelease(name);
    if (ok == 0) mac_name_buf[0] = 0;
    return @ptrCast(&mac_name_buf);
}
var mac_name_buf: [512]u8 = undefined;

// Mac ttxl_platfont_get_desc: gets URL from descriptor, returns file path.
fn ttxl_platfont_get_desc_mac(font_ref: ?*anyopaque) callconv(.c) [*:0]const u8 {
    const ref = font_ref orelse return "[unknown]";
    const ct_font = CTFontCreateWithFontDescriptor(ref, 0.0, null) orelse return "[unknown]";
    const url_raw = CTFontCopyAttribute(ct_font, @ptrCast(@constCast(&kCTFontURLAttribute)));
    CFRelease(ct_font);
    const url: CFURLRef = @ptrCast(url_raw orelse return "[unknown]");
    const ok = CFURLGetFileSystemRepresentation(url, 1, &mac_desc_buf, mac_desc_buf.len);
    CFRelease(url);
    if (ok == 0) {
        @memcpy(mac_desc_buf[0..10], "[unknown]\x00");
        return @ptrCast(&mac_desc_buf);
    }
    return @ptrCast(&mac_desc_buf);
}
var mac_desc_buf: [1024]u8 = undefined;

// ----------------------------------------
// non-Mac (WASM) implementations
// ----------------------------------------

fn file_exists_check(path: [*:0]const u8) bool {
    return access(path, F_OK) == 0;
}

fn try_font_path_internal(path: [*:0]const u8) ?*FcPattern {
    if (!file_exists_check(path)) return null;
    const raw = calloc(1, @sizeOf(FcPattern)) orelse return null;
    const pat: *FcPattern = @ptrCast(@alignCast(raw));
    pat.file = strdup(path);
    pat.index = 0;
    return pat;
}

// non-Mac findFontByName: searches {., fonts} x {as-is, .otf, .ttf, .OTF, .TTF} for a font file.
fn find_font_by_name_nonmac(name: ?[*:0]const u8, variant: ?[*]u8, size: f64) callconv(.c) ?*FcPattern {
    _ = size;
    parse_engine_variant(variant);

    const n = name orelse return null;
    const name_slice = std.mem.span(n);

    const search_dirs = [_][]const u8{ ".", "fonts" };
    const exts = [_][]const u8{ ".otf", ".ttf", ".OTF", ".TTF" };

    var path_buf: [1024]u8 = undefined;

    for (search_dirs) |dir| {
        // try name as-is (might already have extension)
        if (std.fmt.bufPrintZ(&path_buf, "{s}/{s}", .{ dir, name_slice })) |path_z| {
            if (try_font_path_internal(path_z.ptr)) |result| {
                Log.log("layout", .info, "found font '{s}' at '{s}'", .{ name_slice, path_z });
                return result;
            }
        } else |_| {}

        // try with extensions
        for (exts) |ext| {
            if (std.fmt.bufPrintZ(&path_buf, "{s}/{s}{s}", .{ dir, name_slice, ext })) |path_z| {
                if (try_font_path_internal(path_z.ptr)) |result| {
                    Log.log("layout", .info, "found font '{s}' at '{s}'", .{ name_slice, path_z });
                    return result;
                }
            } else |_| {}
        }
    }

    Log.log("layout", .warn, "cannot find font '{s}'", .{name_slice});
    return null;
}

fn get_full_name_nonmac(font: ?*FcPattern) callconv(.c) [*:0]const u8 {
    const f = font orelse return "";
    return f.file orelse "";
}

fn ttxl_platfont_get_desc_nonmac(font: ?*FcPattern) callconv(.c) [*:0]const u8 {
    const f = font orelse return "[unknown]";
    return f.file orelse "[unknown]";
}

fn create_font_nonmac(font_ref: ?*FcPattern, point_size: i32) callconv(.c) ?*XeTeXFont_rec {
    const ref = font_ref orelse return null;
    const file = ref.file orelse {
        Log.log("layout", .warn, "createFont called with NULL font ref", .{});
        return null;
    };

    const raw = calloc(1, @sizeOf(XeTeXFont_rec)) orelse return null;
    const font: *XeTeXFont_rec = @ptrCast(@alignCast(raw));

    font.point_size = @floatCast(fix_to_d(point_size));

    if (initialize_ft_internal(font, file, ref.index) != 0) {
        free(@ptrCast(raw));
        return null;
    }

    return font;
}

// ----------------------------------------
// Exports: platform-conditional symbol binding
// ----------------------------------------
// On macOS: export CoreText implementations + getFileNameFromCTFont.
// On non-Mac: export FcPattern filesystem implementations.
comptime {
    if (is_mac) {
        @export(&find_font_by_name_mac, .{ .name = "findFontByName" });
        @export(&get_full_name_mac, .{ .name = "getFullName" });
        @export(&ttxl_platfont_get_desc_mac, .{ .name = "ttxl_platfont_get_desc" });
        @export(&create_font_mac, .{ .name = "createFont" });
        @export(&get_file_name_from_ct_font, .{ .name = "getFileNameFromCTFont" });
    } else {
        @export(&find_font_by_name_nonmac, .{ .name = "findFontByName" });
        @export(&get_full_name_nonmac, .{ .name = "getFullName" });
        @export(&ttxl_platfont_get_desc_nonmac, .{ .name = "ttxl_platfont_get_desc" });
        @export(&create_font_nonmac, .{ .name = "createFont" });
    }
}
