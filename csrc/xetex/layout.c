// Irreducible C layer for xetex_layout.
// All 80 layout API functions are now implemented in src/Layout.zig.
// This file contains only the FT/HB infrastructure that requires C:
// - FreeType library singleton management
// - XeTeXFont_rec struct definition (ABI boundary with Zig)
// - Custom HarfBuzz font funcs (10 callbacks accessing deep FT_Face internals)
// - HarfBuzz font initialization helper (called from Zig)
// - FreeType font initialization (called from Mac createFont path)

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include "tectonic_bridge_core.h"
#include "tectonic_xetex_layout.h"

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_ADVANCES_H
#include FT_TRUETYPE_TABLES_H
#include FT_SFNT_NAMES_H
#include FT_GLYPH_H

#include <harfbuzz/hb.h>
#include <harfbuzz/hb-ft.h>
#include <harfbuzz/hb-ot.h>

// ========================================
// Fixed-point conversion (16.16 format)
// ========================================

static inline double fix_to_d(Fixed f) {
    return (double)f / 65536.0;
}


// ========================================
// FreeType library singleton
// ========================================

static FT_Library ft_lib = NULL;
int ft_face_count = 0;
int ft_lib_shutdown_pending = 0;

FT_Library get_ft_library(void) {
    if (!ft_lib) {
        FT_Error err = FT_Init_FreeType(&ft_lib);
        if (err) {
            fprintf(stderr, "xetex_layout: FT_Init_FreeType failed: %d\n", err);
            return NULL;
        }
    }
    return ft_lib;
}

void maybe_shutdown_ft(void) {
    if (ft_lib_shutdown_pending && ft_face_count == 0 && ft_lib) {
        FT_Done_FreeType(ft_lib);
        ft_lib = NULL;
        ft_lib_shutdown_pending = 0;
    }
}

// ========================================
// XeTeXFont_rec - the font struct
// ========================================

struct XeTeXFont_rec {
    uint16_t units_per_em;
    float point_size;
    float ascent;
    float descent;
    float cap_height;
    float x_height;
    float italic_angle;
    int vertical;

    char *filename;
    uint32_t index;

    FT_Face ft_face;
    hb_font_t *hb_font;

    void *font_data;
    size_t font_data_size;
};

static double font_units_to_points(struct XeTeXFont_rec *f, double units) {
    return (units * (double)f->point_size) / (double)f->units_per_em;
}

// ========================================
// Custom HarfBuzz font funcs
// ========================================

hb_font_funcs_t *custom_font_funcs = NULL;
static hb_user_data_key_t ft_face_user_data_key;

static hb_bool_t hb_nominal_glyph_func(hb_font_t *font, void *font_data,
    hb_codepoint_t unicode, hb_codepoint_t *glyph, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_UInt gid = FT_Get_Char_Index(face, unicode);
    if (gid == 0) return 0;
    *glyph = gid;
    return 1;
}

static hb_bool_t hb_variation_glyph_func(hb_font_t *font, void *font_data,
    hb_codepoint_t unicode, hb_codepoint_t variation_selector,
    hb_codepoint_t *glyph, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_UInt gid = FT_Face_GetCharVariantIndex(face, unicode, variation_selector);
    if (gid == 0) return 0;
    *glyph = gid;
    return 1;
}

static FT_Fixed get_glyph_advance_raw(FT_Face face, FT_UInt gid, int vertical) {
    FT_Int32 flags = FT_LOAD_NO_SCALE;
    if (vertical) flags |= FT_LOAD_VERTICAL_LAYOUT;
    FT_Fixed advance = 0;
    FT_Error err = FT_Get_Advance(face, gid, flags, &advance);
    if (err) return 0;
    if (vertical) return -advance;
    return advance;
}

static hb_position_t hb_h_advance_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, void *user_data) {
    (void)font; (void)user_data;
    return (hb_position_t)get_glyph_advance_raw((FT_Face)font_data, glyph, 0);
}

static hb_position_t hb_v_advance_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, void *user_data) {
    (void)font; (void)user_data;
    return (hb_position_t)get_glyph_advance_raw((FT_Face)font_data, glyph, 1);
}

static hb_bool_t hb_h_origin_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, hb_position_t *x, hb_position_t *y, void *user_data) {
    (void)font; (void)font_data; (void)glyph; (void)user_data;
    *x = 0; *y = 0;
    return 1;
}

static hb_bool_t hb_v_origin_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, hb_position_t *x, hb_position_t *y, void *user_data) {
    (void)font; (void)font_data; (void)glyph; (void)user_data;
    *x = 0; *y = 0;
    return 1;
}

