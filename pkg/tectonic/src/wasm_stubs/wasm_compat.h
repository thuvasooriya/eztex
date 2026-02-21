// declarations missing from WASI libc headers
// force-included via -include for WASM builds

#ifndef WASM_COMPAT_H
#define WASM_COMPAT_H

#ifdef __wasi__
// mkstemp is excluded from WASI stdlib.h (__wasilibc_unmodified_upstream guard)
// but we provide it in wasm_posix_stubs.c
int mkstemp(char *);
#endif

#endif // WASM_COMPAT_H
