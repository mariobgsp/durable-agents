import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, ToolTask, type Extension, type ToolHookCall } from "@earendil-works/pi-durable";
import { readAgent, type AgentRecord } from "./agents.ts";
import { agentResolver } from "./remember.ts";

/**
 * What an agent is allowed to do — a **policy** boundary, not a security boundary.
 *
 * The distinction is the whole point of this file, and the UI repeats it: a blocked call here stops an
 * accident or a prompt-injected instruction from reaching a tool, but an allowed tool still runs with the
 * operating-system permissions of the user who started the server. There is no sandbox in this process, and
 * `pi`'s own security documentation says the same about itself. The boundary that actually contains a wrong
 * or hostile action is the systemd unit (`deploy/dura-agents.service`), which is why the app reports which
 * of the two is in force rather than implying the tier is enough.
 */

export type PermissionTier = "standard" | "custom" | "full";

export type PermissionPolicy = {
  tier: PermissionTier;
  /** Tools this agent may not call. Only Custom uses this. */
  blockedTools: string[];
  /** Extra roots a scoped agent may reach, beyond its own `cwd`. */
  allowedPaths: string[];
};

/**
 * The two tools that can reach anything the user can.
 *
 * A shell runs any command with the user's permissions, and code mode runs a program that calls the other
 * tools. A tier called "Standard" that left both switched on would be a rename of Full Access, so Standard
 * refuses them by name.
 */
export const ESCAPE_HATCHES = ["bash", "codemode"] as const;

/** Tools whose `path` argument is checked against the agent's roots. */
const PATH_TOOLS = new Set(["read", "write", "edit"]);

/**
 * The policy for one agent.
 *
 * A record written before this existed has no `permissions` field. It is inferred rather than defaulted:
 * an agent that already had `bash` or `codemode` is reported as `full`, because silently taking away a
 * capability it has been using would be a surprise, and labelling it is the honest fix — the tier becomes
 * visible in the editor and in the thread instead of staying implicit.
 */
export function policyOf(record: Pick<AgentRecord, "permissions" | "tools" | "blockedTools" | "allowedPaths">): PermissionPolicy {
  const tools = record.tools ?? [];
  const tier =
    record.permissions ?? (tools.some((tool) => ESCAPE_HATCHES.includes(tool as (typeof ESCAPE_HATCHES)[number])) ? "full" : "standard");
  return {
    tier,
    blockedTools: record.blockedTools ?? [],
    allowedPaths: record.allowedPaths ?? [],
  };
}

export type PermissionDenial = { reason: string };

/**
 * A grant lifts one conversation to Full Access, and only that conversation.
 *
 * Non-sticky by construction: nothing here writes to the agent, and the record it reads belongs to a single
 * thread, so the next thread the agent starts is back at the agent's own tier.
 */
export function withGrant(policy: PermissionPolicy, granted: "full" | undefined): PermissionPolicy {
  return granted === "full" ? { ...policy, tier: "full" } : policy;
}

/**
 * Where a conversation's grant comes from.
 *
 * Set by the server at boot (`index.ts`) rather than imported: this module is installed into the harness, and
 * reaching into the session index from here would close a module cycle through `attachments` and `harness`.
 * It is the same pattern `remember.ts` uses to find the owning agent.
 */
let resolveGrant: ((conversationId: string) => Promise<"full" | undefined>) | undefined;

export function setGrantResolver(
  resolver: (conversationId: string) => Promise<"full" | undefined>,
): void {
  resolveGrant = resolver;
}

/**
 * Whether this call may run, and if not, the sentence the user will read.
 *
 * Pure: the caller supplies the policy and the roots, so the rules can be reasoned about — and tested —
 * without a harness, a conversation or a file system.
 */
export function denialFor(
  policy: PermissionPolicy,
  call: Pick<ToolHookCall, "name" | "arguments">,
  roots: { cwd?: string; allowedPaths?: string[] },
): PermissionDenial | undefined {
  if (policy.tier === "full") return undefined;

  const blocked = policy.blockedTools.find((pattern) => matches(pattern, call.name));
  if (blocked !== undefined) {
    return {
      reason: `${call.name} is blocked for this agent by its Custom permissions (rule: ${blocked}).`,
    };
  }

  if (policy.tier === "standard" && ESCAPE_HATCHES.includes(call.name as (typeof ESCAPE_HATCHES)[number])) {
    return {
      reason:
        `${call.name} is not available to a Standard agent, because it can reach anything you can. ` +
        `Switch this agent to Custom or Full Access to allow it.`,
    };
  }

  if (!PATH_TOOLS.has(call.name)) return undefined;
  const path = call.arguments?.["path"];
  if (typeof path !== "string" || path.length === 0) return undefined;

  const cwd = roots.cwd ?? process.cwd();
  const searchRoots = [cwd, ...(roots.allowedPaths ?? []), ...policy.allowedPaths];
  const target = isAbsolute(path) ? path : resolve(cwd, path);
  if (searchRoots.some((root) => contains(root, target))) return undefined;

  return {
    reason:
      `${path} is outside this agent's root (${cwd}). ` +
      `Add it to the agent's allowed paths, or switch the agent to Full Access.`,
  };
}

/** True when `target` is `root` itself or lives under it. */
function contains(root: string, target: string): boolean {
  const base = resolve(root);
  const resolved = resolve(target);
  if (base === resolved) return true;
  const step = relative(base, resolved);
  return step.length > 0 && !step.startsWith("..") && !isAbsolute(step);
}

/** A tool name, or a pattern with `*` wildcards (`mcp__*`, `bash`). */
function matches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const expression = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return expression.test(name);
}

function escapeRegExp(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The hook that enforces a policy, installed once in `harness.ts`.
 *
 * The agent is resolved from the conversation at call time, not captured at boot: a group member's
 * conversation, a thread moved to another agent, and an edit to `agent.json` all have to take effect on the
 * next call rather than on the next restart.
 */
export function permissionsExtension(): Extension {
  return defineExtension({
    name: "permissions",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call: ToolHookCall, api: { conversationId: unknown }, _context: Context) => {
          const resolveAgent = agentResolver();
          if (!resolveAgent) return undefined;
          const agentId = await resolveAgent(String(api.conversationId));
          if (!agentId) return undefined;
          const files = await readAgent(agentId);
          if (!files) return undefined;
          const granted = resolveGrant ? await resolveGrant(String(api.conversationId)) : undefined;
          const denial = denialFor(withGrant(policyOf(files.record), granted), call, files.record);
          return denial === undefined ? undefined : { block: denial.reason };
        },
      }),
    ],
  });
}
