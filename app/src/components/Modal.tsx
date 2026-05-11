import { type Component, Show, For, createEffect, onCleanup, createSignal } from "solid-js";
import { get_modal_state, close_modal } from "../lib/modal_store";

const Modal: Component = () => {
  const state = get_modal_state;
  let input_ref: HTMLInputElement | undefined;
  let overlay_ref: HTMLDivElement | undefined;
  const [closing, set_closing] = createSignal(false);

  // focus input on open, handle escape key
  createEffect(() => {
    if (!state().open) return;
    set_closing(false);

    const timer = setTimeout(() => {
      if (state().type === "input" && input_ref) {
        input_ref.focus();
        input_ref.select();
      }
    }, 50);

    const on_key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handle_close(null);
      }
      if (e.key === "Enter" && state().type === "input") {
        e.preventDefault();
        const val = input_ref?.value ?? "";
        handle_close(val || null);
      }
    };
    document.addEventListener("keydown", on_key);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("keydown", on_key);
    });
  });

  function handle_close(value: string | boolean | null) {
    if (closing()) return;
    set_closing(true);
    setTimeout(() => {
      close_modal(value);
    }, 150);
  }

  function btn_class(variant?: "default" | "primary" | "danger"): string {
    let cls = "modal-btn";
    if (variant === "primary") cls += " primary";
    if (variant === "danger") cls += " danger";
    return cls;
  }

  return (
    <Show when={state().open}>
      <div
        ref={overlay_ref}
        class={`modal-overlay ${closing() ? "closing" : ""}`}
        onClick={(e) => { if (e.target === e.currentTarget) handle_close(null); }}
      >
        <div class="modal-box">
          <p class="modal-title">{state().title}</p>
          <Show when={state().message}>
            <p class="modal-message">{state().message}</p>
          </Show>

          <Show when={state().type === "input"}>
            <input
              ref={input_ref}
              class="modal-input"
              type="text"
              placeholder={state().placeholder || ""}
              value={state().default_value || ""}
            />
          </Show>

          <Show when={state().type === "choice"}>
            <div class="modal-actions stacked">
              <For each={state().options}>
                {(opt) => (
                  <button class={btn_class(opt.variant)} onClick={() => handle_close(opt.value)}>
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={state().type === "confirm" || state().type === "alert"}>
            <div class="modal-actions">
              <For each={state().options}>
                {(opt) => (
                  <button
                    class={btn_class(opt.variant)}
                    onClick={() => handle_close(opt.value === "confirm" ? true : opt.value === "ok" ? true : false)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={state().type === "input"}>
            <div class="modal-actions">
              <button class="modal-btn" onClick={() => handle_close(null)}>Cancel</button>
              <button class="modal-btn primary" onClick={() => handle_close(input_ref?.value || null)}>Confirm</button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default Modal;
