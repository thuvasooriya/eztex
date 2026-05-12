import type { Component, JSX } from "solid-js";
import { generate_avatar_svg } from "../lib/avatar_generator";

type Props = {
  user_id: string;
  display_name: string;
  color: string;
  on_click?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
};

const UserAvatar: Component<Props> = (props) => {
  const svg_src = () => `data:image/svg+xml;utf8,${encodeURIComponent(generate_avatar_svg(props.user_id, 28))}`;

  return (
    <button
      class="avatar-circle"
      title={props.display_name}
      aria-label={props.display_name}
      onClick={props.on_click}
      type="button"
    >
      <img class="avatar-circle-image" src={svg_src()} alt={props.display_name} />
    </button>
  );
};

export default UserAvatar;
