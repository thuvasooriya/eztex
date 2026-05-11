export const FrameKind = {
  SyncStep1: 0,
  SyncStep2: 1,
  DocUpdate: 2,
  Awareness: 3,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export type DecodedFrame = {
  kind: FrameKind;
  payload: Uint8Array;
};

export function encode_frame(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function decode_frame(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < 1) throw new Error("empty frame");
  return { kind: bytes[0] as FrameKind, payload: bytes.slice(1) };
}
