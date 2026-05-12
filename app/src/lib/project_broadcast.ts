export interface BCMessage {
  project_id: string;
  session_id: string;
  type: "yjs-update" | "blob-available" | "blob-request" | "blob-response" | "session-closing" | "project-deleted" | "room-detached";
  payload: any;
}

export class ProjectBroadcast {
  private bc: BroadcastChannel;
  private project_id: string;
  private session_id: string;
  private on_message: (msg: BCMessage) => void;

  constructor(project_id: string, session_id: string, on_message: (msg: BCMessage) => void) {
    this.project_id = project_id;
    this.session_id = session_id;
    this.on_message = on_message;
    this.bc = new BroadcastChannel(`eztex:yjs:${project_id}`);
    this.bc.onmessage = (e: MessageEvent) => {
      const msg = e.data as BCMessage | undefined;
      if (!msg) return;
      if (msg.session_id === this.session_id) return;
      if (msg.project_id !== this.project_id) return;
      this.on_message(msg);
    };
  }

  private send(msg: Omit<BCMessage, "project_id" | "session_id">): void {
    this.bc.postMessage({
      ...msg,
      project_id: this.project_id,
      session_id: this.session_id,
    });
  }

  send_yjs_update(update: Uint8Array): void {
    this.send({ type: "yjs-update", payload: update });
  }

  send_blob_available(hash: string): void {
    this.send({ type: "blob-available", payload: { hash } });
  }

  send_blob_request(hash: string): void {
    this.send({ type: "blob-request", payload: { hash } });
  }

  send_blob_response(hash: string, bytes: Uint8Array): void {
    this.send({ type: "blob-response", payload: { hash, bytes } });
  }

  send_session_closing(): void {
    this.send({ type: "session-closing", payload: null });
  }

  close(): void {
    this.bc.close();
  }
}
