This is a deeply architectural topic. Here's a full breakdown of Zed's collaboration system, followed by a design for implementing it in a WASM editor.

---

## The CRDT Core

Zed's collaboration is built on **Conflict-free Replicated Data Types (CRDTs)** rather than Operational Transformation (OT). The fundamental insight is: instead of transforming operations to apply them in different orders, structure the data so that concurrent operations are **inherently commutative**.[1]

Every piece of inserted text is treated as **immutable**. Each insertion gets a unique ID derived from a `(replica_id, sequence_number)` pair — replica IDs are centrally assigned, and sequence numbers increment locally, so no coordination is needed to mint unique IDs. A position in the document is expressed as an **anchor**: `(insertion_id, offset_into_that_insertion)` — a stable reference that survives concurrent edits because it refers to history, not current offsets.[1]

---

## Insertions, Deletions & Tombstones

When text is deleted, Zed **doesn't remove it** — it marks it with a **tombstone**. Tombstoned fragments are hidden from display but remain in the tree so anchors into them can still resolve correctly. Deletions carry a **vector timestamp** encoding the latest observed sequence number per replica, which lets Zed exclude text that was inserted concurrently with the deletion (so concurrent insertions inside a deleted range survive correctly).[1]

For concurrent insertions at the **same location**, ordering is determined by **Lamport timestamps** (derived from a scalar Lamport clock that increments on every operation and is updated on receive) sorted descending, with ties broken by replica ID. This gives a globally consistent causal order without a central coordinator.[1]

---

## Undo Map

Instead of a global undo stack (which breaks in multi-user scenarios), Zed uses an **undo map**: a mapping from operation IDs to a count.[1]

- Count = 0 → not undone
- Count = odd → undone
- Count = even → redone

Each user maintains their own logical undo/redo history. If two users concurrently undo the same operation, they both set the count to the same value — which is idempotent and preserves intent.[1]

---

## SumTree: The Underlying Data Structure

The fragments (insertions + tombstones) are stored not in a naive list but in a **SumTree** — a thread-safe, snapshot-friendly, copy-on-write B+ tree. Every leaf holds multiple items and a `Summary`; internal nodes hold a `Summary` of their subtree's summaries.[2]

This makes summaries act like a **monoidal index**: you can seek to any position in `O(log N)` by traversing the tree along summary dimensions. The same SumTree powers text ropes, highlight regions, code folding, git blame, and file trees — over 20 different uses in Zed's codebase.[3][2]

---

## Network & Transport Layer

The three-layer collaboration architecture:[4]

| Layer                                | What it does                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **CRDT / Buffer layer**              | Per-buffer operation log with version vectors, serialized to `proto::Operation` via protobuf             |
| **RPC / Transport layer**            | Custom request/response protocol over **WebSocket**, with protobuf messages defined in `proto/zed.proto` |
| **Collab server** (`collab.zed.dev`) | Central relay — authenticates clients, forwards `UpdateBuffer` to all peers, manages rooms/channels      |

When you edit a buffer, your client serializes the CRDT operation into an `UpdateBuffer` protobuf message and sends it to the collab server, which broadcasts it to all peers. The server also sends back `AckBufferOperation` with an updated version vector.[4]

---

## Follow System

The "following" feature is implemented via the `FollowableItem` trait. When user A follows user B:[4]

1. A sends `proto::Follow` with B's peer ID
2. B responds with `proto::FollowResponse` containing full editor state (cursor, scroll, open file)
3. B continues emitting `proto::UpdateView` messages as they navigate
4. A applies those with `apply_update_proto()`

Updates are **throttled at 200ms** (`LEADER_UPDATE_THROTTLE`) to prevent network flooding. Following is automatically cancelled when the follower makes a local edit, selection, or scroll change.[4]

---

## Implementing This in a WASM Editor

Here's a practical architecture using Rust → WASM + CodeMirror 6:

### Layer 1 — CRDT in Rust/WASM

Implement the text CRDT in Rust and compile with `wasm-bindgen`:

