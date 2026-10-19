/**
 * Live activity E2E: what the indicator is allowed to say.
 *
 * The phase is derived on the server from `pi.live` alone, and the whole point of the feature is that it
 * cannot narrate a stage that did not happen. So these assertions are about *honesty*, not about ordering
 * alone: "thinking" only ever appears when a thinking block was actually streamed, "tool" only while a call is
 * not done, an elapsed time only from a start the server observed, and an idle frame has no phase at all.
 *
 * `activity.mjs` covers the presence marks; this covers the frames the indicator reads.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

const LONG_THINKING =
  "Let me work through this carefully before answering, because the details matter here. ".repeat(2);
const LONG_TEXT =
  "Here is the answer, written out at length so the writing phase stays observable. ".repeat(2);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The activity frames of one socket, in order. */
const phases = (stream) =>
  stream.frames.filter((frame) => frame.type === "activity").map((frame) => frame.activity);

/**
 * Wait until a matching activity frame arrives *after* the ones already seen.
 *
 * The index matters: a socket's very first activity frame says `phase: null` (nothing is running yet), so a
 * plain search would let that stale frame satisfy every later "the round ended" wait. Each wait therefore
 * starts from the frames that exist when it is called.
 */
async function waitForPhase(stream, predicate, timeoutMs, what, fromIndex = phases(stream).length) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const seen = phases(stream);
    const offset = seen.slice(fromIndex).findIndex(predicate);
    if (offset >= 0) return { activity: seen[fromIndex + offset], index: fromIndex + offset };
    await sleep(50);
  }
  throw new Error(
    "no activity frame for " +
      what +
      " within " +
      timeoutMs +
      "ms; saw: " +
      JSON.stringify(phases(stream).map((activity) => activity.phase)),
  );
}

