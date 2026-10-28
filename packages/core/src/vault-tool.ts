import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { harnessInstance } from "./harness.ts";
import { agentResolver } from "./remember.ts";
import { deleteSecret, listSecrets } from "./vault-store.ts";

/**
 * The owner-facing vault tool: request, list, delete. There is no read action on purpose.
 *
 * A model that could read a password would put it in the next request, in the transcript and in the provider's
 * logs. The browser tool is the one consumer of a decrypted value, and it can type it into a field without the
 * value ever entering a tool result. This module is loaded lazily, so a thread that never touches credentials
 * does not pay for its graph.
 */
export const vaultTool = defineTool({
  name: "vault",
  description:
    "Credentials live here, encrypted, and are never shown in this conversation. Use action=request to ask the " +
    "owner for a login (they type it into a masked form, not the chat), action=list to see labels and masked " +
    "entries, action=delete to remove one. You cannot read a secret value; the browser tool can fill it into a " +
    "page without revealing it.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("request"), Type.Literal("list"), Type.Literal("delete")]),
    label: Type.Optional(Type.String({ description: "For request: what this credential is for, e.g. GitHub." })),
    purpose: Type.Optional(Type.String({ description: "For request: one line the owner sees above the form." })),
    url: Type.Optional(Type.String({ description: "For request: the sign-in page the credential belongs to." })),
    id: Type.Optional(Type.String({ description: "For delete: the entry id from action=list." })),
  }),
  async execute(args, api, context) {
    if (args.action === "list") {
      const entries = listSecrets();
      return {
        output: [
          {
            type: "text" as const,
            text:
              entries.length === 0
                ? "The vault is empty. Use action=request to ask the owner for a login."
                : entries
                    .map(
                      (entry) =>
                        "- " + entry.label + " (" + entry.id + ")" + (entry.url ? " · " + entry.url : "") +
                        " · " + entry.masked,
                    )
                    .join("\n"),
          },
        ],
      };
    }

    if (args.action === "delete") {
      const id = (args.id ?? "").trim();
      if (!id) {
        return { output: [{ type: "text" as const, text: "Pass the entry id from action=list." }], isError: true };
      }
      const removed = deleteSecret(id);
      return {
        output: [
          {
            type: "text" as const,
            text: removed ? "Deleted vault entry " + id + "." : "No vault entry " + id + " exists.",
          },
        ],
        ...(removed ? {} : { isError: true as const }),
      };
    }

    // request: one durable entry the client renders as a masked form. The turn ends here, exactly like a
    // question, because the answer is the owner's submission rather than a message the model composed.
    const label = (args.label ?? "").trim();
    if (!label) {
      return {
        output: [{ type: "text" as const, text: "A credential request needs a label, e.g. GitHub." }],
        isError: true,
      };
    }
    const agentId = await agentResolver()?.(String(api.conversationId));
    if (!agentId) {
      return {
        output: [{ type: "text" as const, text: "This thread has no agent, so the request cannot be attributed." }],
        isError: true,
      };
    }
    const conversation = await harnessInstance().conversation(api.conversationId, context);
    if (!conversation) {
      return {
        output: [{ type: "text" as const, text: "This conversation no longer exists, so the form was not shown." }],
        isError: true,
      };
    }
    const purpose = (args.purpose ?? "").trim();
    await conversation.submit(
      {
        type: "write",
        entry: {
          kind: "chat.secret-request",
          data: {
            text:
              "Send the credentials for " + label + " in the masked form below. They go straight into the " +
              "encrypted vault and are never written to this chat.",
            author: agentId,
            label,
            ...(purpose ? { purpose } : {}),
            ...(args.url ? { url: String(args.url).slice(0, 2000) } : {}),
          },
        },
      },
      context,
    );
    return {
      output: [
        {
          type: "text" as const,
          text:
            "Masked form shown for " + label + ". Your turn is over: the owner's submission arrives as a " +
            "notification, and you will never see the value itself.",
        },
      ],
    };
  },
});
