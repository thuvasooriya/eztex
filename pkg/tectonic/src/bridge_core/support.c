/* Copyright 2017-2021 the Tectonic Project
 * Licensed under the MIT License.
*/

#include "tectonic_bridge_core.h"

#include <setjmp.h>
#include <stdio.h> /*vsnprintf*/


#define BUF_SIZE 1024
static char format_buf[BUF_SIZE] = "";


/* The memory management utilities. */

void *
xcalloc(size_t nelem, size_t elsize)
{
    void *new_mem = calloc(nelem ? nelem : 1, elsize ? elsize : 1);

    if (new_mem == NULL)
        _tt_abort("xcalloc request for %lu elements of size %lu failed",
                  (unsigned long) nelem, (unsigned long) elsize);

    return new_mem;
}


void *
xmalloc(size_t size)
{
    void *new_mem = malloc(size ? size : 1);

    if (new_mem == NULL)
        _tt_abort("xmalloc request for %lu bytes failed", (unsigned long) size);

    return new_mem;
}


void *
xrealloc(void *old_ptr, size_t size)
{
    void *new_mem;

    if (old_ptr == NULL) {
        new_mem = xmalloc(size);
    } else {
        new_mem = realloc(old_ptr, size ? size : 1);
        if (new_mem == NULL)
            _tt_abort("xrealloc() to %lu bytes failed", (unsigned long) size);
    }

    return new_mem;
}


char *
xstrdup(const char *s)
{
    char *new_string = xmalloc(strlen (s) + 1);
    return strcpy(new_string, s);
}


/* C API helpers: printf-style wrappers over the ttbc_* bridge functions */

PRINTF_FUNC(2,0) void
ttstub_diag_vprintf(ttbc_diagnostic_t *diag, const char *format, va_list ap)
{
    vsnprintf(format_buf, BUF_SIZE, format, ap);
    ttbc_diag_append(diag, format_buf);
}


PRINTF_FUNC(2,3) void
ttstub_diag_printf(ttbc_diagnostic_t *diag, const char *format, ...)
{
    va_list ap;

    va_start(ap, format);
    ttstub_diag_vprintf(diag, format, ap);
    va_end(ap);
}


/* The global state helpers */

static jmp_buf jump_buffer;

/* Checkpoint callback state */
static ttbc_checkpoint_fn tectonic_checkpoint_fn = NULL;
static void *tectonic_checkpoint_userdata = NULL;

void
ttbc_set_checkpoint_callback(ttbc_checkpoint_fn fn, void *userdata)
{
    tectonic_checkpoint_fn = fn;
    tectonic_checkpoint_userdata = userdata;
}

void
ttbc_fire_checkpoint(int checkpoint_id)
{
    if (tectonic_checkpoint_fn != NULL) {
        tectonic_checkpoint_fn(tectonic_checkpoint_userdata, checkpoint_id);
    }
}


NORETURN PRINTF_FUNC(1,2) int
_tt_abort(const char *format, ...)
{
    va_list ap;

    va_start(ap, format);
    vsnprintf(format_buf, BUF_SIZE, format, ap);
    va_end(ap);
    longjmp(jump_buffer, 1);
}


const char *
_ttbc_get_error_message(void)
{
    return format_buf;
}


jmp_buf *
ttbc_global_engine_enter(void)
{
    return &jump_buffer;
}


void
ttbc_global_engine_exit(void)
{
}


PRINTF_FUNC(1,2) void
ttstub_issue_warning(const char *format, ...)
{
    va_list ap;

    va_start(ap, format);
    vsnprintf(format_buf, BUF_SIZE, format, ap);
    va_end(ap);
    ttbc_issue_warning(format_buf);
}


PRINTF_FUNC(1,2) void
ttstub_issue_error(const char *format, ...)
{
    va_list ap;

    va_start(ap, format);
    vsnprintf(format_buf, BUF_SIZE, format, ap);
    va_end(ap);
    ttbc_issue_error(format_buf);
}


PRINTF_FUNC(2,3) int
ttstub_fprintf(rust_output_handle_t handle, const char *format, ...)
{
    static char fprintf_buf[BUF_SIZE] = "";
    va_list ap;

    va_start(ap, format);
    int len = vsnprintf(fprintf_buf, BUF_SIZE, format, ap);
    va_end(ap);

    if (len >= BUF_SIZE) {
        len = BUF_SIZE - 1;
        fprintf_buf[len] = '\0';
    }

    if (len >= 0) {
        ttbc_output_write(handle, fprintf_buf, len);
    }

    return len;
}


/* Wrappers that add longjmp error handling */

time_t
ttstub_input_get_mtime(rust_input_handle_t handle)
{
    int64_t ti = ttbc_input_get_mtime(handle);
    return (time_t) ti;
}


size_t
ttstub_input_seek(rust_input_handle_t handle, ssize_t offset, int whence)
{
    int internal_error = 0;

    size_t rv = ttbc_input_seek(handle, offset, whence, &internal_error);

    if (internal_error) {
        longjmp(jump_buffer, 1);
    }

    return rv;
}


int
ttstub_input_close(rust_input_handle_t handle)
{
    if (ttbc_input_close(handle)) {
        longjmp(jump_buffer, 1);
    }

    return 0;
}
