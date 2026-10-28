import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-orchestrator",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "agent_create", arguments: { name: "Scout", responsibility: "looks ahead" } } },
        { text: "Created Scout." },
      ],
      agents: [{ id: "orchestrator", name: "Orchestrator" }],
      orchestrator: "orchestrator",
    });
    try {
      h.text("main", 100, "create an agent called Scout");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Created Scout.")),
        30_000,
        "the orchestrator's final answer",
      );
      const agents = await h.client.request("agents.list");
      const scout = agents.find((agent) => agent.id === "scout");
      assert.ok(scout, "Scout exists");
      assert.equal(scout.telegramBot, undefined, "a second agent cannot share the orchestrator bot");
      assert.equal(scout.provider, "e2e");
      assert.equal(scout.permissions, "full", "new agents default to full access");
      const files = await h.client.request("agents.show", { id: "scout" });
      assert.ok(files.agentMd.includes("Role"), "AGENT.md was generated");
    } finally {
      await h.stop();
    }
  },
};
