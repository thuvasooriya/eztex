# Crash Analysis: print_glyph_name heap corruption

## Root Cause

**Use-after-advance pointer free** in `pkg/tectonic/src/engine_xetex/xetex-ext.c:2126-2146`, function `print_glyph_name()`.

The function calls `getGlyphName()` which returns a `malloc`'d string pointer `s`. It then iterates the string with `while (len-- > 0) print_char(*s++)`, which advances `s` past the end of the allocated block. Finally it calls `freeGlyphName(s)` -- but `s` no longer points to the original allocation. Calling `free()` on a non-original pointer is undefined behavior. On macOS arm64, `libsystem_malloc` immediately detects the invalid pointer and triggers `EXC_BREAKPOINT` (SIGTRAP), which surfaces as exit code 133/134.

### Call chain to crash

```
xetex-xetex0.c:9834  conv_toks()
  -> xetex-ext.c:2126  print_glyph_name(font=30, gid=67)
    -> xetex-ext.c:2137  s = getGlyphName(getFont(engine), gid, &len)   // malloc'd
    -> xetex-ext.c:2141  while (len-- > 0) print_char(*s++)              // s advances
    -> xetex-ext.c:2143  freeGlyphName(s)                                // s is WRONG
      -> Layout.zig:996  free(ptr)                                       // BOOM
        -> libsystem_malloc  mfm_free.cold.2  -> EXC_BREAKPOINT
```

### Why tectonic (Rust) doesn't crash

Upstream tectonic has the **same bug** in the identical C code. However, in tectonic `freeGlyphName` is implemented in Rust as `CString::from_raw(name)`. The Rust allocator may behave differently (different allocator backend, or the bug simply hasn't been triggered due to different memory layout / glyph name patterns). In eztex, `freeGlyphName` in `src/Layout.zig:994-997` calls C `free()` directly, and macOS's hardened malloc catches the invalid pointer immediately.

## The Fix

**File**: `pkg/tectonic/src/engine_xetex/xetex-ext.c` lines 2125-2146

Save the original pointer before the loop, free the original instead of the advanced one:

```c
void
print_glyph_name(int32_t font, int32_t gid)
{
    const char* s = NULL;
    int len = 0;
#ifdef XETEX_MAC
    if (font_area[font] == AAT_FONT_FLAG) {
        s = GetGlyphNameFromCTFont(fontFromInteger(font), gid, &len);
    } else
#endif
    if (font_area[font] == OTGR_FONT_FLAG) {
        XeTeXLayoutEngine engine = (XeTeXLayoutEngine)font_layout_engine[font];
        s = getGlyphName(getFont(engine), gid, &len);
    } else {
        _tt_abort("bad native font flag in `print_glyph_name`");
    }
    const char* orig = s;          // <-- save original pointer
    while (len-- > 0)
        print_char(*s++);
    if (orig)
        freeGlyphName(orig);       // <-- free original, not advanced
}
```

This fix is already applied and tested. Two-pass compilation of `tmp/test.tex` succeeds with exit code 0, producing `test.xdv` (2 pages, 114832 bytes) and `test.pdf`.

## Working Copy Cleanup

The working copy has ~100 added files (`.otf` fonts, `.sty` packages, `.fd` files, `.cfg` files, etc.) that are build/test artifacts extracted during compilation. These should NOT be committed. Only the `xetex-ext.c` fix should be committed.

## Remaining Considerations

- **Upstream contribution**: This is a genuine bug in the tectonic C engine. Consider upstreaming the fix to `tectonic-typesetting/tectonic`.
- **Similar patterns**: Grep for other `freeGlyphName` calls in the C codebase to verify no other call sites have the same issue. (Checked: `print_glyph_name` is the only caller that advances the pointer before freeing.)
