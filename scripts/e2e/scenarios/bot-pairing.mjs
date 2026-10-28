import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "bot-pairing",
  async run() {
    const h = await startHarness({
      bots: [
        { label: "main", username: "mainbot", id: 1001, token: "1001:main" },
        { label: "second", username: "secondbot", id: 1002, token: "1002:second" },
        { label: "spare", username: "sparebot", id: 1003, token: "1003:spare" },
      ],
      script: [
        { text: "helper here." },
        { toolCall: { name: "bot_assign", arguments: { bot: "spare", agent: "helper" } } },
        { text: "Connected spare to helper." },
      ],
      agents: [
        { id: "orchestrator", name: "Orchestrator" },
        { id: "helper", name: "Helper", telegramBot: "second" },
        { id: "worker", name: "Worker" },
      ],
      orchestrator: "orchestrator",
    });
    try {
      // A bot routes to its paired agent, not to the orchestrator.
      h.text("second", 200, "hello");
      await h.waitFor(
        () => h.fake.edits("second").find((entry) => entry.text.includes("helper here.")),
        25_000,
        "the helper answer on its own bot",
      );
      const sessions = await h.client.request("sessions.list");
      assert.ok(sessions.some((session) => session.agent === "helper" && session.channel?.bot === "second"));

      // An unpaired bot offers pairing instead of silently answering as another agent.
      h.text("spare", 300, "hello");
      const pairing = await h.waitFor(
        () => h.fake.sent("spare").find((message) => message.text.includes("has no agent")),
        15_000,
        "the pairing prompt",
      );
      assert.ok(JSON.stringify(pairing.replyMarkup).includes("botassign:spare|"), "the prompt lists unpaired agents");

      // The orchestrator can move a bot to an agent; the previous pair is released.
      h.text("main", 100, "connect spare to helper");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Connected spare to helper.")),
        30_000,
        "the orchestrator confirmation",
      );
      const agents = await h.client.request("agents.list");
      const helper = agents.find((agent) => agent.id === "helper");
      assert.equal(helper.telegramBot, "spare", "helper moved to the new bot");
    } finally {
      await h.stop();
    }
  },
};
