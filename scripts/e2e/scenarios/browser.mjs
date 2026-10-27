/**
 * Browser E2E: the lifecycle contract, without paying for a real launch in every run.
 *
 * A browser is expensive, so the test proves the two cheap truths: status never starts one, and close is
 * idempotent. Whether a binary exists is environment-dependent and is asserted as a fact of this machine
 * rather than a requirement of the app. The coding executors are probed the same way: lazily, and never
 * throwing when a CLI is absent.
 */
import assert from "node:assert/strict";

export default {
  name: "browser",
  async run(server) {
    const status = await server.api("/api/browser");
    assert.equal(status.status, 200);
    assert.equal(status.body.running, false, "reading status must not start a browser");
    assert.equal(typeof status.body.idleMinutes, "number");
    assert.ok(status.body.idleMinutes > 0, "an idle browser is closed by a timer");
    assert.ok(status.body.profileDir.endsWith("browser/profile"), "the profile is the persistent session store");

    const closed = await server.api("/api/browser/close", { method: "POST" });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.running, false, "closing an idle browser is a no-op, not an error");

    const coding = await server.api("/api/coding");
    assert.equal(coding.status, 200);
    assert.equal(typeof coding.body.pi.available, "boolean");
    assert.equal(typeof coding.body.opencode.available, "boolean");
    if (!coding.body.opencode.available) {
      assert.match(String(coding.body.opencode.reason ?? ""), /not installed|PATH/i);
    }
  },
};
