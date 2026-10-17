/**
 * Activity E2E: the server knows which sessions are generating.
 *
 * This is the signal behind the sidebar's "replying" dots, so it has to be exact — active while work is
 * genuinely in flight, and cleared once the conversation is idle. The faux provider streams at 12
 * tokens/s, so a long scripted answer keeps the window wide enough to observe deterministically.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

/** A long answer: at 12 tokens/s this stays in flight for several seconds. */
const LONG =
  "Brewing the answer slowly so the activity window stays open long enough to observe it reliably. ".repeat(3);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The set of session ids the server currently reports as generating. */
async function activeIds(server) {
  const { status, body } = await server.api("/api/activity");
  assert.equal(status, 200, "GET /api/activity should succeed");
  assert.ok(Array.isArray(body.active), "the response should carry an active array");
  return body.active.map(String);
}

/** Poll until `check` returns true, or fail with the last value seen. */
async function waitUntil(check, timeoutMs, what) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last === true) return;
    await sleep(100);
  }
  throw new Error("timed out after " + timeoutMs + "ms waiting for " + what + " (last: " + JSON.stringify(last) + ")");
}

export default {
  name: "activity",
  async run(server) {
    // (e) An idle session is never reported as generating — including across a restart, which is the boot
    // scan's `trackIfBusy` path: it must not mistake an idle conversation for a running one.
    const idle = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Idle thread" }),
    });
    assert.equal(idle.status, 200, "creating a session should succeed");
    const idleId = String(idle.body.id);
    assert.ok(!(await activeIds(server)).includes(idleId), "a fresh thread must not be active");

    await server.stop({ keepData: true });
    const restarted = await startServer({ dataDir: server.dataDir });
    // Long enough for the boot scan's grace window to elapse; a false positive would appear here.
    await sleep(800);
    assert.ok(
      !(await activeIds(restarted)).includes(idleId),
      "an idle thread must not be marked active by the boot scan",
    );

    // (a) A plain session is active while its answer streams, and (b) clears once it lands.
    await restarted.script([{ text: LONG }]);
    const sent = await restarted.api("/api/sessions/" + idleId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "take your time" }),
    });
    assert.equal(sent.status, 200, "POSTing a message should succeed");

    await waitUntil(async () => (await activeIds(restarted)).includes(idleId), 5_000, "the thread to become active");

    await restarted.waitForEntry(idleId, (entry) => entry.role === "assistant" && entry.text.length > 0);
    await waitUntil(async () => !(await activeIds(restarted)).includes(idleId), 20_000, "the thread to go idle");

    // (d) Abort clears the mark immediately, without waiting for the answer to finish.
    await restarted.script([{ text: LONG }, { text: LONG }]);
    const abortThread = await restarted.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Abort thread" }),
    });
    const abortId = String(abortThread.body.id);
    await restarted.api("/api/sessions/" + abortId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "start something long" }),
    });
    await waitUntil(async () => (await activeIds(restarted)).includes(abortId), 5_000, "the abort thread to become active");
    await restarted.api("/api/sessions/" + abortId + "/abort", { method: "POST", body: "{}" });
    await waitUntil(async () => !(await activeIds(restarted)).includes(abortId), 10_000, "abort to clear the mark");

    // (c) A group stays active across the whole multi-agent flow.
    const agent = await restarted.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Activity agent",
        provider: "e2e",
        modelId: "faux-text",
        tools: [],
        responsibility: "Answer questions",
      }),
    });
    assert.equal(agent.status, 200, "creating the group member should succeed");

    const room = await restarted.api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ title: "Activity group", members: ["activity-agent"] }),
    });
    assert.equal(room.status, 200, "creating the group should succeed");
    const roomId = String(room.body.id);

    // Silent mode plus an @mention targets exactly one member, so the flow is one model call: the point
    // here is the activity window, not the routing.
    await restarted.api("/api/rooms/" + roomId, { method: "PUT", body: JSON.stringify({ mode: "silent" }) });
    await restarted.script([{ text: "Yes, that is mine." }, { text: "Yes, that is mine." }]);

    // postToRoom awaits the whole flow, so the request has to be observed while it is still in flight.
    const posting = restarted.api("/api/sessions/" + roomId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "@activity-agent are you there?" }),
    });
    await waitUntil(async () => (await activeIds(restarted)).includes(roomId), 10_000, "the group to become active");
    const posted = await posting;
    assert.equal(posted.status, 200, "the group post should succeed");
    assert.ok(
      posted.body.answered.includes("activity-agent"),
      "the mentioned member should have answered: " + JSON.stringify(posted.body),
    );
    await waitUntil(async () => !(await activeIds(restarted)).includes(roomId), 20_000, "the group to go idle");

    await restarted.stop();
  },
};
