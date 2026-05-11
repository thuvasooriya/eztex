import { createStore } from "solid-js/store";

export type ModalType = "input" | "choice" | "confirm" | "alert";

export interface ModalState {
  open: boolean;
  type: ModalType | null;
  title: string;
  message?: string;
  placeholder?: string;
  default_value?: string;
  options?: Array<{ label: string; value: string; variant?: "default" | "primary" | "danger" }>;
  resolve: ((value: string | boolean | null) => void) | null;
}

const [modal_state, set_modal_state] = createStore<ModalState>({
  open: false,
  type: null,
  title: "",
  message: undefined,
  placeholder: undefined,
  default_value: undefined,
  options: undefined,
  resolve: null,
});

export function get_modal_state() { return modal_state; }

export async function show_input_modal(opts: {
  title: string;
  message?: string;
  placeholder?: string;
  default_value?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    set_modal_state({
      open: true,
      type: "input",
      title: opts.title,
      message: opts.message,
      placeholder: opts.placeholder || "",
      default_value: opts.default_value || "",
      resolve: resolve as any,
    });
  });
}

export async function show_choice_modal(opts: {
  title: string;
  message?: string;
  options: Array<{ label: string; value: string; variant?: "default" | "primary" | "danger" }>;
}): Promise<string | null> {
  return new Promise((resolve) => {
    set_modal_state({
      open: true,
      type: "choice",
      title: opts.title,
      message: opts.message,
      options: opts.options,
      resolve: resolve as any,
    });
  });
}

export async function show_confirm_modal(opts: {
  title: string;
  message?: string;
  confirm_label?: string;
  cancel_label?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    set_modal_state({
      open: true,
      type: "confirm",
      title: opts.title,
      message: opts.message,
      options: [
        { label: opts.cancel_label || "Cancel", value: "cancel", variant: "default" },
        { label: opts.confirm_label || "Confirm", value: "confirm", variant: opts.danger ? "danger" : "primary" },
      ],
      resolve: resolve as any,
    });
  });
}

export async function show_alert_modal(opts: {
  title: string;
  message?: string;
  ok_label?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    set_modal_state({
      open: true,
      type: "alert",
      title: opts.title,
      message: opts.message,
      options: [{ label: opts.ok_label || "OK", value: "ok", variant: "primary" }],
      resolve: resolve as any,
    });
  });
}

export function close_modal(value?: string | boolean | null) {
  const r = modal_state.resolve;
  set_modal_state({
    open: false,
    type: null,
    title: "",
    message: undefined,
    placeholder: undefined,
    default_value: undefined,
    options: undefined,
    resolve: null,
  });
  if (r) r(value ?? null);
}
