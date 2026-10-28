import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

async function age(home, id, days) {
  const path = resolve(home, "sessions.json");
  const data = JSON.parse(await readFile(path, "utf8"));
  const record = data.sessions.find((entry) => String(entry.id) === String(id));
  assert.ok(record, "session exists on disk");
  record.updatedAt = Date.now() - days * 86_400_000;
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export default {
  name: "thread-prune",
  async run() {
    const h = await startHarness({ agents: [{ id: "helper", name: "Helper" }] });
    try {
      const first = await h.client.request("sessions.create", { title: "Old abandoned thread", agent: "helper" });
      await age(h.home, first.id, 45);
      const dry = await h.client.request("sessions.prune", { olderThanDays: 30, dryRun: true });
      assert.equal(dry.candidates.length, 1, "the stale thread is a candidate");
      assert.equal(dry.deleted, 0);

      const soft = await h.client.request("sessions.prune", { olderThanDays: 30 });
      assert.equal(soft.deleted, 1, "one thread deleted");
      const all = await h.client.request("sessions.list", { includeDeleted: true });
      const deleted = all.find((session) => session.id === first.id);
      assert.ok(deleted?.deletedAt, "the delete is recoverable (deletedAt set)");
      const memory = await readFile(resolve(h.home, "agents", "helper", "MEMORY.md"), "utf8");
      assert.ok(memory.includes("Pruned 1 thread(s)"), "a batch summary was written to memory");

      const second = await h.client.request("sessions.create", { title: "Old purged thread", agent: "helper" });
      await age(h.home, second.id, 60);
      const purged = await h.client.request("sessions.prune", { olderThanDays: 30, purge: true });
      assert.equal(purged.purged, 1, "one thread purged");
      const after = await h.client.request("sessions.list", { includeDeleted: true });
      assert.ok(!after.some((session) => session.id === second.id), "the purged record is gone");
      await readFile(resolve(h.home, "exports", second.id + ".json"), "utf8");
    } finally {
      await h.stop();
    }
  },
};
