import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-plan",
  async run() {
    const h = await startHarness({
      script: [{ text: "Plan: 1. Inspect the router. 2. Add the middleware. 3. Test." }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "/plan add request logging");
      const edit = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Plan: 1. Inspect")),
        25_000,
        "the plan answer",
      );
      assert.ok(edit, "plan answer arrived");
      const sessions = await h.client.request("sessions.list");
      assert.equal(sessions.length, 1, "the plan created one thread");
      const transcript = await h.client.request("sessions.transcript", { id: sessions[0].id });
      const prompt = transcript.find((entry) => entry.role === "user" && entry.text.startsWith("Plan only."));
      assert.ok(prompt, "the plan instruction was submitted");
      assert.ok(prompt.text.includes("add request logging"), "the goal is in the prompt");
    } finally {
      await h.stop();
    }
  },
};
