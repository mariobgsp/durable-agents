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
  /** Full Access granted to this thread alone; absent means the agent's own tier applies. */
  grant?: "full";
  /** Soft delete: set when the thread is hidden but its transcript is still in SQLite. */
  deletedAt?: number;
  /** Purpose thread created by the agent network or the scheduler. */
  purpose?: "inbox" | "delegate" | "schedule";
  meshKey?: string;
  scheduleId?: string;
  peer?: string;
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

export type DisplayFont = "geist" | "system" | "serif" | "mono";
export type DisplayDensity = "compact" | "comfortable" | "spacious";

/** The global display chosen by an agent. Mirrors packages/server/src/display.ts. */
export type DisplayTheme = {
  displayName: string;
  tagline: string;
  logo: string;
  accent: string;
  background: string;
  panel: string;
  text: string;
  muted: string;
  font: DisplayFont;
  density: DisplayDensity;
  radius: number;
  customCss: string;
};

export type DisplaySnapshot = DisplayTheme & {
  updatedAt: number;
  updatedBy?: string;
};

/** A generated file attached to a thread. The bytes live under data/artifacts, never in this type. */
export type Artifact = {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
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

/** One measured usage bucket. Mirrors the server's UsageNumbers. */
export type UsageNumbers = {
  turns: number;
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsagePeriod =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "all";

export type UsageReport = {
  generatedAt: number;
  timezone: string;
  firstAt: number | null;
  totals: UsageNumbers & { sessions: number; toolCalls: number };
  periods: Record<UsagePeriod, UsageNumbers>;
  agents: { id: string; name: string; all: UsageNumbers; today: UsageNumbers; month: UsageNumbers }[];
  models: (UsageNumbers & { provider: string; modelId: string })[];
  tools: { name: string; calls: number; errors: number; avgMs: number }[];
  days: (UsageNumbers & { date: string })[];
  months: (UsageNumbers & { month: string })[];
  stateless: UsageNumbers;
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
  /** On assistant messages: the spend of this response. */
  usage?: RunUsage;
  /** On the final assistant (or a group run line): the whole run's duration and spend. */
  run?: RunSummary;
  /** On agent/schedule messages: who sent it. */
  via?: Via;
  /** On a generated-file card: the files available for download. */
  artifacts?: Artifact[];
  data?: unknown;
};

/** The provider's per-response usage, as the run summary and message footer see it. */
export type RunUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type RunSummary = {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turns: number;
  usage: RunUsage;
};

export type Via =
  | { kind: "agent"; from: string; mode: "message" | "delegate" }
  | { kind: "schedule"; id: string; name: string };

export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** What an agent may do. A policy boundary; the systemd unit is the security one. Mirrors permissions.ts. */
export type PermissionTier = "standard" | "custom" | "full";

/** The policy actually in force, as the server computed it (including inference for older records). */
export type AgentPolicy = {
  tier: PermissionTier;
  blockedTools: string[];
  allowedPaths: string[];
};

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
  /** What this agent may do; absent on older records, where the server infers the tier. */
  permissions?: PermissionTier;
  /** Tools a Custom agent may not call; `*` wildcards allowed. */
  blockedTools?: string[];
  /** Extra roots a scoped agent may reach beyond its `cwd`. */
  allowedPaths?: string[];
  /** What this agent may do on the agent network. */
  mesh?: "off" | "message" | "full";
};

export type AgentFiles = { record: AgentRecord; policy: AgentPolicy; agentMd: string; soulMd: string; memoryMd: string };

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
  permissions?: PermissionTier;
  blockedTools?: string[];
  allowedPaths?: string[];
  mesh?: "off" | "message" | "full";
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

/**
 * The app's own process facts and operations. Mirrors `packages/server/src/system.ts`.
 *
 * `capability` is what this process can actually do, so the panel can label the sandboxed action "Reload"
 * instead of offering an install the read-only unit would refuse.
 */
export type SystemSupervisor = "systemd" | "dev" | "none";
export type SystemUpdateMode = "packages" | "reload";

export type ToolVersions = {
  piDurable: string;
  piCodemode: string;
  piAi: string;
  chord: string;
  node: string;
};

export type ProcessFacts = {
  pid: number;
  startedAt: number;
  sandboxed: boolean;
  supervisor: SystemSupervisor;
  capability: { update: SystemUpdateMode; restart: "supervised" | "stops" };
  versions: ToolVersions;
};

export type SystemStep = "checking" | "installing" | "building" | "reloading" | "stopping";

export type UpdateOutcome = {
  kind: "update";
  mode: SystemUpdateMode;
  before: ToolVersions;
  after: ToolVersions;
  changed: boolean;
};

export type RestartOutcome = { kind: "restart"; supervisor: SystemSupervisor; downtimeMs: number | null };

export type OperationState =
  | { name: "running"; step: SystemStep }
  | { name: "done"; outcome: UpdateOutcome | RestartOutcome }
  | { name: "failed"; reason: string; exitCode: number | null }
  | { name: "restarting"; supervisor: SystemSupervisor }
  | { name: "stopped" }
  | { name: "interrupted"; reason: string };

export type SystemLogLine = { seq: number; at: number; kind: "state" | "log"; text: string };

export type SystemOperation = {
  id: string;
  kind: "update" | "restart";
  state: OperationState;
  startedAt: number;
  endedAt: number | null;
  log: SystemLogLine[];
  truncated: boolean;
};

export type SystemSnapshot = {
  process: ProcessFacts;
  current: SystemOperation | null;
  last: SystemOperation | null;
};


/** One agent in the live roster. Mirrors packages/server/src/fleet.ts. */
export type FleetStatus = "working" | "idle" | "disabled";

export type FleetThread = { id: string; title: string; purpose?: "inbox" | "delegate" | "schedule" };

export type FleetAgent = {
  id: string;
  name: string;
  color?: string;
  avatar?: string;
  model: { provider: string; modelId: string };
  responsibility?: string;
  enabled: boolean;
  policy: AgentPolicy;
  mesh: "off" | "message" | "full";
  status: FleetStatus;
  since: number | null;
  activeThreads: FleetThread[];
  currentThread: FleetThread | null;
  threadCount: number;
  lastActiveAt: number | null;
  links: { inbound: number; outbound: number; active: number };
  schedules: { total: number; enabled: number; nextRunAt?: number; nextName?: string };
};

export type FleetLink = {
  id: string;
  batchId: string;
  kind: "message" | "delegate";
  from: string;
  to: string;
  fromThreadId: string;
  threadId: string;
  status: "sent" | "answered" | "failed";
  hop: number;
  preview?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
};

export type FleetSchedule = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextRunAt?: number;
  lastStatus?: ScheduleStatus;
};

