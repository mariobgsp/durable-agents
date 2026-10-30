import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-moderation",
  async run() {
    const h = await startHarness({ platform: "discord", auditChannelId: "audit-1" });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      h.discordSlash("main", "mod", [{
        name: "timeout",
        type: 1,
        options: [
          { name: "user", type: 6, value: "target" },
          { name: "minutes", type: 4, value: 5 },
          { name: "reason", type: 3, value: "spam" },
        ],
      }]);
      const timeout = await h.waitFor(() => h.fake.moderation("main").find((entry) => entry.action === "timeout"), 15_000, "timeout REST call");
      assert.equal(timeout.userId, "target");
      assert.ok(timeout.body.communication_disabled_until, "timeout carries an expiry");
      await h.waitFor(() => h.fake.sent("main").find((entry) => entry.channelId === "audit-1" && entry.content.includes("spam")), 10_000, "audit line");

      h.discordSlash("main", "mod", [{
        name: "ban",
        type: 1,
        options: [
          { name: "user", type: 6, value: "target" },
          { name: "reason", type: 3, value: "evasion" },
        ],
      }]);
      const confirm = await h.waitFor(
        () => h.fake.callbacks("main").find((entry) => entry.data?.data?.components?.length > 0),
        10_000,
        "ban confirmation",
      );
      const customId = confirm.data.data.components[0].components[0].custom_id;
      h.discordClick("main", customId, { channelId: "c1", guildId: "g1" });
      const ban = await h.waitFor(() => h.fake.moderation("main").find((entry) => entry.action === "ban"), 15_000, "ban REST call");
      assert.equal(ban.userId, "target");
      assert.ok(h.fake.sent("main").some((entry) => entry.channelId === "audit-1" && entry.content.includes("evasion")), "ban audit line");
    } finally {
      await h.stop();
    }
  },
};
