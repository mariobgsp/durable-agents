import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-stop",
  async run() {
    const h = await startHarness({
      // One scripted step per conversation: the faux provider hands out its queue in order, so each thread
      // gets its own slow tool call and both are genuinely running when /stop arrives.
      script: [
        { toolCall: { name: "bash", arguments: { command: "sleep 5; printf done" } } },
        { toolCall: { name: "bash", arguments: { command: "sleep 5; printf done" } } },
        { text: "finished" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    const here = (chatId) => h.fake.sent("main").filter((message) => message.chatId === chatId);
    const editsHere = (chatId) => h.fake.edits("main").filter((entry) => entry.chatId === chatId);
    try {
      h.text("main", 100, "run a slow task");
      await h.waitFor(() => here(100).some((message) => message.text.includes("Think")), 15_000, "the first thread's placeholder");

      // A second thread of the same agent runs alongside the first: /stop in one must not touch the other.
      h.text("main", 200, "a second slow task");
      await h.waitFor(() => here(200).some((message) => message.text.includes("Think")), 15_000, "the second thread's placeholder");

      h.text("main", 100, "/stop");
      await h.waitFor(
        () => here(100).find((message) => message.text.includes("Stopped") || message.text.includes("Nothing is running")),
        15_000,
        "the stop acknowledgement",
      );
      await h.waitFor(
        () => editsHere(100).find((entry) => entry.text.includes("stopped.")),
        15_000,
        "the stopped placeholder in this thread",
      );
      assert.equal(
        editsHere(200).filter((entry) => entry.text.includes("stopped.")).length,
        0,
        "the sibling thread was left alone",
      );

      // The survivor keeps running and answers on its own, which only happens if /stop stayed in its thread.
      await h.waitFor(() => editsHere(200).find((entry) => entry.text.includes("finished")), 30_000, "the second thread's answer");

      const sessions = await h.client.request("sessions.list");
      const titles = sessions.map((session) => session.title);
      assert.ok(titles.includes("run a slow task") && titles.includes("a second slow task"), "both threads stayed durable");
      const stoppedTranscript = await h.client.request("sessions.transcript", { id: sessions.find((s) => s.title === "run a slow task").id });
      assert.equal(
        stoppedTranscript.filter((entry) => entry.role === "assistant").length,
        0,
        "the stopped thread produced no answer",
      );
    } finally {
      await h.stop();
    }
  },
};
