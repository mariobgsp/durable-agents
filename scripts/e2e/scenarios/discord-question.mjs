import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-question",
  async run() {
    const h = await startHarness({
      platform: "discord",
      script: [{ toolCall: { name: "question", arguments: { text: "Pick a fruit", options: ["Apple", "Banana"] } } }],
    });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      h.discordDM("main", "ask me");
      const question = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.content.includes("Pick a fruit")),
        25_000,
        "the question message",
      );
      assert.ok(question.components?.length > 0, "the question carries components");
      const session = (await h.client.request("sessions.list"))[0];
      const customId = question.components[0].components[0].custom_id;
      h.discordClick("main", customId, { channelId: "dm-" + h.owner, messageId: question.messageId });
      await h.waitFor(async () => {
        const transcript = await h.client.request("sessions.transcript", { id: session.id });
        return transcript.some((entry) => entry.role === "user" && entry.text === "Apple");
      }, 20_000, "the option submitted as a user message");
    } finally {
      await h.stop();
    }
  },
};
