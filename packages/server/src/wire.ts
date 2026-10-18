import type { EntryRecord } from "@earendil-works/pi-durable";

/** Server -> web frame contract. A copy lives in packages/web/src/ws.ts and must stay identical. */
export type WireRole = "user" | "assistant" | "tool" | "system";

/** A finished tool call, as one line in the transcript. */
export type ToolLine = {
  name: string;
  isError: boolean;
  durationMs?: number;
  /** Nested calls this one made through code mode. */
  nested?: number;
};

export type WireMsg = {
  id: string;
  role: WireRole;
  text: string;
  ts: number;
  kind?: string;
  author?: string | null;
  /** Present on role "tool": the call this line summarizes. */
  tool?: ToolLine;
  data?: unknown;
};

/** One tool call, in the shape the chat trace renders. */
export type WireTool = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  /** Retained running output; absent for a call that has produced none yet. */
  output?: string;
  /** An error-severity diagnostic on this call. */
  isError?: boolean;
  /** Nested calls this one made through code mode. */
  nested?: number;
};

export type WireFrame =
  | { type: "snapshot"; entries: WireMsg[] }
  | { type: "refresh"; entries: WireMsg[] }
  | { type: "entry"; entry: WireMsg }
  | { type: "message-start" }
  | { type: "delta"; text: string }
  | { type: "message-end"; text: string }
  /**
   * Tool calls of the current round. A whole-list snapshot, like presence: the client never diffs, so a
   * missed start/stop pair cannot leave a row spinning forever.
   */
  | { type: "tools"; tools: WireTool[] }
  | { type: "typing"; author: string; state: "start" | "stop" }
  /** Whole-list activity snapshot, sent on connect and on every change. */
  | { type: "presence"; active: string[] }
  | { type: "log"; text: string }
  | { type: "error"; message: string };

export type { EntryRecord };
