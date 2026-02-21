// fontconfig stub for WASM builds
// defines types only -- no actual FontConfig functionality
// the xetex_layout.c provides all font management via FreeType + HarfBuzz

#ifndef _FONTCONFIG_FONTCONFIG_H_
#define _FONTCONFIG_FONTCONFIG_H_

typedef int FcBool;
typedef unsigned char FcChar8;
typedef unsigned int FcChar32;

// minimal FcPattern -- used as PlatformFontRef in the engine.
// in WASM mode this holds a font file path and face index.
typedef struct _FcPattern {
    const char *file;
    int index;
} FcPattern;

typedef enum _FcResult {
    FcResultMatch,
    FcResultNoMatch,
    FcResultTypeMismatch,
    FcResultNoId,
    FcResultOutOfMemory
} FcResult;

#endif // _FONTCONFIG_FONTCONFIG_H_
