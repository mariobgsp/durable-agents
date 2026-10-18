/**
 * Steering E2E: a message sent while the agent is replying is accepted into the run instead of being rejected
 * or silently queued behind it.
 *
 * The faux provider streams at 12 tokens/s, so a long scripted answer keeps the run in flight long enough to
 * send the steer deterministically.
 */
import assert from "node:assert/strict";

const LONG =
  "Streaming a deliberately long answer so the run stays in flight long enough to steer it mid-flight. ".repeat(4);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "steering",
  async run(server) {
    const created = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Steering" }),
    });
    assert.equal(created.status, 200, "creating a thread should succeed");
    const id = String(created.body.id);

    await server.script([{ text: LONG }, { text: "steered answer" }]);
    const first = await server.api("/api/sessions/" + id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "start" }),
    });
    assert.equal(first.status, 200, "posting the first message should succeed");

    // Wait for the run to be genuinely in flight; steering an idle thread would prove nothing.
    let active = false;
    for (let attempt = 0; attempt < 60 && !active; attempt += 1) {
      const { body } = await server.api("/api/activity");
      active = (body.active ?? []).map(String).includes(id);
      if (!active) await sleep(100);
    }
    assert.ok(active, "the thread should be generating before the steer is sent");

    const steered = await server.api("/api/sessions/" + id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "answer with one word", whenBusy: "steer" }),
    });
    assert.equal(steered.status, 200, "a steer must be accepted while the run is in flight");

    // The steer is recorded as a user entry: it was folded into the run, not dropped.
    const entry = await server.waitForEntry(
      id,
      (candidate) => candidate.role === "user" && candidate.text.includes("answer with one word"),
    );
    assert.ok(entry.id, "the steer should have its own durable entry");
  },
};
