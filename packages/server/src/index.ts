import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  AGENT_TEMPLATE,
  SOUL_TEMPLATE,
  deleteAgent,
  listAgents,
  readAgent,
  setAgentEnabled,
  suggestResponsibility,
  writeAgent,
  type AgentInput,
} from "./agents.ts";
import { activeIds, subscribe as subscribeActivity } from "./activity.ts";
import { makeAuthHook } from "./auth.ts";
import { modelCatalog } from "./capabilities.ts";
import { enableE2E, e2eState, setE2EScript, type E2EStep } from "./e2e.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, clearApiKey, models, providerStatus, setApiKey } from "./models.ts";
import { context, harnessInstance, openHarness } from "./harness.ts";
import { configuredToken, dataDir, host, serverPort, tokenPath } from "./paths.ts";
import {
  abortSession,
  allSessionRecords,
  conversationIdFromParam,
  createSession,
  deleteSession,
  findSession,
  listSessions,
  moveSession,
  rebindAgent,
  renameSession,
  restartSession,
  restoreSession,
  sendMessage,
  trackIfBusy,
  transcript,
} from "./sessions.ts";
import { abortRoom, createRoom, isRoom, postToRoom, updateRoom, type RoomConfig } from "./rooms.ts";
import { openEventStream } from "./stream.ts";
import type { WireFrame } from "./wire.ts";

/** Token: from the environment (dev.mjs), from data/token, or created on the spot (npm start). */
async function resolveToken(): Promise<string> {
  if (configuredToken) return configuredToken;
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // no token file yet: create one
  }
  const fresh = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(tokenPath, fresh, { mode: 0o600 });
  return fresh;
}

const token = await resolveToken();
// E2E mode swaps every real provider for the faux provider before the harness opens.
const e2e = process.env.PI_E2E === "1";
if (e2e) enableE2E();
await openHarness();

// Warm start: `resume()` inside openHarness() may have rescheduled work that began before this process
// started, which nobody marked. Each check marks a session only if it is still busy after a short grace
// window, so an idle session is never reported as generating.
for (const record of await allSessionRecords()) {
  void trackIfBusy(String(record.id));
}

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

