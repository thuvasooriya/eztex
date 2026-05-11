import { identity_color } from "./identity";
import type { UserIdentity } from "./identity";

export type PeerKind = "human" | "agent";

export interface AgentIdentity extends UserIdentity {
  kind: "agent";
  agent_id: string;
  agent_name: string;
  runtime?: "local" | "remote" | "test";
}

function hash_to_hue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
  }
  return (Math.abs(hash) % 37) * 10;
}

export function create_agent_identity(
  agent_name: string,
  runtime?: AgentIdentity["runtime"],
): AgentIdentity {
  const agent_id = `agent_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const color_hue = hash_to_hue(agent_id);
  return {
    user_id: agent_id,
    display_name: agent_name,
    color_hue,
    color: identity_color(color_hue),
    created_at: Date.now(),
    kind: "agent",
    agent_id,
    agent_name,
    runtime: runtime ?? "local",
  };
}
