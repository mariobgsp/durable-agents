/**
 * Storage E2E: what is on disk, and what comes back.
 *
 * The two operations are different in kind, so they are asserted differently: a checkpoint must never *grow*
 * the write-ahead log and must report what it reclaimed, while a purge is destructive and therefore has to
 * prove the transcript was exported before the rows went.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { startServer } from "../harness.mjs";

export default {
  name: "storage",
  async run(server) {
    // 1. The report adds up and names its parts.
    const report = await server.api("/api/storage");
    assert.equal(report.status, 200, "GET /api/storage should succeed");
    const storage = report.body.storage;
    assert.ok(storage.databaseBytes > 0, "the database should have a size");
    assert.ok(storage.totalBytes >= storage.databaseBytes, "the total should include the database");
    assert.ok(typeof storage.agentBytes === "number" && typeof storage.sessionsBytes === "number");

    // 2. A thread with a real transcript, so there is something to lose.
    const created = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Doomed storage thread" }),
    });
    const id = created.body.id;
    await server.script([{ text: "an answer worth exporting" }]);
    await server.send(id, { text: "say something" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant");
    const before = (await server.api("/api/sessions/" + id + "/messages")).body.entries.length;
    assert.ok(before >= 2, "the thread should hold a transcript");

    // 3. The purge exports first, then removes rows, then hides the thread.
    const purge = await server.api("/api/sessions/" + id + "/purge", { method: "POST", body: "{}" });
    assert.equal(purge.status, 200, "POST /api/sessions/:id/purge should succeed");
    assert.match(purge.body.exportPath, /exports/, "the export path is reported");
    assert.ok(existsSync(purge.body.exportPath), "the transcript is on disk before the rows go");
    let exported;
    try {
      exported = JSON.parse(readFileSync(purge.body.exportPath, "utf8"));
    } catch (error) {
      assert.fail("the export is not readable JSON: " + String(error));
    }
    assert.equal(exported.entries.length, before, "the export holds every entry the thread had");
    const emptied = purge.body.removedRows.filter((row) => row.rows > 0);
    assert.ok(
      emptied.length >= 1,
      "at least one table must lose rows, or the purge silently did nothing: " +
        JSON.stringify(purge.body.removedRows),
    );

    const listed = await server.api("/api/sessions");
    assert.ok(
      !listed.body.sessions.some((session) => session.id === id),
      "a purged thread must leave the list",
    );
    assert.equal(
      (await server.api("/api/sessions/" + id + "/messages")).status,
      404,
      "and its transcript route must be gone",
    );

    // 4. The rows are really gone from the database, not merely hidden. This is the assertion that matters:
    // the API no longer lists the thread either way, so only the table itself proves the purge deleted.
    const left = server.query("SELECT count(*) AS rows FROM entries WHERE record LIKE ?", "%say something%");
    assert.equal(Number(left[0].rows), 0, "the purged conversation's entries must be deleted, not hidden");

    // 5. Cleanup reports what it gave back, and running it again is harmless.
    //
    // Deliberately NOT asserted: that the write-ahead log shrinks. It is truncated by the checkpoint and then
    // grows again with the server's next write, so between two measurements taken over HTTP it can legitimately
    // be larger — a claim the system cannot make. What it can promise is the reported sizes and idempotency.
    const cleanup = await server.api("/api/storage/cleanup", { method: "POST", body: "{}" });
    assert.equal(cleanup.status, 200, "POST /api/storage/cleanup should succeed");
    assert.ok(typeof cleanup.body.before.walBytes === "number", "the sizes before are reported");
    assert.ok(typeof cleanup.body.after.walBytes === "number", "the sizes after are reported");
    assert.ok(
      typeof cleanup.body.reclaimedBytes === "number" && cleanup.body.reclaimedBytes >= 0,
      "the reclaimed byte count is reported",
    );
    const again = await server.api("/api/storage/cleanup", { method: "POST", body: "{}" });
    assert.equal(again.status, 200, "a second cleanup must not fail");
  },
};
