// wasm sjlj runtime -- implements __wasm_setjmp/__wasm_longjmp for wasm EH-based setjmp/longjmp.
//
// this is the runtime support required by LLVM's WebAssemblyLowerEmscriptenEHSjLj pass
// when targeting wasm exception-handling proposal (non-legacy mode).
//
// references:
//   - LLVM PR #84137: https://github.com/llvm/llvm-project/pull/84137
//   - design doc: https://docs.google.com/document/d/1ZvTPT36K5jjiedF8MCXbEmYjULJjI723aOAks1IdLLg
//   - LLVM source: llvm/lib/Target/WebAssembly/WebAssemblyLowerEmscriptenEHSjLj.cpp
//
// the compiler transforms setjmp/longjmp as follows:
//   - setjmp(env) becomes __wasm_setjmp(env, label, &invocation_id)
//     where label is a unique nonzero ID per setjmp call site in the function
//     and invocation_id is a function-local alloca (its address is unique per call).
//   - longjmp(env, val) becomes __wasm_longjmp(env, val)
//     which stores env+val into jmp_buf and throws a wasm exception (tag 1 = C_LONGJMP).
//   - after each setjmp call site, the compiler generates a catch that calls
//     __wasm_setjmp_test(env, &invocation_id) to check if this longjmp targets
//     this function invocation. if it returns nonzero, that's the label to dispatch to.
//
// jmp_buf layout (must fit in C jmp_buf, typically >= 48 bytes):
//   [0]  func_invocation_id (void*)  -- identifies the specific function activation
//   [1]  label (uint32_t)            -- setjmp call site ID within that function
//   [2]  arg.env (void*)             -- longjmp argument: environment pointer
//   [3]  arg.val (int)               -- longjmp argument: return value

#include <stddef.h>
#include <stdint.h>

void __wasm_setjmp(void *env, uint32_t label, void *func_invocation_id);
uint32_t __wasm_setjmp_test(void *env, void *func_invocation_id);
void __wasm_longjmp(void *env, int val);

struct jmp_buf_impl {
    void *func_invocation_id;
    uint32_t label;
    // temporary storage for longjmp->catch communication.
    // the catch handler reads arg.env and arg.val from the thrown exception payload.
    // ideally replaced by wasm multivalue in the future.
    struct arg {
        void *env;
        int val;
    } arg;
};

// called by compiler-generated code at each setjmp call site.
// stores the invocation identity and label into the jmp_buf so that
// a later __wasm_setjmp_test can match against it.
void
__wasm_setjmp(void *env, uint32_t label, void *func_invocation_id)
{
    struct jmp_buf_impl *jb = env;
    // label 0 is reserved (means "no setjmp recorded"). the compiler must never emit 0.
    if (label == 0)
        __builtin_trap();
    // null invocation_id would mean the compiler failed to allocate the local.
    if (func_invocation_id == NULL)
        __builtin_trap();
    jb->func_invocation_id = func_invocation_id;
    jb->label = label;
}

// called in the catch handler after a C_LONGJMP exception is caught.
// checks whether the longjmp targets THIS function invocation.
// returns the label (nonzero) if yes, 0 if the longjmp targets a different frame.
uint32_t
__wasm_setjmp_test(void *env, void *func_invocation_id)
{
    struct jmp_buf_impl *jb = env;
    if (jb->label == 0)
        __builtin_trap();
    if (func_invocation_id == NULL)
        __builtin_trap();
    if (jb->func_invocation_id == func_invocation_id)
        return jb->label;
    return 0;
}

// longjmp implementation: stores env+val into the jmp_buf arg area,
// then throws a wasm exception with tag 1 (C_LONGJMP).
// the exception payload is a pointer to jb->arg.
void
__wasm_longjmp(void *env, int val)
{
    struct jmp_buf_impl *jb = env;
    // C standard 7.13.2.1: if val is 0, setjmp must return 1.
    if (val == 0)
        val = 1;
    jb->arg.env = env;
    jb->arg.val = val;
    __builtin_wasm_throw(1, &jb->arg); // tag 1 = C_LONGJMP
}
