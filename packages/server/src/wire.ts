import type { EntryRecord } from "@earendil-works/pi-durable";

/** Server -> web frame contract. A copy lives in packages/web/src/ws.ts and must stay identical. */
export type WireRole = "user" | "assistant" | "tool" | "system";

export type WireMsg = {
  id: string;
  role: WireRole;
  text: string;
  ts: number;
  kind?: string;
  author?: string | null;
  data?: unknown;
};

export type WireFrame =
  | { type: "snapshot"; entries: WireMsg[] }
  | { type: "refresh"; entries: WireMsg[] }
  | { type: "entry"; entry: WireMsg }
  | { type: "message-start" }
  | { type: "delta"; text: string }
  | { type: "message-end"; text: string }
  | { type: "tool"; name: string; phase: "start" | "end"; output?: string; isError?: boolean }
  | { type: "typing"; author: string; state: "start" | "stop" }
  /** Whole-list activity snapshot, sent on connect and on every change. */
  | { type: "presence"; active: string[] }
  | { type: "log"; text: string }
  | { type: "error"; message: string };

export type { EntryRecord };
