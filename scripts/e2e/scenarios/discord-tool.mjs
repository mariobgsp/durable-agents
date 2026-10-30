import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-tool",
  async run() {
    const h = await startHarness({
      platform: "discord",
      script: [
        { toolCall: { name: "discord", arguments: { action: "create_thread", channelId: "c1", name: "Agent thread" } } },
        { text: "Created it." },
      ],
    });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      h.discordDM("main", "make a thread");
      await h.waitFor(() => h.fake.threads("main").find((thread) => thread.name === "Agent thread"), 20_000, "agent-created thread");
      await h.waitFor(() => h.fake.edits("main").find((message) => message.content.includes("Created it.")), 20_000, "the agent answer");
    } finally {
      await h.stop();
    }
  },
};
