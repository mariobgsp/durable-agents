import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

/**
 * Answering a question from a button must behave like typing a prompt: a status bubble, typing, and an
 * answer. The bug this covers sent the option bare, so the follow-up turn ran with nobody watching it and
 * the chat looked stuck with no brief update at all.
 */
export default {
  name: "telegram-question-followup",
  async run() {
    const h = await startHarness({
      // The faux model keeps going after the question tool, so the turn only ends on the text step. The
      // steps after it belong to the turn that the owner's answer starts — that is the turn under test.
      script: [
        { toolCall: { name: "question", arguments: { text: "Pick a fruit", options: ["Apple", "Banana"] } } },
        { text: "asked" },
        { toolCall: { name: "bash", arguments: { command: "sleep 2; printf hi" } } },
        { text: "apple it is" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "ask me");
      const question = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("Pick a fruit")),
        25_000,
        "the question message",
      );
      const sessions = await h.client.request("sessions.list");
      const sessionId = sessions[0].id;
      const actionsBefore = h.fake.actions("main").length;

      h.fake.inject("main", {
        update_id: 500,
        callback_query: {
          id: "callback-1",
          from: { id: 100, is_bot: false, username: "owner" },
          message: {
            message_id: question.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 100, type: "private" },
            text: "Pick a fruit",
          },
          data: "q:" + sessionId + ":0",
        },
      });

      // The follow-up turn opens its own status bubble…
      await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("Think · planning the next step")),
        20_000,
        "a status bubble for the turn the answer started",
      );
      // …shows progress from it…
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("bash:")),
        20_000,
        "progress edits after answering a question",
      );
      // …delivers its answer…
      await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("apple it is")) ??
          h.fake.edits("main").find((entry) => entry.text.includes("apple it is")),
        30_000,
        "the answer to the question turn",
      );
      // …and keeps typing while it works.
      assert.ok(
        h.fake.actions("main").length > actionsBefore,
        "typing resumes for the turn started by the answer",
      );
    } finally {
      await h.stop();
    }
  },
};
