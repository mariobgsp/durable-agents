import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-chat",
  async run() {
    const h = await startHarness({
      platform: "discord",
      script: [{ text: "Hello from Discord." }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      h.discordDM("main", "hi there");
      const edit = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.content.includes("Hello from Discord.")),
        25_000,
        "the final Discord edit",
      );
      assert.ok(edit, "final edit");
      assert.ok(h.fake.sent("main").some((message) => message.content.includes("Think")), "a placeholder was sent");
      const sessions = await h.client.request("sessions.list");
      assert.equal(sessions.length, 1, "one durable session");
      assert.equal(sessions[0].channel?.kind, "discord");
      assert.equal(sessions[0].channel?.bot, "main");
      assert.equal(sessions[0].agent, "helper");
      const transcript = await h.client.request("sessions.transcript", { id: sessions[0].id });
      assert.ok(transcript.some((entry) => entry.role === "assistant" && entry.text.includes("Hello from Discord.")), "durable answer");
    } finally {
      await h.stop();
    }
  },
};
