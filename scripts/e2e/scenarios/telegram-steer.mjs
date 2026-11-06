import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-steer",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 3" } } },
        { text: "done after steer" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "first request");
      // The placeholder is the honest signal that the run is live: `status.runs.active` counts the run
      // limiter, which nothing acquires yet, so it reads 0 while a run is generating.
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Think")),
        15_000,
        "the first run",
      );
      h.text("main", 100, "second request while running");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Steer ·")),
        15_000,
        "the steering notice",
      );
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("done after steer")),
        25_000,
        "the answer after steering",
      );
      const sessions = await h.client.request("sessions.list");
      const entries = await h.client.request("sessions.transcript", { id: sessions[0].id });
      const userTexts = entries.filter((entry) => entry.role === "user").map((entry) => entry.text);
      assert.ok(userTexts.includes("first request"));
      assert.ok(userTexts.includes("second request while running"), "the steer was placed in the run");
    } finally {
      await h.stop();
    }
  },
};
