import { listAgents } from "./agents.ts";
import { reloadTools } from "./harness.ts";
import { reconcileMesh } from "./mesh.ts";
import { reconcileSchedules } from "./schedules.ts";
import { rebindAgent } from "./sessions.ts";

/** Reload the tool registry and rebuild every conversation; also the body of /reload. */
export async function reloadEverything(): Promise<{ extensions: string[]; rebound: number }> {
  const { reloadMcp } = await import("./mcp.ts");
  await reloadMcp().catch(() => undefined);
  const extensions = reloadTools();
  let rebound = 0;
  for (const agent of await listAgents()) rebound += await rebindAgent(agent.id);
  await reconcileMesh().catch(() => undefined);
  await reconcileSchedules().catch(() => undefined);
  return { extensions, rebound };
}
