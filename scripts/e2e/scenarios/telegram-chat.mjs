import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-chat",
  async run() {
    const h = await startHarness({
      script: [{ text: "Hello from the faux model." }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "hi there");
      const edit = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Hello from the faux model.")),
        25_000,
        "the final answer edit",
      );
      assert.ok(edit, "final edit");
      assert.ok(
        h.fake.sent("main").some((message) => message.text.includes("thinking")),
        "a placeholder was sent before the answer",
      );
      const sessions = await h.client.request("sessions.list");
      assert.equal(sessions.length, 1, "one durable session");
      assert.equal(sessions[0].channel?.bot, "main", "the session records its bot");
      assert.equal(sessions[0].agent, "helper");
      const transcript = await h.client.request("sessions.transcript", { id: sessions[0].id });
      assert.ok(
        transcript.some((entry) => entry.role === "assistant" && entry.text.includes("Hello from the faux model.")),
        "the answer is durable in the transcript",
      );
    } finally {
      await h.stop();
    }
  },
};
