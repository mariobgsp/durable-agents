import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

/**
 * A process killed without warning leaves no goodbye — and the chats still have to hear from it.
 *
 * The leaving half of the handshake never runs here, so there is no bubble to edit. Silently resuming is
 * the failure: a run that reappears minutes later looks like a hang, not like a service that came back.
 * The boot notice is therefore a fresh message in every chat that still has work in flight.
 */
export default {
  name: "telegram-restart-notice-crash",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 6; printf hi" } } },
        { text: "the answer after the crash" },
      ],
    });
    try {
      h.text("main", 100, "long job");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("bash:")),
        25_000,
        "the run to start working",
      );

      await h.restart({ hard: true });

      const notice = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.chatId === 100 && entry.text.includes("Service came back")),
        45_000,
        "the notice sent after an unannounced exit",
      );
      assert.match(notice.text, /resumes now/i, "the notice says the interrupted run is resuming");
      assert.doesNotMatch(notice.text, /Restarting|Stopping/, "an unannounced exit is not reported as a goodbye");
    } finally {
      await h.stop();
    }
  },
};