```rust
// Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
web-sys = { version = "0.3", features = ["WebSocket", "MessageEvent"] }
serde = { version = "1", features = ["derive"] }
```

```rust
use wasm_bindgen::prelude::*;
use std::collections::BTreeMap;

type ReplicaId = u64;
type Seq = u64;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct InsertionId(ReplicaId, Seq);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Fragment {
    pub id: InsertionId,
    pub text: String,
    pub tombstone: bool,
    pub lamport_ts: u64,
}

#[wasm_bindgen]
pub struct CrdtBuffer {
    replica_id: ReplicaId,
    seq: Seq,
    lamport: u64,
    // In a real impl, use a SumTree/BTree for O(log n) ops
    fragments: Vec<Fragment>,
    // version_vector[replica_id] = max_seq_seen
    version: BTreeMap<ReplicaId, Seq>,
}

#[wasm_bindgen]
impl CrdtBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(replica_id: u64) -> CrdtBuffer {
        CrdtBuffer {
            replica_id,
            seq: 0,
            lamport: 0,
            fragments: vec![Fragment {
                id: InsertionId(0, 0),
                text: String::new(),
                tombstone: false,
                lamport_ts: 0,
            }],
            version: BTreeMap::new(),
        }
    }

    // Returns serialized Op to broadcast over WebSocket
    pub fn local_insert(&mut self, offset: usize, text: &str) -> JsValue {
        self.seq += 1;
        self.lamport += 1;
        let id = InsertionId(self.replica_id, self.seq);

        // Resolve offset → (fragment_id, intra_offset) anchor
        let anchor = self.offset_to_anchor(offset);
        let frag = Fragment {
            id: id.clone(),
            text: text.to_string(),
            tombstone: false,
            lamport_ts: self.lamport,
        };
        self.apply_fragment(anchor, frag.clone());
        self.version.insert(self.replica_id, self.seq);

        let op = Op::Insert { id, anchor, text: text.to_string(), lamport_ts: self.lamport };
        serde_wasm_bindgen::to_value(&op).unwrap()
    }

    pub fn apply_remote_op(&mut self, op: JsValue) {
        let op: Op = serde_wasm_bindgen::from_value(op).unwrap();
        self.lamport = self.lamport.max(op.lamport_ts()) + 1;
        // Apply and update version vector
        match op {
            Op::Insert { id, anchor, text, lamport_ts } => {
                let frag = Fragment { id: id.clone(), text, tombstone: false, lamport_ts };
                self.apply_fragment(anchor, frag);
                self.version.insert(id.0, id.1);
            }
            Op::Delete { target_id, deleted_by, .. } => {
                self.tombstone(&target_id, deleted_by);
            }
        }
    }

    pub fn to_string(&self) -> String {
        self.fragments.iter()
            .filter(|f| !f.tombstone)
            .map(|f| f.text.as_str())
            .collect()
    }
}
```

### Layer 2 — WebSocket Transport

In Rust/WASM using `web-sys`:

```rust
use web_sys::{WebSocket, MessageEvent};

#[wasm_bindgen]
pub fn connect_collab(url: &str, buffer: &CrdtBuffer) -> WebSocket {
    let ws = WebSocket::new(url).unwrap();
    ws.set_binary_type(web_sys::BinaryType::Arraybuffer);

    let onmessage = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        // Deserialize incoming op and call buffer.apply_remote_op(op)
    });
    ws.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();
    ws
}
```

### Layer 3 — CodeMirror 6 Binding

CodeMirror 6 has a collaborative editing extension that slots in as a `ViewPlugin`:[1]