static hb_position_t hb_h_kerning_func(hb_font_t *font, void *font_data,
    hb_codepoint_t first_glyph, hb_codepoint_t second_glyph, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_Vector kerning;
    FT_Error err = FT_Get_Kerning(face, first_glyph, second_glyph, FT_KERNING_UNSCALED, &kerning);
    if (err) return 0;
    return (hb_position_t)kerning.x;
}

static hb_bool_t hb_extents_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, hb_glyph_extents_t *extents, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_Error err = FT_Load_Glyph(face, glyph, FT_LOAD_NO_SCALE);
    if (err) return 0;
    extents->x_bearing = (hb_position_t)face->glyph->metrics.horiBearingX;
    extents->y_bearing = (hb_position_t)face->glyph->metrics.horiBearingY;
    extents->width = (hb_position_t)face->glyph->metrics.width;
    extents->height = -(hb_position_t)face->glyph->metrics.height;
    return 1;
}

static hb_bool_t hb_contour_point_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, unsigned int point_index,
    hb_position_t *x, hb_position_t *y, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_Error err = FT_Load_Glyph(face, glyph, FT_LOAD_NO_SCALE);
    if (err) return 0;
    if (face->glyph->format != FT_GLYPH_FORMAT_OUTLINE) return 0;
    if (point_index >= (unsigned int)face->glyph->outline.n_points) return 0;
    *x = (hb_position_t)face->glyph->outline.points[point_index].x;
    *y = (hb_position_t)face->glyph->outline.points[point_index].y;
    return 1;
}

static hb_bool_t hb_glyph_name_func(hb_font_t *font, void *font_data,
    hb_codepoint_t glyph, char *name, unsigned int size, void *user_data) {
    (void)font; (void)user_data;
    FT_Face face = (FT_Face)font_data;
    FT_Error err = FT_Get_Glyph_Name(face, glyph, name, size);
    if (err || name[0] == 0) return 0;
    return 1;
}

static hb_font_funcs_t *get_font_funcs(void) {
    if (!custom_font_funcs) {
        custom_font_funcs = hb_font_funcs_create();
        hb_font_funcs_set_nominal_glyph_func(custom_font_funcs, hb_nominal_glyph_func, NULL, NULL);
        hb_font_funcs_set_variation_glyph_func(custom_font_funcs, hb_variation_glyph_func, NULL, NULL);
        hb_font_funcs_set_glyph_h_advance_func(custom_font_funcs, hb_h_advance_func, NULL, NULL);
        hb_font_funcs_set_glyph_v_advance_func(custom_font_funcs, hb_v_advance_func, NULL, NULL);
        hb_font_funcs_set_glyph_h_origin_func(custom_font_funcs, hb_h_origin_func, NULL, NULL);
        hb_font_funcs_set_glyph_v_origin_func(custom_font_funcs, hb_v_origin_func, NULL, NULL);
        hb_font_funcs_set_glyph_h_kerning_func(custom_font_funcs, hb_h_kerning_func, NULL, NULL);
        hb_font_funcs_set_glyph_extents_func(custom_font_funcs, hb_extents_func, NULL, NULL);
        hb_font_funcs_set_glyph_contour_point_func(custom_font_funcs, hb_contour_point_func, NULL, NULL);
        hb_font_funcs_set_glyph_name_func(custom_font_funcs, hb_glyph_name_func, NULL, NULL);
        hb_font_funcs_make_immutable(custom_font_funcs);
    }
    return custom_font_funcs;
}

// ========================================
// HarfBuzz face reference-table callback
// ========================================

struct hb_face_data {
    FT_Face ft_face;
};

static hb_blob_t *hb_reference_table_func(hb_face_t *face, hb_tag_t tag, void *user_data) {
    (void)face;
    struct hb_face_data *data = (struct hb_face_data *)user_data;
    FT_ULong length = 0;
    FT_Error err = FT_Load_Sfnt_Table(data->ft_face, tag, 0, NULL, &length);
    if (err || length == 0) return hb_blob_get_empty();

    FT_Byte *buffer = (FT_Byte *)malloc(length);
    if (!buffer) return hb_blob_get_empty();

    err = FT_Load_Sfnt_Table(data->ft_face, tag, 0, buffer, &length);
    if (err) {
        free(buffer);
        return hb_blob_get_empty();
    }

    return hb_blob_create((const char *)buffer, length, HB_MEMORY_MODE_WRITABLE, buffer, free);
}

// ========================================
// HarfBuzz font initialization (called from Zig)
// ========================================