export default {
  name: "live-activity",
  async run(server) {
    const create = async (title, agentId) => {
      const created = await server.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title, ...(agentId ? { agentId } : {}) }),
      });
      assert.equal(created.status, 200, "creating a thread should succeed");
      return String(created.body.id);
    };

    // 1. The phases are observed, not guessed, and they arrive in the order the work happens.
    const thread = await create("Phases");
    const stream = server.ws(thread);
    await stream.ready;
    await stream.waitFor((frame) => frame.type === "snapshot");

    // One response with both blocks: thinking streams first, then the text. Two separate steps would be two
    // generations, and the second would never run because nothing asks for it.
    await server.script([{ thinking: LONG_THINKING, text: LONG_TEXT }]);
    await server.send(thread, { text: "explain" });

    const thinking = await waitForPhase(
      stream,
      (activity) => activity.phase === "thinking",
      20_000,
      "the thinking phase",
    );
    const writing = await waitForPhase(
      stream,
      (activity) => activity.phase === "writing",
      20_000,
      "the writing phase",
      thinking.index + 1,
    );
    await server.waitForEntry(thread, (entry) => entry.role === "assistant" && entry.text.length > 0);
    await waitForPhase(
      stream,
      (activity) => activity.phase === null,
      20_000,
      "the round to end",
      writing.index + 1,
    );

    const seen = phases(stream);
    const firstThinking = seen.findIndex((activity) => activity.phase === "thinking");
    const firstWriting = seen.findIndex((activity) => activity.phase === "writing");
    assert.ok(firstThinking >= 0, "a thinking block must produce a thinking phase");
    assert.ok(
      firstThinking < firstWriting,
      "thinking must be reported before writing, got " + JSON.stringify(seen.map((a) => a.phase)),
    );
    assert.equal(seen.at(-1).phase, null, "the last frame of a finished round has no phase");
    for (const activity of seen) {
      assert.equal(
        activity.counts.running,
        activity.calls.filter((call) => call.status === "running").length,
        "the counts must agree with the calls they count",
      );
      if (activity.phase === null) continue;
      assert.ok(
        activity.since === null || typeof activity.since === "number",
        "an elapsed time is a number the server observed, or absent",
      );
    }
    stream.close();

    // 2. A tool round reports the call, its own start, and stops reporting once it is done.
    await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Live test", tools: ["bash"] }),
    });
    const toolThread = await create("Tool round", "live-test");
    const toolStream = server.ws(toolThread);
    await toolStream.ready;
    await toolStream.waitFor((frame) => frame.type === "snapshot");

    await server.script([
      { toolCall: { name: "bash", arguments: { command: "sleep 2; echo live-activity-ok" } } },
      { text: "ran it" },
    ]);
    await server.send(toolThread, { text: "run the command" });

    const tool = await waitForPhase(
      toolStream,
      (activity) => activity.phase === "tool" && activity.calls.length > 0,
      20_000,
      "the tool phase",
    );
    const running = tool.activity.calls.find((call) => call.status !== "done");
    assert.ok(running, "a tool phase must have a call that is not done");
    assert.equal(running.name, "bash");
    assert.ok(
      typeof tool.activity.since === "number",
      "the round's elapsed time comes from the run task the server observed",
    );
    const toolEnd = await waitForPhase(
      toolStream,
      (activity) => activity.phase === null,
      25_000,
      "the tool round to end",
      tool.index + 1,
    );

    // A settled call leaves the live round: `pi.live.tools` is emptied when the round's tool phase ends, and the
    // durable record of the call is the tool line in the transcript (`tools.mjs` asserts that one). So the honest
    // assertion is that nothing is left spinning, not that a `done` row was ever published.
    assert.deepEqual(toolEnd.activity.calls, [], "a finished round leaves no call behind");
    assert.ok(
      phases(toolStream).length <= 20,
      "the status is a snapshot on change, not a frame per tick: saw " + phases(toolStream).length,
    );

    // 3. A connection that attaches mid-round reports the run's real elapsed time, not its own age: `since`
    // comes from the run task, so a late connection does not restart the clock at zero. (There is no per-call
    // timer at all — with parallel tool execution a call is already running on its first publish, so no
    // connection can observe when it began, and a stamp taken then would mean "since I connected".)
    await server.script([
      { toolCall: { name: "bash", arguments: { command: "sleep 3; echo late" } } },
      { text: "done" },
    ]);
    await server.send(toolThread, { text: "run it again" });
    const firstTool = await waitForPhase(
      toolStream,
      (activity) => activity.phase === "tool" && activity.calls.length > 0,
      20_000,
      "the second tool phase",
    );
    await sleep(600);
    const late = server.ws(toolThread);
    await late.ready;
    const lateFrame = await waitForPhase(
      late,
      (activity) => activity.phase === "tool" && activity.calls.length > 0,
      10_000,
      "the call on a connection that attached late",
    );
    assert.equal(
      lateFrame.activity.since,
      firstTool.activity.since,
      "two connections on one run report the same start time",
    );
    assert.ok(
      typeof lateFrame.activity.since === "number" && Date.now() - lateFrame.activity.since > 500,
      "and it is the run's own start, not the moment this connection attached",
    );
    late.close();

    // 4. An abort ends the phase rather than leaving a row spinning. The answer is long on purpose: the abort
    // has to land while the round is genuinely in flight, or it proves nothing.
    await server.script([{ text: LONG_TEXT.repeat(4) }]);
    await server.send(toolThread, { text: "one more" });
    const lastRound = await waitForPhase(
      toolStream,
      (activity) => activity.phase !== null,
      20_000,
      "the last round to start",
    );
    await server.api("/api/sessions/" + toolThread + "/abort", { method: "POST", body: "{}" });
    const aborted = await waitForPhase(
      toolStream,
      (activity) => activity.phase === null,
      20_000,
      "the abort to clear the phase",
      lastRound.index + 1,
    );
    assert.deepEqual(aborted.activity.calls, [], "an aborted round leaves no call behind");
    toolStream.close();
  },
};
