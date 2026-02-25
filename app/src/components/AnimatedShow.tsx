// animated show -- keeps children mounted during exit animation
// adds .closing class to the first child element when `when` becomes false,
// waits for CSS animation to end, then unmounts

import { type JSX, Show, createSignal, createEffect, onCleanup } from "solid-js";

type Props = {
  when: boolean;
  children: JSX.Element;
  // CSS class added during exit (default: "closing")
  exit_class?: string;
  // fallback timeout in ms if animationend doesn't fire (default: 200)
  timeout?: number;
};

export default function AnimatedShow(props: Props): JSX.Element {
  const [mounted, set_mounted] = createSignal(false);
  let container_ref: HTMLDivElement | undefined;
  let cleanup_timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const visible = props.when;

    if (visible) {
      // opening: mount immediately, clear any pending close
      if (cleanup_timer) { clearTimeout(cleanup_timer); cleanup_timer = undefined; }
      set_mounted(true);
    } else if (mounted()) {
      // closing: add exit class, wait for animation, then unmount
      const el = container_ref?.firstElementChild as HTMLElement | undefined;
      if (!el) {
        set_mounted(false);
        return;
      }

      const exit_cls = props.exit_class ?? "closing";
      el.classList.add(exit_cls);

      let done = false;
      function finish() {
        if (done) return;
        done = true;
        if (cleanup_timer) { clearTimeout(cleanup_timer); cleanup_timer = undefined; }
        set_mounted(false);
      }

      el.addEventListener("animationend", finish, { once: true });
      cleanup_timer = setTimeout(finish, props.timeout ?? 200);

      onCleanup(() => {
        if (cleanup_timer) { clearTimeout(cleanup_timer); cleanup_timer = undefined; }
        el.removeEventListener("animationend", finish);
      });
    }
  });

  return (
    <Show when={mounted()}>
      <div ref={container_ref} style={{ display: "contents" }}>
        {props.children}
      </div>
    </Show>
  );
}
