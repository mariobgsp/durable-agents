import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { appendMemory } from "./agents.ts";

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
