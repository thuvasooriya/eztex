import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import type { Awareness } from "y-protocols/awareness";
import type { AgentReviewStore, AgentReview } from "../lib/agent_review";

type Props = {
  awareness: Awareness | null;
  review_store: AgentReviewStore;
  on_accept: (id: string) => void;
  on_reject: (id: string) => void;
  on_clear_completed: () => void;
  on_close: () => void;
};

interface PeerInfo {
  client_id: number;
  name: string;
  kind: string;
  agent_id?: string;
  runtime?: string;
  agent_status?: string;
  color: string;
}

function get_agent_peers(awareness: Awareness | null): PeerInfo[] {
  if (!awareness) return [];
  const peers: PeerInfo[] = [];
  const states = awareness.getStates();
  for (const [client_id, state] of states) {
    const user = state?.user;
    if (!user) continue;
    if (user.kind === "agent") {
      const agent = state?.agent;
      peers.push({
        client_id,
        name: user.name ?? "Agent",
        kind: "agent",
        agent_id: user.agent_id,
        runtime: user.runtime,
        agent_status: agent?.status,
        color: user.color ?? "var(--fg-dim)",
      });
    }
  }
  return peers;
}

function status_label(s?: string): string {
  if (!s) return "idle";
  return s.replace(/-/g, " ");
}

const ReviewItem: Component<{
  review: AgentReview;
  on_accept: (id: string) => void;
  on_reject: (id: string) => void;
}> = (props) => {
  const [expanded, set_expanded] = createSignal(false);

  return (
    <div class={`agent-review-item status-${props.review.status}`}>
      <div class="agent-review-header" onClick={() => set_expanded((v) => !v)}>
        <span class="agent-review-label">{props.review.label}</span>
        <span class="agent-review-agent">{props.review.agent_name}</span>
        <span class={`agent-review-status badge-${props.review.status}`}>{props.review.status}</span>
        <span class="agent-review-count">{props.review.changes.length} file(s)</span>
      </div>
      <Show when={expanded()}>
        <div class="agent-review-changes">
          <For each={props.review.changes}>
            {(change) => (
              <div class="agent-review-change">
                <div class="agent-review-path">{change.path}</div>
                <Show when={change.before !== change.after}>
                  <div class="agent-review-diff">
                    <div class="agent-review-before">
                      <span class="diff-label">before:</span>
                      <pre>{truncate(change.before, 500)}</pre>
                    </div>
                    <div class="agent-review-after">
                      <span class="diff-label">after:</span>
                      <pre>{truncate(change.after, 500)}</pre>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={props.review.status === "pending"}>
            <div class="agent-review-actions">
              <button class="agent-review-accept" onClick={() => props.on_accept(props.review.id)}>
                Accept
              </button>
              <button class="agent-review-reject" onClick={() => props.on_reject(props.review.id)}>
                Reject
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `... (${text.length - max} more chars)`;
}

const AgentPanel: Component<Props> = (props) => {
  const [agent_peers, set_agent_peers] = createSignal<PeerInfo[]>([]);

  createEffect(() => {
    const aw = props.awareness;
    if (!aw) return;

    function refresh() {
      set_agent_peers(get_agent_peers(aw));
    }

    refresh();
    aw.on("change", refresh);
    return () => aw.off("change", refresh);
  });

  const pending_reviews = () => props.review_store.pending();
  const all_reviews = () => props.review_store.reviews();
  const has_completed = () => all_reviews().some((r) => r.status !== "pending");

  return (
    <div class="agent-panel-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.on_close(); }}>
      <div class="agent-panel">
        <div class="agent-panel-header">
          <h3>Agent Collaboration</h3>
          <button class="agent-panel-close" onClick={props.on_close} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="agent-panel-section">
          <h4>Connected Agents</h4>
          <Show when={agent_peers().length === 0}>
            <div class="agent-panel-empty">No agents connected</div>
          </Show>
          <For each={agent_peers()}>
            {(peer) => (
              <div class="agent-peer">
                <span class="agent-peer-dot" style={{ background: peer.color }} />
                <span class="agent-peer-name">{peer.name}</span>
                <span class="agent-peer-status">{status_label(peer.agent_status)}</span>
              </div>
            )}
          </For>
        </div>

        <div class="agent-panel-section">
          <div class="agent-panel-section-header">
            <h4>
              Pending Reviews
              <Show when={pending_reviews().length > 0}>
                <span class="agent-badge">{pending_reviews().length}</span>
              </Show>
            </h4>
            <Show when={has_completed()}>
              <button class="agent-clear-btn" onClick={props.on_clear_completed}>
                Clear completed
              </button>
            </Show>
          </div>
          <Show when={pending_reviews().length === 0 && all_reviews().length === 0}>
            <div class="agent-panel-empty">No pending reviews</div>
          </Show>
          <For each={all_reviews()}>
            {(review) => (
              <ReviewItem
                review={review}
                on_accept={props.on_accept}
                on_reject={props.on_reject}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
};

export default AgentPanel;
