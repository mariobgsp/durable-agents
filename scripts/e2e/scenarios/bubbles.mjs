/**
 * Fleet bubbles E2E: the facts a bubble renders, and the availability write its button performs.
 *
 * There is no DOM here. The bubble field is a view of GET /api/fleet; the test proves the three states
 * (working, idle, disabled), that disabling while a run is in flight keeps the run and reports disabled, and
 * that an agent write emits a fresh fleet frame on the presence socket without waiting for a refresh. The
 * kanban lanes are gone on purpose: a bubble cannot be dragged into "working", because only a run can say that.
 */
import assert from "node:assert/strict";

const LONG = "Working on a deliberately long answer so a bubble can observe the disabled-but-finishing state. ".repeat(5);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "bubbles",
  async run(server) {
    const active = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Bubble Ann", tools: [] }),
    });
    assert.equal(active.status, 200);
    const ann = active.body.record.id;

    const paused = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Bubble Dora", tools: [], enabled: false }),
    });
    assert.equal(paused.status, 200);
    const dora = paused.body.record.id;
    assert.equal(dora, "bubble-dora", "the bubble field uses the agent id as the bubble key");

    const presence = server.presence();
    await presence.ready;
    await presence.waitFor((frame) => frame.type === "fleet");

    const initial = (await server.api("/api/fleet")).body;
    const initialAnn = initial.agents.find((agent) => agent.id === ann);
    const initialDora = initial.agents.find((agent) => agent.id === dora);
    assert.equal(initialAnn?.status, "idle", "an enabled agent with no run starts idle");
    assert.equal(initialAnn?.enabled, true);
    assert.equal(initialDora?.status, "disabled", "a disabled agent starts disabled");
    assert.equal(initialDora?.enabled, false);

    // The Disabled -> Idle move. The frame assertion is the point: availability is an agent-file write, and
    // the bubble field must not wait for the next activity change to see it.
    const beforeEnable = Date.now();
    const enable = await server.api("/api/agents/" + dora + "/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enable.status, 200);
    const doraFrame = await presence.waitFor(
      (frame) =>
        frame.type === "fleet" &&
        frame.fleet.generatedAt >= beforeEnable &&
        frame.fleet.agents.some((agent) => agent.id === dora && agent.status === "idle"),
    );
    assert.ok(doraFrame, "enable should emit a fresh fleet snapshot");
    const afterEnable = (await server.api("/api/fleet")).body;
    assert.equal(afterEnable.agents.find((agent) => agent.id === dora)?.status, "idle");

    const created = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Bubble thread", agentId: ann }),
    });
    assert.equal(created.status, 200);
    const threadId = String(created.body.id);

    await server.script([{ text: LONG }]);
    await server.send(threadId, { text: "start working", requestId: "bubble-one" });

    let working = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await server.api("/api/fleet")).body.agents.find((agent) => agent.id === ann);
      if (row?.status === "working") {
        working = row;
        break;
      }
      await sleep(100);
    }
    assert.ok(working, "a running thread should make the agent's bubble working");
    assert.equal(working.currentThread?.id, threadId);
    assert.equal(working.currentThread?.title, "Bubble thread");
    assert.equal(typeof working.since, "number", "a working bubble has an observed start time");
    assert.ok(working.activeThreads.length >= 1);

    // Disabled wins over Working: no new threads, and the bubble still reports the run it is finishing.
    const beforeDisable = Date.now();
    const disable = await server.api("/api/agents/" + ann + "/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disable.status, 200);
    const disabledFrame = await presence.waitFor(
      (frame) =>
        frame.type === "fleet" &&
        frame.fleet.generatedAt >= beforeDisable &&
        frame.fleet.agents.some((agent) => agent.id === ann && agent.status === "disabled"),
    );
    const finishing = disabledFrame.fleet.agents.find((agent) => agent.id === ann);
    assert.equal(finishing?.enabled, false);
    assert.equal(finishing?.status, "disabled", "disabled wins over working while the run is still in flight");
    assert.equal(finishing?.currentThread?.id, threadId, "the finishing bubble keeps its current thread");
    assert.ok(finishing.activeThreads.length >= 1, "the finishing run is still reported as active");

    let finished = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = (await server.api("/api/fleet")).body.agents.find((agent) => agent.id === ann);
      if (row?.status === "disabled" && row.activeThreads.length === 0) {
        finished = row;
        break;
      }
      await sleep(100);
    }
    assert.ok(finished, "the run should finish while the agent stays disabled");
    assert.equal(finished.currentThread, null, "a finished disabled bubble has no current thread");

    const beforeReenable = Date.now();
    const reenable = await server.api("/api/agents/" + ann + "/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(reenable.status, 200);
    const reenabledFrame = await presence.waitFor(
      (frame) =>
        frame.type === "fleet" &&
        frame.fleet.generatedAt >= beforeReenable &&
        frame.fleet.agents.some((agent) => agent.id === ann && agent.status === "idle"),
    );
    assert.ok(reenabledFrame, "re-enable should emit a fresh fleet snapshot and return the bubble to idle");

    presence.close();
  },
};
