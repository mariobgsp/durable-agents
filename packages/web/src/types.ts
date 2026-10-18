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
