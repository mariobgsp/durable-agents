/** Small HTTP client. Every /api/ request carries the token from window.__PI_BOOT__. */
import type {
  AgentFiles,
  AgentInput,
  AgentRecord,
  ContextInfo,
  ModelInfo,
  Msg,
  ProviderRow,
  RoomConfig,
  Session,
  UsageReport,
} from "./types.ts";

export type {
  AgentFiles,
  AgentInput,
  AgentRecord,
  ContextInfo,
  ModelInfo,
  Msg,
  ProviderRow,
  Role,
  RoomConfig,
  RoomMode,
  Session,
  ThinkingLevel,
  UsageReport,
} from "./types.ts";

type Boot = { token: string; apiBase: string };

/**
 * SAFETY: \`__PI_BOOT__\` is injected into the page by Vite (dev) or Fastify (production) before the bundle runs,
 * and always has the shape { token, apiBase }; globalThis has no such type, so this assertion bridges it.
 * When it is absent the value is empty, so requests get 401 instead of crashing.
 */
const boot: Boot = (globalThis as unknown as { __PI_BOOT__?: Boot }).__PI_BOOT__ ?? {
  token: "",
  apiBase: "",
};

export const token = boot.token;

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(boot.apiBase + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-pi-token": boot.token,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => req<{ ok: true; defaultProvider: string }>("/api/health"),

  sessions: (includeDeleted = false) =>
    req<{ sessions: Session[] }>("/api/sessions" + (includeDeleted ? "?includeDeleted=1" : "")),
  createSession: (title?: string, agentId?: string) =>
    req<Session>("/api/sessions", { method: "POST", body: JSON.stringify({ title, agentId }) }),
  renameSession: (id: string, title: string) =>
    req<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => req<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  restoreSession: (id: string) =>
    req<{ ok: boolean }>(`/api/sessions/${id}/restore`, { method: "POST", body: "{}" }),
  moveSession: (id: string, agentId: string) =>
    req<Session>(`/api/sessions/${id}/move`, { method: "POST", body: JSON.stringify({ agentId }) }),
  restartSession: (id: string, handoff?: string) =>
    req<{ ok: boolean }>(`/api/sessions/${id}/restart`, {
      method: "POST",
      body: JSON.stringify({ handoff }),
    }),
  messages: (id: string) => req<{ entries: Msg[] }>(`/api/sessions/${id}/messages`),
  send: (id: string, text: string, whenBusy?: "steer" | "followUp") =>
    req<{ submissionId: string }>(`/api/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, ...(whenBusy ? { whenBusy } : {}) }),
    }),
  abort: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),
  context: (id: string) => req<ContextInfo>(`/api/sessions/${id}/context`),
  compact: (id: string) => req<{ ok: true }>(`/api/sessions/${id}/compact`, { method: "POST" }),
  setModel: (id: string, provider: string, modelId: string) =>
    req<{ changed: "session" | "agent" }>(`/api/sessions/${id}/model`, {
      method: "PUT",
      body: JSON.stringify({ provider, modelId }),
    }),

  createRoom: (title: string, members: string[]) =>
    req<Session>("/api/rooms", { method: "POST", body: JSON.stringify({ title, members }) }),
  updateRoom: (id: string, patch: Partial<RoomConfig>) =>
    req<Session>(`/api/rooms/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  usage: () => req<UsageReport>("/api/usage"),

  providers: () =>
    req<{ providers: ProviderRow[]; default: { provider: string; modelId: string } }>("/api/providers"),
  setProviderKey: (id: string, apiKey: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/key`, {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),
  clearProviderKey: (id: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/key`, { method: "DELETE" }),

  models: (provider?: string) =>
    req<{ provider: string; models: ModelInfo[] }>(
      "/api/models" + (provider ? "?provider=" + encodeURIComponent(provider) : ""),
    ),
  testModel: (provider: string, modelId: string) =>
    req<{ ok: boolean; ms?: number; error?: string }>("/api/models/test", {
      method: "POST",
      body: JSON.stringify({ provider, modelId }),
    }),

  agents: () => req<{ agents: AgentRecord[]; template: { agentMd: string; soulMd: string } }>("/api/agents"),
  agent: (id: string) => req<AgentFiles>(`/api/agents/${id}`),
  createAgent: (input: AgentInput) =>
    req<AgentFiles>("/api/agents", { method: "POST", body: JSON.stringify(input) }),
  updateAgent: (id: string, input: AgentInput) =>
    req<AgentFiles & { rebound: number }>(`/api/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  setAgentEnabled: (id: string, enabled: boolean) =>
    req<AgentFiles>(`/api/agents/${id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  deleteAgent: (id: string) => req<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),
  suggestResponsibility: (soulMd: string) =>
    req<{ responsibility: string }>("/api/agents/suggest-responsibility", {
      method: "POST",
      body: JSON.stringify({ soulMd }),
    }),
};
