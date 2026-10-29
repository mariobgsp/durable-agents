import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-stop",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 30" } } },
        { text: "finished" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "run a slow task");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Think")),
        15_000,
        "the thinking placeholder",
      );
      await h.waitFor(async () => {
        const status = await h.client.request("status");
        return status.runs.active > 0;
      }, 10_000, "the run to start");

      h.text("main", 100, "/stop");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Stopped") || message.text.includes("Nothing is running")),
        15_000,
        "the stop acknowledgement",
      );
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("stopped.")),
        15_000,
        "the stopped placeholder",
      );
      const status = await h.client.request("status");
      assert.equal(status.runs.active, 0, "no run remains active");
    } finally {
      await h.stop();
    }
  },
};
