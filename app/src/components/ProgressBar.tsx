import { type Component, Show } from "solid-js";
import { worker_client } from "../lib/worker_client";

const ProgressBar: Component = () => {
  const visible = () => {
    const s = worker_client.status();
    return s === "loading" || s === "compiling";
  };

  return (
    <Show when={visible()}>
      <div class="progress-bar-container">
        <div
          class="progress-bar-fill"
          style={{ width: `${worker_client.progress()}%` }}
        />
      </div>
    </Show>
  );
};

export default ProgressBar;
