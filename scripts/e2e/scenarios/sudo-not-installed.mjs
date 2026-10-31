import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "sudo-not-installed",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "sudo", arguments: { action: "cleanup" } } },
        { text: "not installed" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "clean the caches");
      await h.waitFor(
        () =>
          h.fake.edits("main").find((entry) => entry.text.includes("not installed")) ??
          h.fake.sent("main").find((entry) => entry.text.includes("not installed")),
        25_000,
        "the not-installed answer",
      );
      assert.ok(
        !h.fake.sent("main").some((entry) => entry.text.includes("Clean system caches")),
        "no approval question is shown without an install",
      );
    } finally {
      await h.stop();
    }
  },
};
