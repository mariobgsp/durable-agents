import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { appendMemory } from "./agents.ts";
import { appendPreference } from "./preferences.ts";

/**
 * The `remember` tool: the agent's only way to write its own MEMORY.md.
 *
 * One tool serves every conversation, so it cannot be bound to an agent at install time. The owning agent is
 * resolved from `api.conversationId` through a resolver the server wires at boot (see index.ts), which also
 * keeps this module out of an import cycle with the session index.
 */
let resolveAgent = async (_conversationId: string): Promise<string | undefined> => undefined;

export function setAgentResolver(resolver: (conversationId: string) => Promise<string | undefined>): void {
  resolveAgent = resolver;
}

/**
 * The same resolver, for the other shared hooks that need it.
 *
 * `permissions.ts` applies a different policy per agent, and it is installed before the server has an index
 * to resolve against, so it has to ask for the resolver at call time rather than capture it at install time.
 */
export function agentResolver(): ((conversationId: string) => Promise<string | undefined>) | undefined {
  return resolveAgent;
}

export const rememberTool = defineTool({
  name: "remember",
  description:
    "Save one durable fact to your own memory, which is shown to you in every future thread. Use it for stable " +
    "things: who the user is, how they want work done, decisions already made. Do not use it for the task you " +
    "are in the middle of, and do not save secrets.",
  parameters: Type.Object({
    note: Type.String({
      description: "One self-contained sentence, understandable without today's conversation",
    }),
  }),
  async execute(args, api) {
    const agentId = await resolveAgent(String(api.conversationId));
    const reply = async (text: string) => ({ output: [{ type: "text" as const, text }] });
    if (!agentId) {
      return reply("This thread has no agent, so there is no memory to write to.");
    }
    const saved = await appendMemory(agentId, args.note);
    return reply((saved.saved ? "Remembered: " : "Already in memory: ") + saved.line);
  },
});

/**
 * The `prefer` tool: one standing instruction from the owner, stored once for the whole fleet.
 *
 * It is separate from `remember` because the two have different owners and different lifetimes. A memory
 * note is what this agent learned; a preference is what the owner wants, and every agent — including ones
 * created next month — has to follow it. When the owner says "always answer in Indonesian" or "ask before
 * touching the network", that belongs here rather than in five MEMORY.md files.
 */
export const preferTool = defineTool({
  name: "prefer",
  description:
    "Save one standing preference of the owner that applies to the whole fleet, not just this agent. Use it " +
    "when they state how they want work done (language, tone, tools, approvals, conventions) or when they " +
    "correct you in a way that should hold next time. Do not use it for task details, and never for secrets.",
  parameters: Type.Object({
    note: Type.String({
      description: "One self-contained sentence that still makes sense months later, without today's context",
    }),
  }),
  async execute(args) {
    const reply = async (text: string) => ({ output: [{ type: "text" as const, text }] });
    const saved = await appendPreference(args.note);
    return reply((saved.saved ? "Saved for every agent: " : "Already a fleet preference: ") + saved.line);
  },
});
