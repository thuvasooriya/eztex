import { type Component } from "solid-js";
import { worker_client } from "../lib/worker_client";

const ProgressBar: Component = () => {
  const status = () => worker_client.status();
  const progress = () => worker_client.progress();

  const is_active = () => status() === "loading" || status() === "compiling";
  const is_indeterminate = () =>
    status() === "compiling" || (status() === "loading" && progress() === 0);

  return (
    <div
      class="progress-bar-container"
      style={{ opacity: is_active() ? 1 : 0 }}
    >
      {is_indeterminate() ? (
        <div class="progress-bar-indeterminate" />
      ) : (
        <div
          class="progress-bar-fill"
          style={{ width: `${progress()}%` }}
        />
      )}
    </div>
  );
};

export default ProgressBar;
