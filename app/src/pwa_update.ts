import { registerSW } from "virtual:pwa-register";

export function register_pwa_updates(): void {
  if (!("serviceWorker" in navigator)) return;

  const should_reload_on_controller_change = navigator.serviceWorker.controller !== null;
  if (should_reload_on_controller_change) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  const update_service_worker = registerSW({
    immediate: true,
    onNeedRefresh() {
      void update_service_worker(true);
    },
    onRegisterError(error) {
      console.error("[pwa] service worker registration failed", error);
    },
  });
}
