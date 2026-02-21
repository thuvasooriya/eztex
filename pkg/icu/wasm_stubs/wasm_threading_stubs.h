// force-include header for wasm32-wasi: pre-define libc++ include guards
// and provide no-op std::mutex / std::condition_variable before any source
// file can #include <mutex> or <condition_variable>.
// this file is injected via -include, so it runs before all other includes.
#ifndef _WASM_THREADING_STUBS_H_
#define _WASM_THREADING_STUBS_H_

// block libc++ <mutex> and <condition_variable> from being included
#define _LIBCPP_MUTEX
#define _LIBCPP_CONDITION_VARIABLE

#ifdef __wasi__
// timezone stubs for putil.cpp (C or C++ context)
// wasm_noop_tzset: used via -DU_TZSET=wasm_noop_tzset so U_TZSET() becomes wasm_noop_tzset()
static inline void wasm_noop_tzset(void) {}

// tzname declaration: putil.cpp uses U_TZNAME which expands to tzname
// actual storage is in wasm_posix_stubs.c
#ifdef __cplusplus
extern "C" {
#endif
extern char *tzname[2];
#ifdef __cplusplus
}
#endif
#endif // __wasi__

#ifdef __cplusplus

namespace std {

class mutex {
public:
    constexpr mutex() noexcept = default;
    ~mutex() = default;
    mutex(const mutex&) = delete;
    mutex& operator=(const mutex&) = delete;
    void lock() {}
    void unlock() {}
    bool try_lock() { return true; }
};

template<class Mutex>
class lock_guard {
public:
    explicit lock_guard(Mutex& m) : mtx_(m) { mtx_.lock(); }
    ~lock_guard() { mtx_.unlock(); }
    lock_guard(const lock_guard&) = delete;
    lock_guard& operator=(const lock_guard&) = delete;
private:
    Mutex& mtx_;
};

template<class Mutex>
class unique_lock {
public:
    explicit unique_lock(Mutex& m) : mtx_(&m), owns_(true) { mtx_->lock(); }
    ~unique_lock() { if (owns_) mtx_->unlock(); }
    unique_lock(const unique_lock&) = delete;
    unique_lock& operator=(const unique_lock&) = delete;
    void lock() { mtx_->lock(); owns_ = true; }
    void unlock() { mtx_->unlock(); owns_ = false; }
    bool owns_lock() const { return owns_; }
    Mutex* mutex() const { return mtx_; }
private:
    Mutex* mtx_;
    bool owns_;
};

class condition_variable {
public:
    condition_variable() = default;
    ~condition_variable() = default;
    condition_variable(const condition_variable&) = delete;
    condition_variable& operator=(const condition_variable&) = delete;
    void notify_one() noexcept {}
    void notify_all() noexcept {}
    template<class Lock>
    void wait(Lock&) {}
    template<class Lock, class Predicate>
    void wait(Lock& lock, Predicate pred) { while (!pred()) {} }
};

// single-threaded: once_flag is just a bool, call_once just checks it
struct once_flag {
    bool called_ = false;
};

template<class Callable, class... Args>
void call_once(once_flag& flag, Callable&& f, Args&&... args) {
    if (!flag.called_) {
        flag.called_ = true;
        f(static_cast<Args&&>(args)...);
    }
}

} // namespace std

#endif // __cplusplus
#endif // _WASM_THREADING_STUBS_H_
