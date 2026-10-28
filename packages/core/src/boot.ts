import { mkdir, readFile } from "node:fs/promises";
import { ensureAgentTmp, listAgents } from "./agents.ts";
import { enableE2E } from "./e2e.ts";
import { openHarness } from "./harness.ts";
import { errorFields, log } from "./logger.ts";
import { reconcileMesh } from "./mesh.ts";
import { setGrantResolver } from "./permissions.ts";
import { hydrateOrchestrator } from "./orchestrator.ts";
import { setAgentResolver } from "./remember.ts";
import { reconcileSchedules } from "./schedules.ts";
import {
  agentForConversation,
  allSessionRecords,
  findSession,
  trackIfBusy,
} from "./sessions.ts";
import {
  cacheDir,
  duraHome,
  exportsDir,
  logsDir,
  runDir,
  secretsDir,
  telegramDir,
  telegramTmpDir,
} from "./paths.ts";

/**
 * Everything that must exist before a transport, an IPC client or a scheduled run touches the app:
 * the home layout, the harness (with resume), the two shared resolvers, agent scratch directories,
 * boot-time activity marks, and reconciled schedules and mesh links.
 *
 * Order matters. E2E replaces the providers before the harness opens; resolvers are installed before
 * any tool can run; recovery happens after resume() has rescheduled durable work.
 */
export async function boot(): Promise<{ startedAt: number; agents: number; sessions: number }> {
  const startedAt = Date.now();
  for (const dir of [duraHome, runDir, logsDir, secretsDir, telegramDir, telegramTmpDir, cacheDir, exportsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const e2e = process.env.DURA_E2E === "1" || process.env.PI_E2E === "1";
  if (e2e) enableE2E();
  if (process.env.DURA_BENCH === "1") {
    const { enableBench } = await import("./e2e.ts");
    enableBench();
  } else if (e2e && process.env.DURA_E2E_SCRIPT_FILE) {
    const { setE2EScript } = await import("./e2e.ts");
    const steps = JSON.parse(await readFile(process.env.DURA_E2E_SCRIPT_FILE, "utf8")) as import("./e2e.ts").E2EStep[];
    setE2EScript(steps);
  }
  await openHarness();
  log.info("harness.open", { e2e, home: duraHome });
  // MCP servers are global; connect them before conversations are configured so every agent sees the tools.
  const { startMcp } = await import("./mcp.ts");
  await startMcp().catch((error) => log.warn("mcp.start_failed", errorFields(error)));

  const agents = await listAgents();
  for (const agent of agents) await ensureAgentTmp(agent.id);
  setAgentResolver(agentForConversation);
  setGrantResolver(async (conversationId) => (await findSession(conversationId))?.grant);
  // Prime the synchronous orchestrator cache before any conversation is reconfigured.
  await hydrateOrchestrator();
  // One bot is one agent. A migrated state where several agents name the same bot is repaired here:
  // keep the orchestrator (or the first agent) and unassign the rest instead of ambiguous DM routing.
  const { normalizeBotAssignments } = await import("./agent-admin.ts");
  const normalized = await normalizeBotAssignments().catch((error) => {
    log.warn("boot.bot_normalize_failed", errorFields(error));
    return [];
  });
  if (normalized.length > 0) log.warn("boot.bots_normalized", { cleared: normalized.length });
  // Rebuild existing conversations once so MCP tools and pairing changes are live without /reload.
  const { rebindAgent } = await import("./sessions.ts");
  for (const agent of agents) await rebindAgent(agent.id).catch(() => 0);

  const records = await allSessionRecords();
  for (const record of records) {
    void trackIfBusy(String(record.id));
    for (const memberId of Object.values(record.room?.conversations ?? {})) {
      void trackIfBusy(String(memberId));
    }
  }

  await reconcileSchedules();
  await reconcileMesh();
  log.info("boot.ready", { agents: agents.length, sessions: records.length, ms: Date.now() - startedAt });
  return { startedAt, agents: agents.length, sessions: records.length };
}

/** Close the harness cleanly; a failure here must not stop the process from exiting. */
export async function closeHarness(): Promise<void> {
  try {
    const { harnessInstance, context } = await import("./harness.ts");
    await harnessInstance().close(context);
  } catch (error) {
    log.warn("harness.close_failed", errorFields(error));
  }
}
