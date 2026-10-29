import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-progress",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 1; printf hi" } } },
        { text: "finished" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "run one command");
      const progress = await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("bash:")),
        20_000,
        "the brief tool summary in the status bubble",
      );
      assert.match(progress.text, /bash: sleep 1/);
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("finished")),
        20_000,
        "the final answer",
      );
    } finally {
      await h.stop();
    }
  },
};