export type FleetSnapshot = {
  generatedAt: number;
  timezone: string;
  agents: FleetAgent[];
  links: FleetLink[];
  schedules: FleetSchedule[];
  totals: { agents: number; working: number; idle: number; disabled: number; activeLinks: number };
};

/**
 * Vault, executors and browser. None of these carries a plaintext credential: the mask is the only value the
 * client ever receives for a secret.
 */
export type VaultEntry = {
  id: string;
  label: string;
  url?: string;
  hasUsername: boolean;
  masked: string;
  createdAt: number;
  updatedAt: number;
};

export type VaultStatus = {
  path: string;
  count: number;
  keyPresent: boolean;
  gitIgnored: boolean | null;
  masked: string;
};

export type CliAvailability = { available: boolean; version?: string; reason?: string };

export type CodingAvailability = { pi: CliAvailability; opencode: CliAvailability };

export type BrowserStatus = {
  running: boolean;
  mode?: "headless" | "headful";
  pid?: number;
  port?: number;
  profileDir: string;
  binary: string | null;
  idleMinutes: number;
};

export type ScheduleStatus = "running" | "done" | "skipped" | "failed" | "interrupted";

export type Schedule = {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastScheduledFor?: number;
  lastStatus?: ScheduleStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastTokens?: number;
  lastCacheRead?: number;
  lastSubmissionId?: string;
  nextRunAt?: number;
  runCount: number;
  missedRuns: number;
  threadId?: string;
};