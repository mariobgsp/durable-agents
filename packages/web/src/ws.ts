import { token } from "./api.ts";

/** One tool call, in the shape the chat trace renders. Mirrors packages/server/src/wire.ts. */
export type ToolCall = {
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

export type Frame =
  | { type: "snapshot"; entries: import("./api").Msg[] }
  | { type: "entry"; entry: import("./api").Msg }
  | { type: "message-start" }
  | { type: "delta"; text: string }
  | { type: "message-end"; text: string }
  /**
   * Tool calls of the current round. A whole-list snapshot, like presence: the client never diffs, so a
   * missed start/stop pair cannot leave a row spinning forever.
   */
  | { type: "tools"; tools: ToolCall[] }
  | { type: "typing"; author: string; state: "start" | "stop" }
  | { type: "presence"; active: string[] }
  | { type: "refresh"; entries: import("./api").Msg[] }
  | { type: "log"; text: string }
  | { type: "error"; message: string };

/**
 * Connect to the presence channel: activity for every session, so a thread you are not viewing can still
 * show that it is replying. Separate from `connect` because that one is scoped to one conversation.
 */
export function connectPresence(onFrame: (frame: Frame) => void): () => void {
  let disposed = false;
  let attempt = 0;
  let sock: WebSocket | null = null;
  let timer: number | undefined;

  const open = () => {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/ws/presence?token=${encodeURIComponent(token)}`;
    sock = new WebSocket(url);
    sock.onopen = () => {
      attempt = 0;
    };
    sock.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(String(ev.data)) as Frame);
      } catch {
        /* malformed frame: ignore */
      }
    };
    sock.onclose = () => {
      if (disposed) return;
      attempt += 1;
      timer = window.setTimeout(open, Math.min(4000, 250 * attempt));
    };
    sock.onerror = () => sock?.close();
  };

  open();
  return () => {
    disposed = true;
    if (timer) window.clearTimeout(timer);
    sock?.close();
  };
}

/** Connect to one conversation's stream; auto-reconnect with a simple backoff. */
export function connect(conversationId: string, onFrame: (frame: Frame) => void): () => void {
  let disposed = false;
  let attempt = 0;
  let sock: WebSocket | null = null;
  let timer: number | undefined;

  const open = () => {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/ws?conversation=${encodeURIComponent(
      conversationId,
    )}&token=${encodeURIComponent(token)}`;
    sock = new WebSocket(url);
    sock.onopen = () => {
      attempt = 0;
    };
    sock.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(String(ev.data)) as Frame);
      } catch {
        /* malformed frame: ignore */
      }
    };
    sock.onclose = () => {
      if (disposed) return;
      attempt += 1;
      if (attempt === 1) onFrame({ type: "log", text: "connection lost, reconnecting…" });
      timer = window.setTimeout(open, Math.min(4000, 250 * attempt));
    };
    sock.onerror = () => sock?.close();
  };

  open();
  return () => {
    disposed = true;
    if (timer) window.clearTimeout(timer);
    sock?.close();
  };
}
