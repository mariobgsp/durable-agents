import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-question",
  async run() {
    const h = await startHarness({
      script: [{ toolCall: { name: "question", arguments: { text: "Pick a fruit", options: ["Apple", "Banana"] } } }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "ask me");
      const edit = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Pick a fruit")),
        25_000,
        "the question edit",
      );
      assert.ok(edit.replyMarkup?.inline_keyboard?.length > 0, "the question carries option buttons");
      const sessions = await h.client.request("sessions.list");
      const sessionId = sessions[0].id;

      h.fake.inject("main", {
        update_id: 500,
        callback_query: {
          id: "callback-1",
          from: { id: 100, is_bot: false, username: "owner" },
          message: {
            message_id: edit.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 100, type: "private" },
            text: "Pick a fruit",
          },
          data: "q:" + sessionId + ":0",
        },
      });

      await h.waitFor(async () => {
        const transcript = await h.client.request("sessions.transcript", { id: sessionId });
        return transcript.some((entry) => entry.role === "user" && entry.text === "Apple");
      }, 20_000, "the option submitted as a user message");
    } finally {
      await h.stop();
    }
  },
};
