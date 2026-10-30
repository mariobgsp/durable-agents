import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { startHarness, ROOT } from "../harness.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "chat-exclusive",
  async run() {
    const telegramActive = await startHarness({ platform: "telegram", alsoConfigure: "discord" });
    try {
      await telegramActive.waitFor(() => telegramActive.fake.pollCount("main") > 0, 20_000, "Telegram polling");
      await sleep(700);
      assert.equal(telegramActive.otherFake.identifyCount("main"), 0, "Discord gateway must not start");
      const status = await telegramActive.client.request("status");
      assert.equal(status.channels?.platform, "telegram");
    } finally {
      await telegramActive.stop();
    }

    const discordActive = await startHarness({ platform: "discord", alsoConfigure: "telegram" });
    try {
      await discordActive.waitFor(() => discordActive.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(700);
      assert.equal(discordActive.otherFake.pollCount("main"), 0, "Telegram poller must not start");
      const status = await discordActive.client.request("status");
      assert.equal(status.channels?.platform, "discord");
      let failed = false;
      try {
        execFileSync(process.execPath, [resolve(ROOT, "packages/cli/bin/dura.ts"), "config", "set", "chat.active=both"], {
          cwd: ROOT,
          env: { ...process.env, DURA_HOME: discordActive.home },
          stdio: "pipe",
          encoding: "utf8",
        });
      } catch (error) {
        failed = true;
        assert.equal(error.status, 2, "invalid surface is a usage error");
      }
      assert.ok(failed, "setting an invalid active surface must fail");
    } finally {
      await discordActive.stop();
    }
  },
};