```typescript
import { EditorView } from "@codemirror/view";
import init, { CrdtBuffer } from "./pkg/crdt_wasm.js";

await init();
const replica_id = Math.floor(Math.random() * 0xffff);
const buffer = new CrdtBuffer(BigInt(replica_id));

const ws = new WebSocket("wss://your-collab-server/room/123");

// Send local ops
const localPlugin = EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
      if (fromA !== toA) {
        const op = buffer.local_delete(fromA, toA);
        ws.send(JSON.stringify(op));
      }
      if (text.length > 0) {
        const op = buffer.local_insert(fromB, text.toString());
        ws.send(JSON.stringify(op));
      }
    });
  }
});

// Apply remote ops as CodeMirror transactions
ws.onmessage = (event) => {
  const remoteOp = JSON.parse(event.data);
  buffer.apply_remote_op(remoteOp);

  // Convert CRDT change to a CodeMirror ChangeSpec and dispatch
  const { from, insert } = crdt_op_to_cm_change(remoteOp);
  view.dispatch({
    changes: { from, insert },
    annotations: [Transaction.remote.of(true)],
  });
};

const view = new EditorView({
  extensions: [localPlugin],
  parent: document.body,
});
```

### Server (Minimal Relay)

A minimal collab server in Node.js or Rust (axum + tokio-tungstenite) just needs to:

1. Maintain a `Map<roomId, Set<WebSocket>>` of connected peers
2. On receive from peer A → broadcast to all other peers in the room
3. Optionally store an op log for late-joining peers (send the full op history on join)

This is essentially the architecture used by `y-websocket` for the Yjs ecosystem, which you could also use as an off-the-shelf server if you bind your CRDT ops to the Yjs wire format.[1]

---

## Key Differences from Zed

| Zed                                                      | WASM Editor                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| SumTree (custom B+ tree in Rust) for O(log n) ops        | `Vec<Fragment>` for simplicity; swap for a WASM-ported B-tree crate (`btree-slab`) for production |
| Protobuf over WebSocket (`zed.proto`)                    | JSON over WebSocket (swap for `msgpack` for efficiency)                                           |
| Central collab server with auth (Postgres, GitHub OAuth) | Simple broadcast relay; add JWT auth for production                                               |
| LSP, worktree, git all replicated via RPC                | Only buffer ops replicated; LSP stays local                                                       |
| Follow system via `FollowableItem` trait                 | Can add cursor broadcasting as a separate op type                                                 |

The most powerful production-ready WASM alternative to building from scratch is **Automerge-rs** (has first-class WASM bindings and a text CRDT matching Zed's semantics) or **Yjs** (JavaScript-native but battle-tested for exactly this use case).[2][1]

Citations:
[1] [How CRDTs make multiplayer text editing part of Zed's DNA](https://zed.dev/blog/crdts)  
[2] [Zed Decoded: Rope & SumTree](https://simonwillison.net/2024/Apr/28/zed-decoded-rope-sumtree/)  
[3] [It's not a rope, it's a SumTree](https://zed.dev/blog/zed-decoded-rope-sumtree)  
[4] [Collaboration and Remote Development | zed-industries/zed ...](https://deepwiki.com/zed-industries/zed/5-collaboration-and-remote-development)  
[5] [Collaboration panel - Zed](https://zed.dev/docs/collaboration/overview)  
[6] [Collaboration System - AIGNE DocSmith](https://docsmith.aigne.io/docs/zed/en/architectural-concepts-collaboration-system-ae8f50)  
[7] [The Full Spectrum of Collaboration — Zed's Blog](https://zed.dev/blog/full-spectrum-of-collaboration)  
[8] [Self-generation of .rules / AGENT.md #35534 - GitHub](https://github.com/zed-industries/zed/discussions/35534)  
[9] [Fossies](https://fossies.org/linux/zed/crates/collab/README.md)  
[10] [Channels - Zed](https://zed.dev/docs/collaboration/channels)  
[11] [Documentation about how it works the collaboration ...](https://github.com/zed-industries/zed/issues/8260)  
[12] [Rope & SumTree - Plushcap](https://www.plushcap.com/content/zed/blog/rope-sumtree)  
[13] ["Zed's CRDT Backbone: How a Conflict-Free Data Structure Powers ...](https://www.youtube.com/watch?v=h_uELJjYndA)  
[14] [Collaboration | Zed Code Editor Documentation](https://zed.dev/docs/collaboration)  
[15] [Local Collaboration | Zed Code Editor Documentation](https://zed.dev/docs/development/local-collaboration)