await app.register(
  async (api) => {
    api.addHook("onRequest", makeAuthHook(token));

    api.get("/health", async () => ({ ok: true, defaultProvider: "opencode-go" }));

    api.get("/sessions", async (request) => {
      const query = (request.query ?? {}) as { includeDeleted?: string };
      return { sessions: await listSessions(query.includeDeleted === "1") };
    });

    api.post("/sessions", async (request) => {
      const body = (request.body ?? {}) as { title?: string; agentId?: string };
      return createSession(body.title, body.agentId);
    });

    api.patch("/sessions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { title?: string };
      const renamed = await renameSession(id, body.title ?? "");
      if (!renamed) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return renamed;
    });

    api.delete("/sessions/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteSession(id);
      if (!deleted) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { ok: true };
    });

    api.post("/sessions/:id/move", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { agentId?: string };
      if (!body.agentId) {
        await reply.code(400).send({ error: "agentId is required" });
        return;
      }
      const moved = await moveSession(id, body.agentId);
      if (!moved) {
        await reply.code(404).send({ error: "Session or agent not found" });
        return;
      }
      return moved;
    });

    api.post("/sessions/:id/restart", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { handoff?: string };
      const ok = await restartSession(id, body.handoff);
      if (!ok) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { ok: true };
    });

    api.post("/sessions/:id/restore", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await restoreSession(id);
      if (!ok) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { ok: true };
    });

    // ---------- agents ----------

    api.get("/agents", async () => ({
      agents: await listAgents(),
      template: { agentMd: AGENT_TEMPLATE, soulMd: SOUL_TEMPLATE },
    }));

    api.post("/agents/suggest-responsibility", async (request, reply) => {
      const body = (request.body ?? {}) as { soulMd?: string };
      try {
        return { responsibility: await suggestResponsibility(body.soulMd ?? "") };
      } catch (error) {
        await reply.code(502).send({ error: "suggestion failed: " + String(error) });
        return;
      }
    });

    api.get("/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const files = await readAgent(id);
      if (!files) {
        await reply.code(404).send({ error: "Agent not found" });
        return;
      }
      return files;
    });

    api.post("/agents", async (request) => writeAgent((request.body ?? {}) as AgentInput));


    api.put("/agents/:id", async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as AgentInput;
      const files = await writeAgent({ ...body, id });
      const rebound = await rebindAgent(id);
      return { ...files, rebound };
    });

    api.post("/agents/:id/enabled", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: boolean };
      const files = await setAgentEnabled(id, body.enabled !== false);
      if (!files) {
        await reply.code(404).send({ error: "Agent not found" });
        return;
      }
      return files;
    });

    api.delete("/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteAgent(id);
      if (!ok) await reply.code(404).send({ error: "Agent not found" });
      return { ok };
    });

    api.get("/sessions/:id/messages", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await findSession(id))) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { entries: await transcript(id) };
    });

    api.post("/sessions/:id/messages", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) {
        await reply.code(400).send({ error: "Empty text" });
        return;
      }
      if (await isRoom(id)) {
        return postToRoom(id, text);
      }
      const result = await sendMessage(id, text);
      if (!result) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return result;
    });

    // ---------- models ----------

    api.get("/models", async (request) => {
      const query = (request.query ?? {}) as { provider?: string };
      const provider = query.provider ?? DEFAULT_PROVIDER;
      return { provider, models: await modelCatalog(provider) };
    });

    /** One cheap round trip, so the editor can prove a model works before an agent is pointed at it. */
    api.post("/models/test", async (request) => {
      const body = (request.body ?? {}) as { provider?: string; modelId?: string };
      if (!body.provider || !body.modelId) return { ok: false, error: "provider and modelId are required" };
      const model = models.getModel(body.provider, body.modelId);
      if (!model) return { ok: false, error: "model not found: " + body.provider + "/" + body.modelId };
      const started = Date.now();
      try {
        await models.completeSimple(
          model,
          {
            systemPrompt: "Reply with the single word: pong",
            messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
          },
          { sessionId: "model-test", maxTokens: 16 },
        );
        return { ok: true, ms: Date.now() - started };
      } catch (error) {
        return { ok: false, error: String(error).slice(0, 300) };
      }
    });

    // ---------- activity ----------

    /** Which sessions are generating right now. The sidebar's live view comes from the WS twin. */
    api.get("/activity", async () => ({ active: activeIds() }));

    // ---------- providers ----------

    api.get("/providers", async () => ({
      providers: await providerStatus(),
      default: { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID },
    }));

    api.put("/providers/:id/key", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { apiKey?: string };
      const key = (body.apiKey ?? "").trim();
      if (!key) {
        await reply.code(400).send({ error: "Empty API key" });
        return;
      }
      await setApiKey(id, key);
      return { ok: true };
    });

    api.delete("/providers/:id/key", async (request) => {
      const { id } = request.params as { id: string };
      await clearApiKey(id);
      return { ok: true };
    });

    // ---------- e2e control (only when PI_E2E=1) ----------

    if (e2e) {
      api.post("/e2e/script", async (request) => {
        const body = (request.body ?? {}) as { steps?: E2EStep[] };
        setE2EScript(body.steps ?? []);
        return { ok: true, ...e2eState() };
      });

      api.get("/e2e/state", async () => e2eState());
    }

    // ---------- groups ----------

    api.post("/rooms", async (request, reply) => {
      const body = (request.body ?? {}) as { title?: string; members?: string[] };
      try {
        return await createRoom(body.title ?? "", body.members ?? []);
      } catch (error) {
        await reply.code(400).send({ error: String(error) });
        return;
      }
    });

    api.put("/rooms/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Partial<RoomConfig>;
      const updated = await updateRoom(id, body);
      if (!updated) {
        await reply.code(404).send({ error: "Group not found" });
        return;
      }
      return updated;
    });

    api.post("/sessions/:id/abort", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = (await isRoom(id)) ? await abortRoom(id) : await abortSession(id);
      if (!ok) await reply.code(404).send({ error: "Session not found" });
      return { ok };
    });

    await api.register(websocket);

    api.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
      const url = new URL(request.url, "http://127.0.0.1");
      const conversationId = conversationIdFromParam(url.searchParams.get("conversation"));
      if (conversationId === null) {
        socket.close(1008, "conversation required");
        return;
      }

      const send = (frame: WireFrame): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      let stop: (() => Promise<void>) | undefined;
      void (async () => {
        try {
          const handle = await openEventStream(harnessInstance(), conversationId, context, send);
          stop = handle.stop;
        } catch (error) {
          send({ type: "error", message: "stream failed: " + String(error) });
          socket.close(1011);
        }
      })();

      socket.on("close", () => {
        void stop?.().catch(() => undefined);
      });
    });

    // Presence: one socket per browser tab, carrying activity for every session, so a thread you are not
    // viewing can still show that it is replying. Frames are whole-list snapshots, which keeps the client
    // free of diffing and immune to a missed start/stop pair.
    const presenceSockets = new Set<WebSocket>();
    subscribeActivity((ids) => {
      const frame = JSON.stringify({ type: "presence", active: [...ids] } satisfies WireFrame);
      for (const socket of presenceSockets) {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      }
    });

    api.get("/ws/presence", { websocket: true }, (socket: WebSocket) => {
      presenceSockets.add(socket);
      // Send the current state immediately: a tab that connects mid-generation must not wait for a change.
      socket.send(JSON.stringify({ type: "presence", active: activeIds() } satisfies WireFrame));
      socket.on("close", () => {
        presenceSockets.delete(socket);
      });
    });
  },
  { prefix: "/api" },
);

// Local production: one process serves the built UI, the API and WS on the same port.
const webDist = resolve(import.meta.dirname, "../../web/dist");
if (existsSync(resolve(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist, index: false });
  app.get("/", async (_request, reply) => {
    const html = await readFile(resolve(webDist, "index.html"), "utf8");
    const boot = JSON.stringify({ token, apiBase: "" });
    await reply
      .type("text/html")
      .send(html.replace("</head>", "<script>window.__PI_BOOT__=" + boot + "</script></head>"));
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host, port: serverPort });
// Report the port that was actually bound: with PI_SERVER_PORT=0 the OS picks a free one, which is what
// the E2E harness relies on so scenarios never collide.
const address = app.server.address();
const actualPort = address && typeof address === "object" ? address.port : serverPort;
console.log("server ready at http://" + host + ":" + actualPort + " (data: " + dataDir + ")");
// Handshake line: read by the desktop shell or scripts when the port and token must be discovered.
console.log("PI_SERVER_READY " + JSON.stringify({ port: actualPort, token }));
