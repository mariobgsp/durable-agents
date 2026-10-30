import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-typing",
  async run() {
    const h = await startHarness({
      // Six seconds of tool time: long enough that a single sendChatAction (which Telegram expires after
      // about five seconds) could not cover the run on its own.
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 6; printf hi" } } },
        { text: "run complete" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "do the slow thing");
      await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("run complete")) ??
          h.fake.edits("main").find((entry) => entry.text.includes("run complete")),
        40_000,
        "the final answer",
      );
      const typing = h.fake.actions("main").filter((entry) => entry.action === "typing");
      assert.ok(typing.length >= 2, "typing is refreshed while the run is in flight, not sent once (got " + typing.length + ")");
      // The indicator must stop with the run: a chat still saying "typing…" after the answer is a lie.
      const answered = h.fake.sent("main").find((entry) => entry.text.includes("run complete")) ??
        h.fake.edits("main").find((entry) => entry.text.includes("run complete"));
      const lastTyping = typing.at(-1).at;
      assert.ok(lastTyping <= answered.at + 1500, "typing stops when the answer lands");
    } finally {
      await h.stop();
    }
  },
};
