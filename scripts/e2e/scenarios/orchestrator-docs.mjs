import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

export default {
  name: "orchestrator-docs",
  async run() {
    const h = await startHarness({
      script: [
        {
          toolCall: {
            name: "agent_write_doc",
            arguments: { agent: "helper", doc: "soul", mode: "append", content: "Always answer in one sentence." },
          },
        },
        { text: "Updated Helper's SOUL.md." },
      ],
      agents: [{ id: "orchestrator", name: "Orchestrator" }, { id: "helper", name: "Helper" }],
      orchestrator: "orchestrator",
    });
    try {
      h.text("main", 100, "make helper terse");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Updated Helper")),
        25_000,
        "the orchestrator's confirmation",
      );
      const soul = await readFile(resolve(h.home, "agents", "helper", "SOUL.md"), "utf8");
      assert.ok(soul.includes("Always answer in one sentence."), "SOUL.md was appended");
    } finally {
      await h.stop();
    }
  },
};
