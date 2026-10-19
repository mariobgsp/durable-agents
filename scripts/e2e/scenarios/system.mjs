/**
 * System E2E: what the process says about itself, and what its two operations actually do.
 *
 * Two combinations are proven here, because they are different contracts:
 *  - read-only, no supervisor: Update must reload in place and say why; Restart must record `stopped`
 *    rather than promise a comeback.
 *  - a supervised restart: the process records `restarting`, leaves, and the *next* process turns that
 *    record into `done` with a measured downtime. That cross-process reconciliation is the point.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

const SANDBOXED = { PI_SANDBOXED: "1", PI_SUPERVISOR: "none" };
const SUPERVISED = { PI_SANDBOXED: "1", PI_SUPERVISOR: "systemd" };

async function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("timed out waiting for the system operation");
}

async function exits(server) {
  await waitFor(async () => {
    try {
      await server.api("/api/system");
      return false;
    } catch {
      return true;
    }
  });
}

export default {
  name: "system",
  env: SANDBOXED,
  async run(server) {
    // 1. The facts are derived, not guessed: read-only means reload, no supervisor means it stops.
    const initial = await server.api("/api/system");
    assert.equal(initial.status, 200, "GET /api/system should succeed");
    const facts = initial.body.process;
    assert.equal(facts.sandboxed, true, "the scenario boots with PI_SANDBOXED=1");
    assert.equal(facts.capability.update, "reload", "a read-only repo can never offer an install");
    assert.equal(facts.capability.restart, "stops", "with no supervisor the process stops");
    assert.equal(initial.body.current, null, "nothing is running at boot");
    assert.equal(initial.body.last, null, "a fresh data dir has no previous operation");
    assert.match(facts.versions.piDurable, /\d+\.\d+\.\d+|unknown/);

    // 2. A sandboxed update re-registers the tools, changes no version, and says why.
    const started = await server.api("/api/system/update", { method: "POST", body: "{}" });
    assert.equal(started.status, 200, "POST /api/system/update should succeed");
    assert.equal(started.body.kind, "update");
    assert.equal(started.body.state.name, "running", "the operation is owned by the server from here");

    const done = await waitFor(async () => {
      const { body } = await server.api("/api/system");
      return body.last?.state.name === "done" ? body : null;
    });
    assert.equal(done.current, null, "a finished operation is no longer current");
    const outcome = done.last.state.outcome;
    assert.equal(outcome.kind, "update");
    assert.equal(outcome.mode, "reload", "the sandbox forbids an install");
    assert.equal(outcome.changed, false, "a reload changes no version");
    assert.deepEqual(outcome.before, outcome.after, "before and after are the same running versions");
    assert.ok(
      done.last.log.some((line) => /read-only|No packages/i.test(line.text)),
      "the log must say that no packages were installed: " + JSON.stringify(done.last.log),
    );

    // 3. A second request is a fresh operation, not a second writer on the same repo.
    const again = await server.api("/api/system/update", { method: "POST", body: "{}" });
    assert.equal(again.status, 200, "a later update may start once the first is terminal");
    await waitFor(async () => {
      const { body } = await server.api("/api/system");
      return body.last?.state.name === "done" && body.last.id !== done.last.id ? body : null;
    });

    // 4. With no supervisor, Restart is terminal and honest: it stops, it does not promise a return.
    const restart = await server.api("/api/system/restart", { method: "POST", body: "{}" });
    assert.equal(restart.status, 200, "the restart request answers before the process exits");
    assert.equal(restart.body.kind, "restart");
    assert.equal(restart.body.state.name, "stopped", "nothing supervises this server");
    await exits(server);

    // 5. A supervised restart: the first process records `restarting`, the next turns it into `done`.
    const supervised = await startServer({ env: SUPERVISED });
    try {
      const request = await supervised.api("/api/system/restart", { method: "POST", body: "{}" });
      assert.equal(request.status, 200);
      assert.equal(request.body.state.name, "restarting", "a supervisor is expected to bring it back");
      assert.equal(request.body.state.supervisor, "systemd");
      await exits(supervised);

      const returned = await startServer({ dataDir: supervised.dataDir, env: SUPERVISED });
      try {
        const snapshot = await returned.api("/api/system");
        assert.equal(snapshot.status, 200, "the next process answers on the same data dir");
        assert.equal(snapshot.body.current, null);
        assert.equal(snapshot.body.last.kind, "restart");
        assert.equal(snapshot.body.last.state.name, "done", "a restarting record becomes done when it returns");
        assert.equal(snapshot.body.last.state.outcome.kind, "restart");
        assert.equal(
          typeof snapshot.body.last.state.outcome.downtimeMs,
          "number",
          "the next process is the proof the server came back",
        );
      } finally {
        await returned.stop();
      }
    } finally {
      await supervised.stop();
    }
  },
};
