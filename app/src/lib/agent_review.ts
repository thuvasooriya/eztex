import { createSignal } from "solid-js";
import * as Y from "yjs";
import {
  create_or_get_project_ytext,
  has_state_advanced_since,
} from "./y_project_doc";

export type TextPatch = {
  from: number;
  to: number;
  insert: string;
}[];

export type AgentReviewStatus = "pending" | "accepted" | "rejected" | "stale";

export interface AgentReviewChange {
  path: string;
  before: string;
  after: string;
  patch?: TextPatch;
}

export interface AgentReview {
  id: string;
  agent_id: string;
  agent_name: string;
  label: string;
  created_at: number;
  base_state_vector: string;
  status: AgentReviewStatus;
  changes: AgentReviewChange[];
}

export type AgentWriteResult =
  | { ok: true; applied: true; transaction_id: string }
  | { ok: true; applied: false; review_id: string }
  | { ok: false; error: string };

export interface AgentReviewStore {
  reviews(): AgentReview[];
  pending(): AgentReview[];
  add(review: AgentReview): void;
  accept(id: string, doc: Y.Doc): AgentWriteResult;
  reject(id: string): void;
  mark_stale(id: string): void;
  clear_completed(): void;
}

const MAX_AGENT_REVIEW_FILES = 20;
const MAX_AGENT_REVIEW_CHARS = 200_000;

export function create_agent_review_store(): AgentReviewStore {
  const [reviews, set_reviews] = createSignal<AgentReview[]>([]);

  function pending(): AgentReview[] {
    return reviews().filter((review) => review.status === "pending");
  }

  function add(review: AgentReview): void {
    if (review.changes.length > MAX_AGENT_REVIEW_FILES) return;
    const totalChars = review.changes.reduce((s, c) => s + c.after.length, 0);
    if (totalChars > MAX_AGENT_REVIEW_CHARS) return;
    set_reviews((prev) => [...prev, review]);
  }

  function accept(id: string, doc: Y.Doc): AgentWriteResult {
    const review = reviews().find((r) => r.id === id);
    if (!review) return { ok: false, error: "review not found" };
    if (review.status !== "pending") return { ok: false, error: `review is ${review.status}` };

    if (review.base_state_vector && has_state_advanced_since(doc, review.base_state_vector)) {
      set_reviews((prev) => prev.map((entry) => (
        entry.id === id ? { ...entry, status: "stale" } : entry
      )));
      return { ok: false, error: "stale: document changed since review was created" };
    }

    const transaction_id = `txn_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const origin = {
      kind: "agent-review" as const,
      review_id: review.id,
      agent_id: review.agent_id,
      label: review.label,
    };

    doc.transact(() => {
      for (const change of review.changes) {
        const ytext = create_or_get_project_ytext(doc, change.path);
        ytext.delete(0, ytext.length);
        ytext.insert(0, change.after);
      }
    }, origin);

    set_reviews((prev) => prev.map((entry) => (
      entry.id === id ? { ...entry, status: "accepted" } : entry
    )));
    return { ok: true, applied: true, transaction_id };
  }

  function reject(id: string): void {
    const review = reviews().find((r) => r.id === id);
    if (!review || review.status !== "pending") return;
    set_reviews((prev) => prev.map((entry) => (
      entry.id === id ? { ...entry, status: "rejected" } : entry
    )));
  }

  function mark_stale(id: string): void {
    const review = reviews().find((r) => r.id === id);
    if (!review || review.status !== "pending") return;
    set_reviews((prev) => prev.map((entry) => (
      entry.id === id ? { ...entry, status: "stale" } : entry
    )));
  }

  function clear_completed(): void {
    set_reviews((prev) => prev.filter((review) => review.status === "pending"));
  }

  return { reviews, pending, add, accept, reject, mark_stale, clear_completed };
}
