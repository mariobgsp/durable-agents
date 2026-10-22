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
  ensureAgentTmp,
  listAgents,
  readAgent,
  setAgentEnabled,
  suggestResponsibility,
  writeAgent,
  type AgentInput,
} from "./agents.ts";
import { activeIds, subscribe as subscribeActivity } from "./activity.ts";
import { fleetSnapshot } from "./fleet.ts";
import {
  DEFAULT_DISPLAY,
  DisplayError,
  displaySnapshot,
  resetDisplay,
  subscribeDisplay,
  updateDisplay,
  type DisplayPatch,
} from "./display.ts";
import {
  forgetMeshAgent,
  forgetMeshThread,
  reconcileMesh,
  subscribeMesh,
} from "./mesh.ts";
import {
  ScheduleError,
  createSchedule,
  deleteSchedule,
  deleteSchedulesForAgent,
  forceScheduleDue,
  forgetScheduleThread,
  listSchedules,
  previewSchedule,
  reconcileSchedules,
  runScheduleNow,
  scheduleTimezone,
  startScheduler,
  stopScheduler,
  subscribeSchedules,
  tickSchedules,
  updateSchedule,
  type ScheduleInput,
  type SchedulePatch,
} from "./schedules.ts";
import { MessageRefused, readUserFile, type UserMessageBody } from "./attachments.ts";
import { readArtifact, removeArtifacts } from "./artifacts.ts";
import { makeAuthHook } from "./auth.ts";
import { modelCatalog } from "./capabilities.ts";
import { policyOf, setGrantResolver } from "./permissions.ts";
import { cleanupStorage, purgeConversation, storageReport } from "./storage.ts";
import { usageReport } from "./usage.ts";
import { enableE2E, e2eState, setE2EScript, type E2EStep } from "./e2e.ts";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, clearApiKey, models, providerStatus, setApiKey } from "./models.ts";
import {
  OperationBusyError,
  disposeSystem,
  openSystem,
  performRestart,
  startOperation,
  systemSnapshot,
} from "./system.ts";
import { context, harnessInstance, openHarness, reloadTools } from "./harness.ts";
import { configuredToken, dataDir, host, serverPort, tokenPath } from "./paths.ts";
import { setAgentResolver } from "./remember.ts";
import {
  abortSession,
  agentForConversation,
  allSessionRecords,
  compactSession,
  contextInfo,
  conversationIdFromParam,
  conversationOf,
  createSession,
  deleteSession,
  entryIdFromParam,
  findSession,
  listSessions,
  moveSession,
  rebindAgent,
  renameSession,
  restartSession,
  removeSessionRecord,
  restoreSession,
  sendMessage,
  setSessionGrant,
  setSessionModel,
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

// Every agent's scratch directory exists before any prompt announces it, and the shared `remember` tool can
// now find which agent is calling it.
for (const agent of await listAgents()) {
  await ensureAgentTmp(agent.id);
}
setAgentResolver(agentForConversation);

// A thread's own grant, so Full Access can be given for one conversation and revoked there. The resolver is
// wired here rather than imported by the hook, which would close a module cycle through the harness.
setGrantResolver(async (conversationId) => (await findSession(conversationId))?.grant);

// Warm start: `resume()` inside openHarness() may have rescheduled work that began before this process
// started, which nobody marked. Each check marks a session only if it is still busy after a short grace
// window, so an idle session is never reported as generating.
for (const record of await allSessionRecords()) {
  void trackIfBusy(String(record.id));
  // A group member has its own conversation and its own model call. Marking it at boot lets the fleet name
  // the member that is still working after a restart, instead of reporting the room as one anonymous thread.
  for (const memberId of Object.values(record.room?.conversations ?? {})) {
    void trackIfBusy(String(memberId));
  }
}

// Schedules and mesh links survive a restart. Reconcile before the first tick so a stale "running" row is
// explained rather than shown as live forever.
await reconcileSchedules();
await reconcileMesh();

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

// The app's own facts and operations. Opened before any route can read them; the hooks are the only two
// process-shaped things this module is allowed to do.
await openSystem({
  reloadTools,
  stop: async () => {
    await app.close();
    process.exit(0);
  },
});

/**
 * The one route that needs more than the 2 MiB default: a message carries its own attachments.
 *
 * 16 MiB of raw bytes is about 21.4 MiB as base64 plus JSON overhead, so 24 MiB leaves room. It is a route
 * option rather than a raised instance limit, so every other route keeps the small default.
 */
const MESSAGE_BODY_LIMIT = 24 * 1024 * 1024;

await app.register(
  async (api) => {
    api.addHook("onRequest", makeAuthHook(token));

    /**
     * Liveness, plus whether the process is inside the hardened unit.
     *
     * The permission tiers are policy; the systemd unit is the boundary. The UI says which one is in force,
     * so `sandboxed` is reported rather than assumed.
     */
    api.get("/health", async () => ({
      ok: true,
      defaultProvider: "opencode-go",
      sandboxed: process.env.PI_SANDBOXED === "1",
    }));

    // ---------- system: the process facts, and the two operations it can perform on itself ----------

    api.get("/system", async () => systemSnapshot());

    /**
     * Start an update, or join the one already running.
     *
     * The operation is owned by `system.ts`; this route only turns a busy refusal into a readable 409.
     */
    api.post("/system/update", async (_request, reply) => {
      try {
        return startOperation("update");
      } catch (error) {
        if (error instanceof OperationBusyError) {
          await reply.code(409).send({ code: "operation-in-progress", operation: error.operation });
          return;
        }
        throw error;
      }
    });

    /**
     * Restart the process.
     *
     * The operation is recorded as terminal before the reply, then the leave happens on the response's own
     * `finish` event: the client gets the operation, not a dropped connection. Under systemd the unit's
     * `Restart=always` brings it back; under `npm run dev` a sentinel file asks `dev.mjs` to respawn it.
     */
    api.post("/system/restart", async (_request, reply) => {
      try {
        const operation = startOperation("restart");
        reply.raw.once("finish", () => {
          void performRestart();
        });
        return operation;
      } catch (error) {
        if (error instanceof OperationBusyError) {
          await reply.code(409).send({ code: "operation-in-progress", operation: error.operation });
          return;
        }
        throw error;
      }
    });

    api.get("/sessions", async (request) => {
      const query = (request.query ?? {}) as { includeDeleted?: string };
      return { sessions: await listSessions(query.includeDeleted === "1") };
    });

    api.post("/sessions", async (request) => {
      const body = (request.body ?? {}) as { title?: string; agentId?: string };
      return createSession(body.title, body.agentId);
    });

    /** What the composer's caption shows: this thread's context against its model's window. */
    api.get("/sessions/:id/context", async (request, reply) => {
      const { id } = request.params as { id: string };
      const info = await contextInfo(id);
      if (!info) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return info;
    });

    /** Compact this thread's context now. Runs in the background; the transcript shows a pill when it lands. */
    api.post("/sessions/:id/compact", async (request, reply) => {
      const { id } = request.params as { id: string };
      const started = await compactSession(id);
      if (!started) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { ok: true };
    });

    /** Switch the model from the composer. Agent threads move their agent, so every thread of it follows. */
    api.put("/sessions/:id/model", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { provider?: string; modelId?: string };
      if (!body.provider || !body.modelId) {
        await reply.code(400).send({ error: "provider and modelId are required" });
        return;
      }
      const result = await setSessionModel(id, { provider: body.provider, modelId: body.modelId });
      if (!result) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return result;
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

    /**
     * Grant or revoke Full Access for this thread.
     *
     * Per-thread and non-sticky: the agent's own tier is untouched, a new thread starts without it, and the
     * decision is visible in the thread's own record. Revoking is the same call with no grant.
     */
    api.post("/sessions/:id/permissions", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { grant?: unknown };
      const updated = await setSessionGrant(id, body.grant === "full" ? "full" : null);
      if (!updated) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      return updated;
    });

    // ---------- storage ----------

    /** How much the data directory holds, split by what a reader would recognise. */
    api.get("/storage", async () => ({ storage: await storageReport() }));

    /**
     * Fold the write-ahead log back into the database and reclaim what deletions left behind.
     *
     * Returns the sizes before and after, so the caller can say how much came back rather than claiming it did.
     */
    api.post("/storage/cleanup", async () => cleanupStorage());

    /**
     * Remove one conversation for good.
     *
     * Irreversible: the transcript is exported to data/exports/ first and the path comes back with the result.
     * The thread is then soft-deleted, so the list reflects that it is gone.
     */
    api.post("/sessions/:id/purge", async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await findSession(id))) {
        await reply.code(404).send({ error: "Session not found" });
        return;
      }
      const result = await purgeConversation(id, await transcript(id));
      await removeSessionRecord(id);
      await forgetMeshThread(id);
      await forgetScheduleThread(id);
      await removeArtifacts(id);
      return result;
    });

    // ---------- agents ----------

    api.get("/agents", async () => ({
      agents: (await listAgents()).map((record) => ({ ...record, policy: policyOf(record) })),
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
      // Computed here, not stored: the tier of a record written before tiers existed is inferred, and the
      // client has to show what is actually in force rather than what the file happens to say.
      return { ...files, policy: policyOf(files.record) };
    });

    api.post("/agents", async (request) => {
      const files = await writeAgent((request.body ?? {}) as AgentInput);
      return { ...files, policy: policyOf(files.record) };
    });

    api.put("/agents/:id", async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as AgentInput;
      const files = await writeAgent({ ...body, id });
      const rebound = await rebindAgent(id);
      return { ...files, policy: policyOf(files.record), rebound };
    });

    api.post("/agents/:id/enabled", async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: boolean };
      const files = await setAgentEnabled(id, body.enabled !== false);
      if (!files) {
        await reply.code(404).send({ error: "Agent not found" });
        return;
      }
      return { ...files, policy: policyOf(files.record) };
    });

    api.delete("/agents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteAgent(id);
      if (!ok) {
        await reply.code(404).send({ error: "Agent not found" });
        return { ok };
      }
      // Schedules and links are application state about the agent, not part of its files. A deleted agent
      // must not keep producing cron work or appear as a live counterpart in the fleet.
      await deleteSchedulesForAgent(id);
      await forgetMeshAgent(id);
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

    /**
     * One message, with its own attachments inside it.
     *
     * This is the one route where the instance-wide 2 MiB limit would bite: 16 MiB of raw bytes is about
     * 21.4 MiB as base64 plus JSON overhead, so the route declares its own limit and nothing else on the
     * server accepts a body that big. Nothing is durable on a refusal, so a 400 means the draft is intact.
     */
    api.post(
      "/sessions/:id/messages",
      { bodyLimit: MESSAGE_BODY_LIMIT },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as {
          text?: unknown;
          attachments?: unknown;
          requestId?: unknown;
          whenBusy?: unknown;
        };
        const message: UserMessageBody = {
          text: body.text,
          attachments: body.attachments,
          requestId: body.requestId,
        };
        // Steering is a per-message decision: the composer asks for it while the agent is replying. A group
        // takes the plain queue path, because one message may start several member turns.
        const whenBusy =
          body.whenBusy === "steer" || body.whenBusy === "reject" ? body.whenBusy : "followUp";
        try {
          if (await isRoom(id)) return await postToRoom(id, message);
          const result = await sendMessage(id, message, whenBusy);
          if (!result) {
            await reply.code(404).send({ error: "Session not found" });
            return;
          }
          return result;
        } catch (error) {
          if (error instanceof MessageRefused) {
            await reply.code(error.status).send({ code: error.code, error: error.message });
            return;
          }
          throw error;
        }
      },
    );

    /**
     * One file of a user message, exactly as the model was given it.
     *
     * The entry is the store: the bytes are read out of its own content block, so there is no upload route,
     * no temporary file and no second copy to keep in sync. `<img>` cannot send a header, and `?token=` is
     * already accepted on every /api route, so no new auth scheme is needed.
     */
    api.get("/sessions/:id/attachments/:entryId/:index", async (request, reply) => {
      const { id, entryId, index } = request.params as { id: string; entryId: string; index: string };
      const conversation = await conversationOf(id);
      const entry = entryIdFromParam(entryId);
      const position = Number(index);
      const served =
        conversation && entry !== null && Number.isSafeInteger(position) && position >= 0
          ? await readUserFile(conversation, entry, position, context)
          : undefined;
      if (!served) {
        await reply.code(404).send({ error: "Attachment not found" });
        return;
      }
      // Entries are immutable, so the bytes behind this URL can never change.
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .type(served.mimeType)
        .send(served.body);
    });

    /**
     * One generated file, read from data/artifacts.
     *
     * The entry is the index: the artifact id is looked up in that entry's metadata before a path is built. A
     * query token is accepted because a plain download anchor cannot send a header.
     */
    api.get("/sessions/:id/files/:entryId/:artifactId", async (request, reply) => {
      const { id, entryId, artifactId } = request.params as { id: string; entryId: string; artifactId: string };
      const conversation = await conversationOf(id);
      const entryNumber = entryIdFromParam(entryId);
      if (!conversation || entryNumber === null) {
        await reply.code(404).send({ error: "File not found" });
        return;
      }
      const entry = await conversation.commit((tx) => tx.entry(entryNumber), context);
      const artifacts = (entry?.data as { artifacts?: unknown } | undefined)?.artifacts;
      const artifact = Array.isArray(artifacts)
        ? (artifacts as { id?: unknown; name?: unknown; mimeType?: unknown }[]).find(
            (candidate) => candidate.id === artifactId,
          )
        : undefined;
      if (!entry || entry.conversationId !== conversation.id || !artifact) {
        await reply.code(404).send({ error: "File not found" });
        return;
      }
      const bytes = await readArtifact(String(conversation.id), artifactId);
      if (!bytes) {
        await reply.code(404).send({ error: "File bytes are missing" });
        return;
      }
      const name = typeof artifact.name === "string" ? artifact.name : "file";
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\/\r\n]/g, "_");
      const encoded = encodeURIComponent(name).replace(/'/g, "%27");
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("content-disposition", 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded)
        .type(typeof artifact.mimeType === "string" ? artifact.mimeType : "application/octet-stream")
        .send(bytes);
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

    /** Aggregates behind the usage view: who answered, on which model, at what cost. */
    api.get("/usage", async (request) => {
      const query = (request.query ?? {}) as { fresh?: string };
      return usageReport(query.fresh === "1");
    });

    // ---------- display ----------

    /** The saved global display. The client applies it before the shell is shown. */
    api.get("/display", async () => displaySnapshot());

    api.put("/display", async (request, reply) => {
      try {
        return await updateDisplay((request.body ?? {}) as DisplayPatch, "owner");
      } catch (error) {
        if (error instanceof DisplayError) {
          await reply.code(error.status).send({ code: error.code, error: error.message });
          return;
        }
        throw error;
      }
    });

    api.post("/display/reset", async () => resetDisplay("owner"));

    // ---------- fleet and schedules ----------

    /** The compact roster and recent agent-to-agent links. Also sent over the presence socket. */
    api.get("/fleet", async () => fleetSnapshot());

    api.get("/schedules", async (request) => {
      const query = (request.query ?? {}) as { agentId?: string };
      return { schedules: await listSchedules(query.agentId), timezone: scheduleTimezone() };
    });

    api.post("/schedules", async (request, reply) => {
      try {
        return await createSchedule((request.body ?? {}) as ScheduleInput);
      } catch (error) {
        if (error instanceof ScheduleError) {
          await reply.code(error.status).send({ code: error.code, error: error.message });
          return;
        }
        throw error;
      }
    });

    /** Validate a cron expression without creating anything; the editor shows the next runs. */
    api.post("/schedules/preview", async (request, reply) => {
      const body = (request.body ?? {}) as { cron?: unknown; count?: unknown };
      const cron = typeof body.cron === "string" ? body.cron : "";
      const count = typeof body.count === "number" ? Math.max(1, Math.min(10, Math.floor(body.count))) : 5;
      try {
        return previewSchedule(cron, count);
      } catch (error) {
        if (error instanceof ScheduleError) {
          await reply.code(error.status).send({ code: error.code, error: error.message });
          return;
        }
        throw error;
      }
    });

    api.put("/schedules/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await updateSchedule(id, (request.body ?? {}) as SchedulePatch);
      } catch (error) {
        if (error instanceof ScheduleError) {
          await reply.code(error.status).send({ code: error.code, error: error.message });
          return;
        }
        throw error;
      }
    });

    api.delete("/schedules/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteSchedule(id);
      if (!ok) await reply.code(404).send({ code: "schedule_not_found", error: "Schedule not found" });
      return { ok };
    });

    api.post("/schedules/:id/run", async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await runScheduleNow(id);
        if (!result.accepted && result.reason === "previous run still working") {
          await reply.code(409).send({ code: "schedule_busy", error: "This schedule is already running." });
          return;
        }
        return result;
      } catch (error) {
        if (error instanceof ScheduleError) {
          await reply.code(error.status).send({ code: error.code, error: error.message });
          return;
        }
        throw error;
      }
    });

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

      // Deterministic schedule firing without waiting for a wall-clock minute.
      api.post("/e2e/schedules/:id/due", async (request, reply) => {
        const { id } = request.params as { id: string };
        const ok = await forceScheduleDue(id);
        if (!ok) await reply.code(404).send({ error: "Schedule not found" });
        return { ok };
      });

      api.post("/e2e/schedules/tick", async () => ({ attempted: await tickSchedules() }));
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

    const sendPresence = (ids: readonly string[]): void => {
      const frame = JSON.stringify({ type: "presence", active: [...ids] } satisfies WireFrame);
      for (const socket of presenceSockets) {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      }
    };

    const sendDisplay = (display: Awaited<ReturnType<typeof displaySnapshot>>): void => {
      const frame = JSON.stringify({ type: "display", display } satisfies WireFrame);
      for (const socket of presenceSockets) {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      }
    };

    const broadcastDisplay = (): void => {
      void displaySnapshot()
        .then(sendDisplay)
        .catch(() => undefined);
    };

    subscribeDisplay(broadcastDisplay);

    let fleetTimer: NodeJS.Timeout | undefined;
    const sendFleet = (): void => {
      if (fleetTimer) return;
      fleetTimer = setTimeout(() => {
        fleetTimer = undefined;
        if (presenceSockets.size === 0) return;
        void fleetSnapshot()
          .then((fleet) => {
            const frame = JSON.stringify({ type: "fleet", fleet } satisfies WireFrame);
            for (const socket of presenceSockets) {
              if (socket.readyState === socket.OPEN) socket.send(frame);
            }
          })
          .catch(() => undefined);
      }, 50);
      fleetTimer.unref?.();
    };

    subscribeActivity((ids) => {
      sendPresence(ids);
      sendFleet();
    });
    subscribeMesh(sendFleet);
    subscribeSchedules(sendFleet);

    api.get("/ws/presence", { websocket: true }, (socket: WebSocket) => {
      presenceSockets.add(socket);
      // Send the current state immediately: a tab that connects mid-generation must not wait for a change.
      socket.send(JSON.stringify({ type: "presence", active: activeIds() } satisfies WireFrame));
      void displaySnapshot()
        .then((display) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "display", display } satisfies WireFrame));
          }
        })
        .catch(() => undefined);
      void fleetSnapshot()
        .then((fleet) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "fleet", fleet } satisfies WireFrame));
          }
        })
        .catch(() => undefined);
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
    // Never leave an npm child writing node_modules while the next process starts another.
    stopScheduler();
    disposeSystem();
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host, port: serverPort });
startScheduler();
// Report the port that was actually bound: with PI_SERVER_PORT=0 the OS picks a free one, which is what
// the E2E harness relies on so scenarios never collide.
const address = app.server.address();
const actualPort = address && typeof address === "object" ? address.port : serverPort;
console.log("server ready at http://" + host + ":" + actualPort + " (data: " + dataDir + ")");
// Handshake line: read by the desktop shell or scripts when the port and token must be discovered.
console.log("PI_SERVER_READY " + JSON.stringify({ port: actualPort, token }));