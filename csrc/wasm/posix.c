// POSIX shims for wasm32-wasi
// provides minimal implementations of functions not available in WASI.
//
// real implementations:
//   - mkstemp: creates unique temp file via open(O_CREAT|O_EXCL), returns real fd
//
// deterministic stubs (UTC):
//   - tzname, timezone, tzset: hardcoded UTC for ICU putil.cpp

#ifdef __wasi__

#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

// mkstemp: create a unique temporary file.
// replaces XXXXXX suffix with pseudo-random chars, then opens with O_CREAT|O_EXCL
// to guarantee uniqueness. retries on EEXIST up to 100 times.
//
// tectonic calls mkstemp for synctex temp files; the returned fd must be valid.
// WASI preview1 supports path_open which maps to open().
int mkstemp(char *tmpl) {
    size_t len = strlen(tmpl);
    if (len < 6) {
        errno = EINVAL;
        return -1;
    }

    char *suffix = tmpl + len - 6;
    for (int i = 0; i < 6; i++) {
        if (suffix[i] != 'X') {
            errno = EINVAL;
            return -1;
        }
    }

    static unsigned counter = 0;
    const char charset[] = "abcdefghijklmnopqrstuvwxyz0123456789";

    for (int attempt = 0; attempt < 100; attempt++) {
        counter++;
        unsigned val = counter ^ (unsigned)(size_t)tmpl ^ (unsigned)attempt;
        for (int i = 5; i >= 0; i--) {
            suffix[i] = charset[val % 36];
            val /= 36;
        }

        int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL, 0600);
        if (fd >= 0) return fd;
        if (errno != EEXIST) return -1;
    }

    errno = EEXIST;
    return -1;
}

// timezone stubs for ICU putil.cpp
// WASI has no timezone database; hardcode UTC.
char *tzname[2] = { "UTC", "UTC" };
long timezone = 0;

void tzset(void) {
    // no-op: WASI has no timezone configuration
}

#endif // __wasi__
