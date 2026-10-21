/**
 * Cron schedules E2E: validation, next-run preview, a manual run, an automatic tick, and persistence across
 * a restart. The automatic path uses the PI_E2E due+tick helpers so the test never waits for a wall minute.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "schedules",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Cron agent", tools: [] }),
    });
    assert.equal(created.status, 200, "creating the agent should succeed");
    const agentId = created.body.record.id;

    // 1. Preview is pure validation and returns local times.
    const preview = await server.api("/api/schedules/preview", {
      method: "POST",
      body: JSON.stringify({ cron: "0 9 * * 1-5", count: 3 }),
    });
    assert.equal(preview.status, 200, "a valid cron should preview");
    assert.equal(preview.body.times.length, 3, "three next runs should come back");
    assert.ok(preview.body.timezone, "the response names the server time zone");
    for (const time of preview.body.times) {
      const date = new Date(time);
      assert.equal(date.getHours(), 9, "the preview should be at 09:00 local time");
      assert.ok(date.getDay() >= 1 && date.getDay() <= 5, "the preview should be a weekday");
    }

    const invalid = await server.api("/api/schedules/preview", {
      method: "POST",
      body: JSON.stringify({ cron: "61 * * * *" }),
    });
    assert.equal(invalid.status, 400, "an impossible minute should be refused");
    assert.equal(invalid.body.code, "invalid_cron");

    // 2. Create a schedule and run it now.
    const schedule = await server.api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        agentId,
        name: "Morning brief",
        prompt: "Write a short brief.",
        cron: "0 9 * * 1-5",
      }),
    });
    assert.equal(schedule.status, 200, "creating a schedule should succeed: " + JSON.stringify(schedule.body));
    const id = schedule.body.id;
    assert.ok(schedule.body.nextRunAt > Date.now(), "the schedule needs a future next run");

    await server.script([{ text: "Brief ready." }]);
    const run = await server.api("/api/schedules/" + id + "/run", { method: "POST", body: "{}" });
    assert.equal(run.status, 200, "run-now should be accepted");
    assert.equal(run.body.accepted, true);

    let after = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = (await server.api("/api/schedules?agentId=" + agentId)).body.schedules[0];
      if (body.lastStatus === "done") {
        after = body;
        break;
      }
      await sleep(100);
    }
    assert.ok(after, "the schedule should finish and record done");
    assert.ok(after.lastTokens > 0, "the run should record tokens");
    assert.ok(after.lastDurationMs >= 0, "the run should record a duration");
    assert.ok(after.threadId, "the schedule owns a thread");

    const entries = (await server.api("/api/sessions/" + after.threadId + "/messages")).body.entries;
    const incoming = entries.find((entry) => entry.role === "user");
    assert.ok(incoming, "the schedule thread should hold the prompt");
    assert.equal(incoming.via?.kind, "schedule", "the prompt is tagged as a scheduled run");
    assert.equal(incoming.via?.name, "Morning brief");
    const answer = entries.find((entry) => entry.role === "assistant");
    assert.equal(answer?.text, "Brief ready.");
    assert.ok(answer?.run?.usage.totalTokens > 0, "the scheduled answer has a run summary");

    // 3. Automatic firing goes through the same execution path but is forced due for determinism.
    const automatic = await server.api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ agentId, name: "Every minute", prompt: "Tick.", cron: "* * * * *" }),
    });
    assert.equal(automatic.status, 200);
    await server.script([{ text: "Tock." }]);
    const due = await server.api("/api/e2e/schedules/" + automatic.body.id + "/due", { method: "POST", body: "{}" });
    assert.equal(due.status, 200, "the test helper should force the schedule due");
    const tick = await server.api("/api/e2e/schedules/tick", { method: "POST", body: "{}" });
    assert.equal(tick.status, 200);
    assert.ok(tick.body.attempted.includes(automatic.body.id), "the due schedule should be attempted");

    let autoDone = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = (await server.api("/api/schedules?agentId=" + agentId)).body.schedules.find(
        (row) => row.id === automatic.body.id,
      );
      if (body.lastStatus === "done") {
        autoDone = body;
        break;
      }
      await sleep(100);
    }
    assert.ok(autoDone, "the automatic run should finish");
    const autoEntries = (await server.api("/api/sessions/" + autoDone.threadId + "/messages")).body.entries;
    assert.ok(autoEntries.some((entry) => entry.role === "assistant" && entry.text === "Tock."));

    // 4. A restart keeps the schedules and their next runs.
    const dataDir = server.dataDir;
    await server.stop({ keepData: true });
    server = await startServer({ dataDir });
    const persisted = await server.api("/api/schedules?agentId=" + agentId);
    assert.equal(persisted.status, 200, "schedules should survive a restart");
    assert.equal(persisted.body.schedules.length, 2, "both schedules should be listed");
    assert.ok(persisted.body.schedules.every((row) => row.threadId), "the thread ids survive too");
    assert.ok(persisted.body.schedules.every((row) => row.nextRunAt > Date.now() - 1000));
    await server.stop();
  },
};
