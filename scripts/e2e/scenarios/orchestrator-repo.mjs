import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "orchestrator-repo",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "repo_info", arguments: {} } },
        { toolCall: { name: "system_apply", arguments: { check: false, restart: true } } },
        { text: "Repo checked." },
      ],
      agents: [{ id: "orchestrator", name: "Orchestrator" }],
      orchestrator: "orchestrator",
    });
    try {
      h.text("main", 100, "where is the system repo?");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Repo checked.")),
        25_000,
        "the orchestrator answer",
      );
      const sessions = await h.client.request("sessions.list");
      const entries = await h.client.request("sessions.transcript", { id: sessions[0].id });
      const tool = entries.find((entry) => entry.role === "tool" && entry.text.includes("Repo:"));
      assert.ok(tool, "repo_info returned the checkout");
      assert.match(tool.text, /Repo:|Branch/);
      const applied = entries.find((entry) => entry.role === "tool" && entry.text.includes("restart"));
      assert.ok(applied, "system_apply returned the restart result");
      assert.ok(applied.text.includes("e2e dry-run"));
    } finally {
      await h.stop();
    }
  },
};
