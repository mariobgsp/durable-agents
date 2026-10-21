/**
 * Fleet E2E: the roster's working/idle transitions, the presence fleet frame, and the disabled state.
 * The long faux answer keeps the working window wide enough to observe without a poll race.
 */
import assert from "node:assert/strict";

const LONG = "Working on a deliberately long answer so the fleet can observe the working state. ".repeat(5);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "fleet",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Fleet Ann", tools: [] }),
    });
    assert.equal(created.status, 200);
    const agentId = created.body.record.id;
    const thread = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Fleet thread", agentId }),
    });
    const id = String(thread.body.id);

    const disabled = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Fleet Dora", tools: [], enabled: false }),
    });
    assert.equal(disabled.status, 200);

    const presence = server.presence();
    await presence.ready;
    const initial = await presence.waitFor((frame) => frame.type === "fleet");
    assert.ok(initial.fleet.agents.some((agent) => agent.id === agentId), "the fleet frame lists the agent");
    assert.equal(
      initial.fleet.agents.find((agent) => agent.id === agentId).status,
      "idle",
      "an idle agent starts idle",
    );
    assert.equal(
      initial.fleet.agents.find((agent) => agent.id === "fleet-dora").status,
      "disabled",
      "a disabled agent is reported disabled",
    );
    assert.ok(initial.fleet.timezone, "the snapshot names the time zone");

    await server.script([{ text: LONG }]);
    await server.send(id, { text: "start working", requestId: "fleet-one" });

    let working = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = (await server.api("/api/fleet")).body;
      const row = body.agents.find((agent) => agent.id === agentId);
      if (row?.status === "working") {
        working = row;
        break;
      }
      await sleep(100);
    }
    assert.ok(working, "the fleet should report the agent as working");
    assert.equal(working.currentThread?.id, id, "the current thread is the one generating");
    assert.equal(working.currentThread?.title, "Fleet thread");
    assert.equal(typeof working.since, "number", "a working agent has an observed start time");
    assert.ok(working.activeThreads.length >= 1);

    const workingFrame = await presence.waitFor(
      (frame) =>
        frame.type === "fleet" &&
        frame.fleet.agents.some((agent) => agent.id === agentId && agent.status === "working"),
    );
    assert.ok(workingFrame.fleet.totals.working >= 1);

    let idle = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const body = (await server.api("/api/fleet")).body;
      const row = body.agents.find((agent) => agent.id === agentId);
      if (row?.status === "idle") {
        idle = row;
        break;
      }
      await sleep(100);
    }
    assert.ok(idle, "the fleet should return to idle when the run completes");
    assert.equal(idle.currentThread, null);
    assert.ok(await presence.waitFor(
      (frame) =>
        frame.type === "fleet" &&
        frame.fleet.agents.some((agent) => agent.id === agentId && agent.status === "idle"),
    ), "the presence socket should receive the idle snapshot");

    presence.close();
  },
};
