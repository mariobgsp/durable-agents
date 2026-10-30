import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

/**
 * A restart must be audible in the chats that felt it.
 *
 * The old failure: the daemon stopped, the bot went silent mid-answer and nothing in the chat said why —
 * the owner had to read the journal to learn that a restart had happened at all. Now the leaving process
 * says goodbye in every chat with work in flight (recording where it said it), and the process that comes
 * back edits those exact bubbles with the downtime and how many runs resume.
 */
export default {
  name: "telegram-restart-notice",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 6; printf hi" } } },
        { text: "the answer after the restart" },
      ],
    });
    try {
      h.text("main", 100, "long job");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("bash:")),
        25_000,
        "the run to start working",
      );

      await h.restart();

      // Sent by the process that died, before it died.
      const leaving = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.chatId === 100 && /Restarting|Stopping/.test(entry.text)),
        15_000,
        "the goodbye message",
      );
      assert.match(leaving.text, /resume/i, "the goodbye says the run survives the exit");

      // The same bubble, edited by the process that came back.
      const back = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.messageId === leaving.messageId && entry.text.includes("Back")),
        45_000,
        "the outcome edit on the goodbye bubble",
      );
      assert.match(back.text, /after \S+/, "the outcome reports how long the service was gone");
      assert.match(back.text, /interrupted run/, "the outcome says a run is resuming");
      assert.doesNotMatch(back.text, /Restarting|Stopping/, "the bubble no longer claims the service is going away");

      // Delivery recovery still owns the answer itself: the notice does not speak for the run.
      await h.waitFor(
        () =>
          h.fake.sent("main").find((entry) => entry.text.includes("the answer after the restart")) ??
          h.fake.edits("main").find((entry) => entry.text.includes("the answer after the restart")),
        90_000,
        "the interrupted answer",
      );
    } finally {
      await h.stop();
    }
  },
};
