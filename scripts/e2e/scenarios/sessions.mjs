/**
 * Sessions E2E: create, answer (REST + WS frames), rename, delete, and survival across a restart.
 * Runs against the faux provider, so answers are deterministic and cost nothing.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

export default {
  name: "sessions",
  async run(server) {
    // 1. An empty server has no threads.
    const empty = await server.api("/api/sessions");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.sessions, [], "a fresh server should list no threads");

    // 2. Create a thread and answer a message with a scripted reply.
    const created = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "E2E thread" }),
    });
    assert.equal(created.status, 200, "POST /api/sessions should succeed");
    const id = created.body.id;
    assert.ok(id, "the created thread needs an id");
    assert.equal(created.body.title, "E2E thread");

    const stream = server.ws(id);
    await stream.ready;
    await stream.waitFor((frame) => frame.type === "snapshot");

    await server.script([{ text: "scripted answer one" }]);
    const posted = await server.api("/api/sessions/" + id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello there" }),
    });
    assert.equal(posted.status, 200, "posting a message should succeed");

    const answer = await stream.waitFor(
      (frame) => frame.type === "entry" && frame.entry.role === "assistant",
    );
    assert.equal(answer.entry.text, "scripted answer one", "the scripted answer should arrive over WS");
    assert.ok(
      stream.frames.some((frame) => frame.type === "delta"),
      "the answer should stream as at least one delta frame",
    );
    stream.close();

    const transcript = await server.api("/api/sessions/" + id + "/messages");
    const roles = transcript.body.entries.map((entry) => entry.role);
    assert.deepEqual(roles, ["user", "assistant"], "the transcript should hold the user message and the answer");
    assert.equal(transcript.body.entries[1].text, "scripted answer one");

    // 3. Rename it.
    const renamed = await server.api("/api/sessions/" + id, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed thread" }),
    });
    assert.equal(renamed.status, 200, "PATCH /api/sessions/:id should succeed");
    assert.equal(renamed.body.title, "Renamed thread");

    // 4. Create a second thread and delete it.
    const second = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Doomed thread" }),
    });
    const deleted = await server.api("/api/sessions/" + second.body.id, { method: "DELETE" });
    assert.equal(deleted.status, 200, "DELETE /api/sessions/:id should succeed");

    const afterDelete = await server.api("/api/sessions");
    const ids = afterDelete.body.sessions.map((session) => session.id);
    assert.ok(!ids.includes(second.body.id), "a deleted thread must not be listed");
    assert.ok(ids.includes(id), "the other thread must survive");

    const withDeleted = await server.api("/api/sessions?includeDeleted=1");
    assert.ok(
      withDeleted.body.sessions.some((session) => session.id === second.body.id),
      "?includeDeleted=1 should still show the deleted thread",
    );

    // 5. Both changes must survive a restart on the same data directory.
    await server.stop({ keepData: true });
    const restarted = await startServer({ dataDir: server.dataDir });
    const after = await restarted.api("/api/sessions");
    const titles = after.body.sessions.map((session) => session.title);
    assert.ok(titles.includes("Renamed thread"), "the rename should survive a restart");
    assert.ok(!titles.includes("Doomed thread"), "the deletion should survive a restart");
    await restarted.stop();
  },
};
