import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { harnessInstance } from "./harness.ts";
import { agentResolver } from "./remember.ts";

/**
 * The `question` tool: ask the user, and end the turn.
 *
 * The question is not model text — it is a `chat.question` entry. The transcript already renders any entry with
 * `text` and `author` as an assistant bubble, so the existing mapper needs no special case; `data.options` is what
 * the client reads to draw the answer buttons. The answer itself is an ordinary user message, which is why the
 * tool writes nothing else and why the model is told its turn is over.
 */
export const questionTool = defineTool({
  name: "question",
  description:
    "Ask the user a direct question when the thread does not settle the choice. The question appears in the " +
    "conversation with your options as buttons. Your turn ends with this call: the answer arrives as the next " +
    "user message.",
  parameters: Type.Object({
    text: Type.String({ description: "The question, as one sentence the user can answer." }),
    options: Type.Array(Type.String({ description: "One short answer." }), {
      description: "Answers to offer as buttons, best first. May be empty when the user should type the answer.",
    }),
  }),
  async execute(args, api, context) {
    // One tool serves every conversation, so the owning agent is resolved the same way `remember` resolves it.
    const agentId = await agentResolver()?.(String(api.conversationId));
    if (!agentId) {
      return {
        output: [{ type: "text" as const, text: "This thread has no agent, so the question cannot be attributed." }],
        isError: true,
      };
    }
    // The harness handle, not `api.conversation()`: that one only accepts input submissions, and this is a passive
    // entry write (it changes nothing the model sees, so pi-durable appends it even while this run is active).
    const conversation = await harnessInstance().conversation(api.conversationId, context);
    if (!conversation) {
      return {
        output: [{ type: "text" as const, text: "This conversation no longer exists, so the question was not shown." }],
        isError: true,
      };
    }
    await conversation.submit(
      {
        type: "write",
        entry: { kind: "chat.question", data: { text: args.text, author: agentId, options: args.options } },
      },
      context,
    );
    return {
      output: [
        {
          type: "text" as const,
          text: "Question shown to the user. Your turn is over: the answer arrives as the next user message.",
        },
      ],
    };
  },
});
