import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

export default {
  name: "orchestrator-claim",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "orchestrator_claim" } },
        { text: "I am the orchestrator now." },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "take over as the orchestrator");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("I am the orchestrator now.")),
        30_000,
        "the agent's confirmation",
      );
      const config = JSON.parse(await readFile(resolve(h.home, "config.json"), "utf8"));
      assert.equal(config.orchestrator.agentId, "helper", "the claimant became the orchestrator");
      const agents = await h.client.request("agents.list");
      assert.ok(agents.some((agent) => agent.id === "helper"));
      // The owner is told about the bootstrap claim.
      assert.ok(
        h.fake.sent("main").some((message) => message.text.includes("is now the orchestrator")),
        "owner notified",
      );
    } finally {
      await h.stop();
    }
  },
};
