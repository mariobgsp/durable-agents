import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

export default {
  name: "memory-tool",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "remember", arguments: { note: "The owner prefers terse answers." } } },
        { text: "Noted." },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "remember that I prefer terse answers");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("Noted.")),
        25_000,
        "the agent's confirmation",
      );
      const memory = await readFile(resolve(h.home, "agents", "helper", "MEMORY.md"), "utf8");
      assert.ok(memory.includes("The owner prefers terse answers."), "the note is in MEMORY.md");
      const transcript = await h.client.request("sessions.transcript", { id: (await h.client.request("sessions.list"))[0].id });
      assert.ok(transcript.some((entry) => entry.role === "tool"), "the remember tool ran");
    } finally {
      await h.stop();
    }
  },
};
