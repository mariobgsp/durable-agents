/** Shared UI types. Kept out of api.ts so there is only one source of truth. */

export type Role = "user" | "assistant" | "tool" | "system";

export type RoomMode = "nyahut" | "moderator" | "silent";

export type RoomConfig = {
  members: string[];
  mode: RoomMode;
  moderator?: string;
  maxHops: number;
  maxResponders: number;
  ifNobodyClaims: "highest" | "silent";
  conversations: Record<string, number>;
  seq?: number;
  /** Identity for the group itself: a hex colour and an emoji face. */
  color?: string;
  avatar?: string;
};

export type Session = {
  id: string;
  title: string;
  updatedAt: number;
  model?: { provider: string; modelId: string };
  /** Agent id used by this session; empty means a plain session. */
  agent?: string;
  kind?: "plain" | "agent" | "group";
  room?: RoomConfig;
  /** Soft delete: set when the thread is hidden but its transcript is still in SQLite. */
  deletedAt?: number;
};

/** A finished tool call, as one line in the transcript. Mirrors packages/server/src/wire.ts. */
export type ToolLine = {
  name: string;
  isError: boolean;
  durationMs?: number;
  /** Nested calls this one made through code mode. */
  nested?: number;
};

/** One tool call of the round in flight, as the trace renders it. Mirrors wire.ts. */
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

/** What the conversation is doing right now, derived on the server from `pi.live`. Mirrors wire.ts. */
export type RunPhase = "starting" | "thinking" | "writing" | "tool" | "compacting" | "retrying";

export type Activity = {
  /** null means nothing is running, so nothing moves. */
  phase: RunPhase | null;
  /** The run task's durable start time, or null when it could not be read (then no elapsed is shown). */
  since: number | null;
  calls: ToolCall[];
  counts: { pending: number; running: number; done: number; nested: number };
  /** Inputs waiting for the next boundary: ids and modes only. */
  queued: { requestId: string; mode: "steer" | "followUp" }[];
  attempt?: number;
  retryAt?: number;
};

/** Nothing is running. The one value the store starts from and returns to. */
export const IDLE_ACTIVITY: Activity = {
  phase: null,
  since: null,
  calls: [],
  counts: { pending: 0, running: 0, done: 0, nested: 0 },
  queued: [],
};

/** One file of a user message, derived on the server from the entry the model was given. Mirrors wire.ts. */
export type Attachment = {
  name: string;
  kind: "image" | "document";
  state: "included" | "truncated" | "omitted";
  /** Stable identifier for why a file is not fully there. Never match on `reason`, which is prose. */
  code?: string;
  reason?: string;
  mimeType?: string;
  bytes?: number;
  chars?: number;
};

/** A message on its way out: the request id is what the durable entry echoes back. */
export type Outgoing = {
  text: string;
  requestId: string;
  attachments: { name: string; mimeType: string; data: string }[];
  whenBusy?: "steer" | "followUp";
};

/** A file the user picked, before it is sent: the composer's draft, never durable. */
export type DraftFile = {
  /** Identity inside the composer, so a chip can be removed and a preview released. */
  key: string;
  name: string;
  mimeType: string;
  /** The file's own bytes, base64: what the endpoint takes. */
  base64: string;
  bytes: number;
  /** Images only: an object URL for the optimistic bubble. Released once the draft is gone. */
  previewUrl?: string;
};

/** One measured row of the usage report. */
export type UsageBucket = {
  turns: number;
  tokens: number;
  cost: number;
};

export type UsageReport = {
  generatedAt: number;
  totals: UsageBucket & { sessions: number; toolCalls: number };
  agents: (UsageBucket & { id: string; name: string })[];
  models: (UsageBucket & { provider: string; modelId: string })[];
  tools: { name: string; calls: number; errors: number; avgMs: number }[];
  days: { date: string; turns: number; tokens: number }[];
};

/** What the composer caption shows, straight from the server's own reading of the last turn. */
export type ContextInfo = {
  usedTokens: number;
  maxTokens?: number;
  provider: string;
  modelId: string;
  /** "agent" when the picker edits the agent's model rather than this thread's. */
  source: "session" | "agent";
};

export type Msg = {
  id: string;
  role: Role;
  text: string;
  ts: number;
  kind?: string;
  author?: string | null;
  /** Present on role "tool": the call this line summarizes. */
  tool?: ToolLine;
  /** On user messages: the request that produced this entry, so a local echo is dropped exactly once. */
  requestId?: string;
  /** On user messages: the files the model was given. */
  files?: Attachment[];
  data?: unknown;
};

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export type AgentRecord = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  /** Image input policy: "auto" follows the model's capabilities, "off" refuses images. */
  vision?: "auto" | "off";
  responsibility?: string;
  cwd?: string;
  /** A disabled agent stays readable but cannot start new threads. */
  enabled?: boolean;
  /** Identity the user picks: a hex colour and an emoji face. */
  color?: string;
  avatar?: string;
};

export type AgentFiles = { record: AgentRecord; agentMd: string; soulMd: string };

export type AgentInput = {
  name: string;
  provider?: string;
  modelId?: string;
  color?: string;
  avatar?: string;
  agentMd?: string;
  soulMd?: string;
  responsibility?: string;
  tools?: string[];
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
};

/**
 * Web-side mirrors of the server records. They are the contract the UI types against, so every field
 * the API can return is declared here, including the optional identity and lifecycle ones.
 */
export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
  input: string[];
  canSeeImages: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number };
  thinkingLevels: string[];
};

export type ProviderRow = {
  id: string;
  configured: boolean;
  source: string | null;
  models: string[];
};
