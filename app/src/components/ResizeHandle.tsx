import { type Component } from "solid-js";

type Props = {
  direction?: "horizontal" | "vertical";
  on_resize: (delta: number) => void;
  on_drag_start?: () => void;
  on_drag_end?: () => void;
};

const ResizeHandle: Component<Props> = (props) => {
  function on_mousedown(e: MouseEvent) {
    e.preventDefault();
    let pos = props.direction === "vertical" ? e.clientY : e.clientX;
    props.on_drag_start?.();

    const on_mousemove = (e: MouseEvent) => {
      const current = props.direction === "vertical" ? e.clientY : e.clientX;
      props.on_resize(current - pos);
      pos = current;
    };

    const on_mouseup = () => {
      document.removeEventListener("mousemove", on_mousemove);
      document.removeEventListener("mouseup", on_mouseup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      props.on_drag_end?.();
    };

    document.addEventListener("mousemove", on_mousemove);
    document.addEventListener("mouseup", on_mouseup);
    document.body.style.cursor =
      props.direction === "vertical" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div
      class={`resize-handle ${props.direction === "vertical" ? "vertical" : "horizontal"}`}
      onMouseDown={on_mousedown}
    />
  );
};

export default ResizeHandle;