int initialize_hb_font(struct XeTeXFont_rec *font) {
    struct hb_face_data *hb_data = (struct hb_face_data *)malloc(sizeof(struct hb_face_data));
    if (!hb_data) return -1;
    hb_data->ft_face = font->ft_face;
    hb_face_t *hb_face = hb_face_create_for_tables(hb_reference_table_func, hb_data, free);
    hb_face_set_index(hb_face, font->index);
    hb_face_set_upem(hb_face, font->units_per_em);

    font->hb_font = hb_font_create(hb_face);
    hb_face_destroy(hb_face);

    hb_font_set_funcs(font->hb_font, get_font_funcs(), font->ft_face, NULL);
    hb_font_set_user_data(font->hb_font, &ft_face_user_data_key, font->ft_face, NULL, 0);
    hb_font_set_scale(font->hb_font, font->units_per_em, font->units_per_em);
    hb_font_set_ppem(font->hb_font, 0, 0);
    return 0;
}

// ========================================
// FreeType font initialization (full init pipeline)
// Called indirectly from Mac createFont via Zig initialize_ft_internal
// ========================================

static int initialize_ft(struct XeTeXFont_rec *font, const char *pathname, int index) {
    FT_Library lib = get_ft_library();
    if (!lib) return -1;

    rust_input_handle_t handle = ttbc_input_open(pathname, TTBC_FILE_FORMAT_OPEN_TYPE, 0);
    if (!handle) handle = ttbc_input_open(pathname, TTBC_FILE_FORMAT_TRUE_TYPE, 0);
    if (!handle) handle = ttbc_input_open(pathname, TTBC_FILE_FORMAT_TYPE1, 0);
    if (!handle) {
        fprintf(stderr, "xetex_layout: cannot open font file '%s'\n", pathname);
        return -1;
    }

    size_t sz = ttbc_input_get_size(handle);
    void *data = malloc(sz);
    if (!data) {
        ttstub_input_close(handle);
        return -1;
    }

    ssize_t nread = ttbc_input_read(handle, (char *)data, sz);
    ttstub_input_close(handle);
    if (nread < 0 || (size_t)nread != sz) {
        free(data);
        return -1;
    }

    font->font_data = data;
    font->font_data_size = sz;

    FT_Error err = FT_New_Memory_Face(lib, (const FT_Byte *)data, (FT_Long)sz, index, &font->ft_face);
    if (err) {
        fprintf(stderr, "xetex_layout: FT_New_Memory_Face failed for '%s': %d\n", pathname, err);
        free(data);
        font->font_data = NULL;
        return -1;
    }
    ft_face_count++;

    if (!FT_IS_SCALABLE(font->ft_face)) {
        FT_Done_Face(font->ft_face);
        ft_face_count--;
        font->ft_face = NULL;
        free(data);
        font->font_data = NULL;
        return -1;
    }

    if (index == 0 && !FT_IS_SFNT(font->ft_face)) {
        size_t plen = strlen(pathname);
        char *afm_name = malloc(plen + 5);
        if (afm_name) {
            strcpy(afm_name, pathname);
            char *dot = strrchr(afm_name, '.');
            if (dot)
                strcpy(dot, ".afm");
            else
                strcat(afm_name, ".afm");

            rust_input_handle_t afm_handle = ttbc_input_open(afm_name, TTBC_FILE_FORMAT_AFM, 0);
            if (afm_handle) {
                size_t afm_sz = ttbc_input_get_size(afm_handle);
                void *afm_data = malloc(afm_sz);
                if (afm_data) {
                    ssize_t afm_nread = ttbc_input_read(afm_handle, (char *)afm_data, afm_sz);
                    if (afm_nread > 0) {
                        FT_Open_Args open_args;
                        memset(&open_args, 0, sizeof(open_args));
                        open_args.flags = FT_OPEN_MEMORY;
                        open_args.memory_base = (const FT_Byte *)afm_data;
                        open_args.memory_size = (FT_Long)afm_sz;
                        FT_Attach_Stream(font->ft_face, &open_args);
                    }
                    // afm_data intentionally leaked (must outlive face)
                }
                ttstub_input_close(afm_handle);
            }
            free(afm_name);
        }
    }

    font->filename = strdup(pathname);
    font->index = (uint32_t)index;
    font->units_per_em = (uint16_t)font->ft_face->units_per_EM;
    font->ascent = (float)font_units_to_points(font, (double)font->ft_face->ascender);
    font->descent = (float)font_units_to_points(font, (double)font->ft_face->descender);

    TT_Postscript *post = (TT_Postscript *)FT_Get_Sfnt_Table(font->ft_face, FT_SFNT_POST);
    if (post) {
        font->italic_angle = (float)fix_to_d((Fixed)post->italicAngle);
    }

    TT_OS2 *os2 = (TT_OS2 *)FT_Get_Sfnt_Table(font->ft_face, FT_SFNT_OS2);
    if (os2) {
        font->cap_height = (float)font_units_to_points(font, (double)os2->sCapHeight);
        font->x_height = (float)font_units_to_points(font, (double)os2->sxHeight);
    }

    return initialize_hb_font(font);
}
