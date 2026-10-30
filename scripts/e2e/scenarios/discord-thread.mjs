import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-thread",
  async run() {
    const h = await startHarness({ platform: "discord", script: [{ text: "Thread answer." }] });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      h.discordSlash("main", "new", [{ name: "title", type: 3, value: "Work" }]);
      const thread = await h.waitFor(() => h.fake.threads("main")[0], 15_000, "a Discord thread");
      const sessions = await h.client.request("sessions.list");
      assert.equal(sessions.length, 1, "thread is one session");
      assert.equal(sessions[0].channel?.threadId, thread.id);
      assert.equal(sessions[0].title, "Work");

      h.discordThreadMessage("main", thread.id, "inside the thread");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.channelId === thread.id && entry.content.includes("Thread answer.")),
        25_000,
        "the thread answer",
      );

      h.discordSlash("main", "rename", [{ name: "title", type: 3, value: "Renamed" }], { channelId: thread.id });
      await h.waitFor(() => h.fake.threads("main")[0]?.name === "Renamed", 10_000, "thread rename");
      h.discordSlash("main", "archive", [], { channelId: thread.id });
      await h.waitFor(() => h.fake.threads("main")[0]?.thread_metadata?.archived === true, 10_000, "thread archive");
    } finally {
      await h.stop();
    }
  },
};
