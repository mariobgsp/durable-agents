import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-verify",
  async run() {
    const h = await startHarness({ platform: "discord" });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(500);
      const result = await h.client.request("verify.run", { agentPing: false }, 60_000);
      const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]));
      assert.equal(byName["chat-surface"]?.ok, true, "chat surface check");
      assert.equal(byName["discord main"]?.ok, true, "identity check");
      assert.equal(byName["discord gateway main"]?.ok, true, "gateway check");
      assert.equal(byName["owner-message"]?.ok, true, "owner DM check");
      assert.ok(h.fake.commands("main").length > 0, "commands registered");
    } finally {
      await h.stop();
    }
  },
};
