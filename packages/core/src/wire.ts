import type { EntryRecord } from "@earendil-works/pi-durable";
import type { FleetSnapshot } from "./fleet.ts";

/** Daemon -> transport frame contract. Telegram consumes it; the copy has no browser twin any more. */
export type WireRole = "user" | "assistant" | "tool" | "system";

/**
 * The spend of one model response, as the provider reported it. Cost is in the provider's own unit (USD for
 * the built-in catalogs); the UI only shows it when it is non-zero.
 */
export type WireUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

/**
 * One completed run: the first user entry through the final assistant answer. The duration includes queueing,
 * tool time and every model round, because that is the wall-clock span the owner waited for.
 */
export type WireRun = {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turns: number;
  usage: WireUsage;
};

/** Where a non-owner message came from. A direct message from the owner has no via. */
export type WireVia =
  | { kind: "agent"; from: string; mode: "message" | "delegate" }
  | { kind: "schedule"; id: string; name: string };

/** A file an agent generated and attached to this thread. The bytes live under data/artifacts. */
export type WireArtifact = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
};

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
  /** On user messages: the request that produced this entry, so a client drops exactly its own echo. */
  requestId?: string;
  /** On user messages: the files the model was given, metadata only, derived from the entry. */
  files?: WireFile[];
  /** On assistant messages: what this one response cost, when the provider reported it. */
  usage?: WireUsage;
  /** On the final assistant message of a run: the run's whole spend and wall-clock span. */
  run?: WireRun;
  /** On non-owner user messages: who sent it, or which schedule. */
  via?: WireVia;
  /** On a generated-file entry: the files available for download. */
  artifacts?: WireArtifact[];
  data?: unknown;
};

/**
 * One file of a user message, as the UI needs it. Nothing here is stored: every field is derived from the
 * content block the model was given, in the same immutable entry that names this file.
 */
export type WireFile = {
  name: string;
  kind: "image" | "document";
  state: "included" | "truncated" | "omitted";
  /** Stable identifier for why the file is not fully there. Never match on `reason`, which is prose. */
  code?: string;
  /** The English sentence shown to the user. */
  reason?: string;
  mimeType?: string;
  bytes?: number;
  /** Documents: characters the model was given. */
  chars?: number;
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

/**
 * What a conversation is doing right now, derived from `pi.live` and `pi.inbox` and nothing else. Every
 * field is an observation: there is no timer anywhere in the derivation, so the indicator cannot narrate
 * a stage that did not happen.
 */
export type RunPhase = "starting" | "thinking" | "writing" | "tool" | "compacting" | "retrying";

export type WireActivity = {
  /** null means nothing is running, so the UI shows no motion at all. */
  phase: RunPhase | null;
  /**
   * The run task's own durable `startedAt`, resolved once per run. null when it could not be read, in
   * which case the UI shows no elapsed time rather than a number nobody observed — the same rule the
   * per-call `since` follows.
   */
  since: number | null;
  calls: WireTool[];
  counts: { pending: number; running: number; done: number; nested: number };
  /** Inputs admitted and waiting for the next boundary. Ids and modes only, never their content. */
  queued: { requestId: string; mode: "steer" | "followUp" }[];
  attempt?: number;
  /** Set while a durable retry backoff is running, so the UI can say why it is waiting. */
  retryAt?: number;
};

export type WireFrame =
  | { type: "snapshot"; entries: WireMsg[] }
  | { type: "refresh"; entries: WireMsg[] }
  | { type: "entry"; entry: WireMsg }
  | { type: "message-start" }
  | { type: "delta"; text: string }
  | { type: "message-end"; text: string }
  /**
   * The round's status, as one snapshot: phase, calls, counts and queued inputs. Replaces the `tools`
   * frame, because a phase and a call list that describe one round must not be able to disagree.
   */
  | { type: "activity"; activity: WireActivity }
  | { type: "typing"; author: string; state: "start" | "stop" }
  /** Whole-list activity snapshot, sent on connect and on every change. */
  | { type: "presence"; active: string[] }
  /** Whole-list fleet snapshot, sent with presence so the roster and the active threads cannot disagree. */
  | { type: "fleet"; fleet: FleetSnapshot }
  | { type: "log"; text: string }
  | { type: "error"; message: string };

export type { EntryRecord };