import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

/**
 * A run that outlives the process must still answer its chat.
 *
 * pi-durable's resume() reschedules the interrupted work, but the transport that owes the reply lived in
 * the process that died. Without the pending-delivery record the bubble stayed on "planning the next step"
 * forever and the answer, once it existed, was never sent anywhere.
 */
export default {
  name: "telegram-delivery-recovery",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 6; printf hi" } } },
        { text: "survived the restart" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "long job");
      await h.waitFor(
        () => h.fake.edits("main").find((entry) => entry.text.includes("bash:")),
        25_000,
        "the run to start working",
      );

      const pendingBefore = await h.client.request("sessions.list");
      assert.equal(pendingBefore.length, 1, "one thread before the restart");

      // The process dies mid-run; the home directory, the durable store and the bot state stay.
      await h.restart();

      const delivered = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("survived the restart")) ??
          h.fake.edits("main").find((entry) => entry.text.includes("survived the restart")),
        90_000,
        "the answer delivered after the restart",
      );
      assert.ok(delivered, "the interrupted run's answer reached the chat");

      // The record is consumed: a second boot must not deliver it again.
      const state = JSON.parse(
        await (await import("node:fs/promises")).readFile(new URL("file://" + h.home + "/telegram/state.json"), "utf8"),
      );
      const pending = Object.values(state.bots.main.pending ?? {});
      assert.equal(pending.length, 0, "the pending delivery is cleared once answered");
    } finally {
      await h.stop();
    }
  },
};
