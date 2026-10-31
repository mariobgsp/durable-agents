import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

/**
 * A laptop that boots before its network does must still end up with a working bot.
 *
 * The old failure: the user manager starts the daemon at boot, `getMe` fails because Wi-Fi has not
 * associated yet, and the poller is never started. The process stays alive with a dead bot until someone
 * restarts the daemon by hand, so a reboot looked like the bot had stopped working for good.
 *
 * Now the first connection is retried with backoff, and a bot that comes up late still reports its
 * restart and recovers the deliveries the previous process left behind.
 */
export default {
  name: "telegram-cold-boot",
  async run() {
    const h = await startHarness({ script: [{ text: "the answer after a cold boot" }] });
    try {
      // Three client-level attempts plus the transport's own retry: the network is gone for a while.
      h.fake.fail("main", "getMe", 6);
      await h.restart();
      const before = h.fake.pollCount("main");
      await h.waitFor(
        () => h.fake.pollCount("main") > before,
        30_000,
        "the poller to start once the network is back",
      );
      assert.match(h.log(), /bot_retried/, "the boot retry is logged, not silent");

      h.text("main", 100, "are you there after the reboot?");
      const edit = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("the answer after a cold boot")),
        25_000,
        "the answer to a message sent after the cold boot",
      );
      assert.ok(edit, "the bot answers once it is back");
    } finally {
      await h.stop();
    }
  },
};
