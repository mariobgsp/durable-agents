import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

async function patchSession(home, id, patch) {
  const path = resolve(home, "sessions.json");
  const data = JSON.parse(await readFile(path, "utf8"));
  const record = data.sessions.find((entry) => String(entry.id) === String(id));
  assert.ok(record, "session exists");
  Object.assign(record, patch);
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export default {
  name: "retention",
  async run() {
    const h = await startHarness({
      script: [{ text: "Retention keeps this context in memory." }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      h.text("main", 100, "please keep this context");
      await h.waitFor(() => h.fake.edits("main").find((entry) => entry.text.includes("Retention keeps")), 25_000, "the answer");
      const sessions = await h.client.request("sessions.list");
      const session = sessions[0];
      await patchSession(h.home, session.id, { updatedAt: Date.now() - 5 * 86_400_000 });

      const first = await h.client.request("retention.run", {}, 120_000);
      assert.ok(first.pruned >= 1, "retention soft-pruned the thread");
      const hidden = (await h.client.request("sessions.list", { includeDeleted: true })).find((entry) => entry.id === session.id);
      assert.ok(hidden?.deletedAt, "the thread is soft-deleted");
      const memory = await readFile(resolve(h.home, "agents", "helper", "MEMORY.md"), "utf8");
      assert.ok(memory.includes("Pruned 1 thread(s)"), "one summary was written, not one note");
      assert.ok(memory.includes("please keep this context"), "the summary carries the last request");

      // Age the tombstone past the purge window: the rows and record go, the export stays.
      await patchSession(h.home, session.id, { deletedAt: Date.now() - 5 * 86_400_000, archivedNoteAt: Date.now() - 5 * 86_400_000 });
      const second = await h.client.request("retention.run", {}, 120_000);
      assert.ok(second.purged >= 1, "retention purged the tombstoned thread");
      const gone = (await h.client.request("sessions.list", { includeDeleted: true })).some((entry) => entry.id === session.id);
      assert.equal(gone, false, "the record is gone");
      await readFile(resolve(h.home, "exports", session.id + ".json"), "utf8");
    } finally {
      await h.stop();
    }
  },
};
