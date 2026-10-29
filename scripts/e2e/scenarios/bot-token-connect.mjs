import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

export default {
  name: "bot-token-connect",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bot_connect", arguments: { agent: "worker", token: "1004:fourth" } } },
        { text: "Connected worker." },
      ],
      agents: [
        { id: "orchestrator", name: "Orchestrator" },
        { id: "worker", name: "Worker" },
        { id: "worker2", name: "Worker Two" },
      ],
      orchestrator: "orchestrator",
    });
    try {
      h.fake.addBot({ label: "third", username: "thirdbot", id: 1003, token: "1003:third" });
      h.fake.addBot({ label: "fourth", username: "fourthbot", id: 1004, token: "1004:fourth" });

      // A bare /connect answers with usage instead of failing to parse HTML.
      h.text("main", 100, "/connect");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Usage: /connect")),
        15_000,
        "the connect usage reply",
      );

      // The orchestrator pairs a bot from a token through its tool; no browser involved.
      h.text("main", 100, "connect worker using token 1004:fourth");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Connected worker.")),
        30_000,
        "the orchestrator confirmation",
      );
      let agents = await h.client.request("agents.list");
      assert.equal(agents.find((agent) => agent.id === "worker")?.telegramBot, "fourth");

      // The owner command does the same and deletes the message carrying the token.
      const commandId = h.text("main", 100, "/connect worker2 1003:third");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Connected @thirdbot")),
        30_000,
        "the command confirmation",
      );
      agents = await h.client.request("agents.list");
      assert.equal(agents.find((agent) => agent.id === "worker2")?.telegramBot, "third");
      assert.ok(
        h.fake.deletedMessages("main").some((entry) => entry.messageId === commandId),
        "the token message was deleted",
      );
      const registry = JSON.parse(await readFile(resolve(h.home, "secrets", "telegram.json"), "utf8"));
      assert.ok(registry.bots.some((bot) => bot.label === "third"), "the new bot is in the registry");
    } finally {
      await h.stop();
    }
  },
};
