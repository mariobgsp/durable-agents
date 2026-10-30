import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

/**
 * The agent-facing Discord tool.
 *
 * It is installed only by the Discord runtime, only while Discord is the active surface. That is why a
 * Telegram agent can keep `discord` in its tool list without ever seeing an unusable tool: the registry
 * simply has no tool by that name.
 */
export type DiscordBridge = {
  sendMessage(input: { channelId: string; content: string }): Promise<{ messageId: string }>;
  createThread(input: { channelId: string; name: string }): Promise<{ threadId: string }>;
  archiveThread(input: { threadId: string }): Promise<void>;
  listThreads(input: { guildId: string; channelId?: string }): Promise<{ id: string; name: string; parentId?: string; archived: boolean }[]>;
  serverInfo(input: { guildId: string }): Promise<{ id: string; name: string; ownerId?: string }>;
  moderate(input: {
    guildId: string;
    userId: string;
    action: "timeout" | "kick" | "ban" | "warn";
    reason: string;
    minutes?: number;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
};

function refusal(text: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text" as const, text }], isError: true };
}

export function createDiscordToolsExtension(bridge: DiscordBridge): Extension {
  const discordTool = defineTool({
    name: "discord",
    description:
      "Act on the active Discord bot: send a message, create or archive a thread, list active threads, " +
      "read a guild's identity, or moderate a member when agent moderation is enabled. Discord ids are " +
      "snowflakes; pass them as strings. Threads created here are Discord threads; use the chat /new " +
      "command when the thread should also become a durable session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("send"),
        Type.Literal("create_thread"),
        Type.Literal("archive_thread"),
        Type.Literal("list_threads"),
        Type.Literal("server_info"),
        Type.Literal("moderate"),
      ]),
      channelId: Type.Optional(Type.String({ description: "Channel id for send/create_thread" })),
      threadId: Type.Optional(Type.String({ description: "Thread id for archive_thread" })),
      guildId: Type.Optional(Type.String({ description: "Guild id for list_threads/server_info/moderate" })),
      userId: Type.Optional(Type.String({ description: "Member id for moderate" })),
      name: Type.Optional(Type.String({ description: "Thread name for create_thread" })),
      content: Type.Optional(Type.String({ description: "Message content for send" })),
      moderationAction: Type.Optional(Type.Union([
        Type.Literal("timeout"),
        Type.Literal("kick"),
        Type.Literal("ban"),
        Type.Literal("warn"),
      ])),
      reason: Type.Optional(Type.String({ description: "Required for moderate" })),
      minutes: Type.Optional(Type.Number({ description: "Timeout minutes for moderate timeout" })),
    }),
    async execute(args) {
      try {
        switch (args.action) {
          case "send": {
            if (!args.channelId || !args.content?.trim()) return refusal("send needs channelId and content");
            const result = await bridge.sendMessage({ channelId: args.channelId, content: args.content });
            return { output: [{ type: "text" as const, text: "Sent Discord message " + result.messageId + " to " + args.channelId + "." }] };
          }
          case "create_thread": {
            if (!args.channelId || !args.name?.trim()) return refusal("create_thread needs channelId and name");
            const result = await bridge.createThread({ channelId: args.channelId, name: args.name });
            return { output: [{ type: "text" as const, text: "Created Discord thread " + result.threadId + " under " + args.channelId + "." }] };
          }
          case "archive_thread": {
            if (!args.threadId) return refusal("archive_thread needs threadId");
            await bridge.archiveThread({ threadId: args.threadId });
            return { output: [{ type: "text" as const, text: "Archived Discord thread " + args.threadId + "." }] };
          }
          case "list_threads": {
            if (!args.guildId) return refusal("list_threads needs guildId");
            const threads = await bridge.listThreads({ guildId: args.guildId, ...(args.channelId ? { channelId: args.channelId } : {}) });
            const text = threads.length
              ? threads.map((thread) => "· " + thread.name + " · " + thread.id + (thread.parentId ? " · parent " + thread.parentId : "")).join("\n")
              : "No active threads.";
            return { output: [{ type: "text" as const, text }], details: threads as never };
          }
          case "server_info": {
            if (!args.guildId) return refusal("server_info needs guildId");
            const guild = await bridge.serverInfo({ guildId: args.guildId });
            return { output: [{ type: "text" as const, text: guild.name + " · " + guild.id + (guild.ownerId ? " · owner " + guild.ownerId : "") }], details: guild as never };
          }
          case "moderate": {
            if (!args.guildId || !args.userId || !args.moderationAction || !args.reason?.trim()) {
              return refusal("moderate needs guildId, userId, moderationAction and reason");
            }
            const result = await bridge.moderate({
              guildId: args.guildId,
              userId: args.userId,
              action: args.moderationAction,
              reason: args.reason,
              ...(args.minutes !== undefined ? { minutes: args.minutes } : {}),
            });
            return result.ok
              ? { output: [{ type: "text" as const, text: result.text }] }
              : refusal(result.error);
          }
          default:
            return refusal("unknown Discord action");
        }
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  });
  return defineExtension({ name: "discord", tools: [discordTool] });
}
