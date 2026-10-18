/**
 * Memory E2E: an agent can save a note about itself, the note lands in its own directory, it reaches the model
 * in a later thread, and it never leaks into another agent's prompt.
 *
 * The `remember` tool is shared by every conversation, so this also covers the resolution that decides which
 * agent is calling it.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const NOTE = "The user ships on Fridays.";

/** Everything the model was told in one conversation, read straight from the durable system entries. */
function systemText(dataDir, conversationId) {
  const db = new DatabaseSync(resolve(dataDir, "app.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        "select json_extract(record,'$.model') m from entries where conversation_id = ? and json_extract(record,'$.kind') = 'pi.system'",
      )
      .all(Number(conversationId));
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

export default {
  name: "memory",
  async run(server) {
    // 1. An agent with no tools at all: `remember` must be offered anyway.
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Memory test", tools: [] }),
    });
    assert.equal(created.status, 200, "creating an agent should succeed");
    const agentId = created.body.record.id;

    const first = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Memory one", agentId }),
    });
    const firstId = String(first.body.id);

    await server.script([
      { toolCall: { name: "remember", arguments: { note: NOTE } } },
      { text: "saved" },
    ]);
    const posted = await server.api("/api/sessions/" + firstId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "remember that" }),
    });
    assert.equal(posted.status, 200, "posting a message should succeed");

    const line = await server.waitForEntry(firstId, (entry) => entry.role === "tool");
    assert.equal(line.tool.name, "remember", "the tool should still be offered with no tools enabled");
    assert.equal(line.tool.isError, false, "saving a note should not fail");

    // 2. The note is in the agent's own directory, not in a shared file.
    const memoryPath = resolve(server.dataDir, "agents", agentId, "MEMORY.md");
    const memory = await readFile(memoryPath, "utf8");
    assert.match(memory, new RegExp(NOTE.replace(".", "\\.")), "the note should be on disk");

    // 3. Its scratch directory exists, at the root the harness pointed at.
    const scratch = resolve(server.dataDir, "tmp", agentId);
    assert.ok(existsSync(scratch), "the agent's scratch directory should exist at " + scratch);

    // 4. A later thread of the same agent is told about it — and about the scratch directory.
    const second = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Memory two", agentId }),
    });
    const secondId = String(second.body.id);
    await server.script([{ text: "ok" }]);
    await server.api("/api/sessions/" + secondId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "what do you know" }),
    });
    await server.waitForEntry(secondId, (entry) => entry.role === "assistant");

    const told = systemText(server.dataDir, secondId);
    assert.ok(told.includes(NOTE), "a new thread should be told what the agent remembered");
    assert.ok(told.includes(scratch), "a new thread should be told its scratch directory");

    // 5. Isolation: another agent must not inherit the note.
    const other = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Other test", tools: [] }),
    });
    const third = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Other", agentId: other.body.record.id }),
    });
    const thirdId = String(third.body.id);
    await server.script([{ text: "ok" }]);
    await server.api("/api/sessions/" + thirdId + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "what do you know" }),
    });
    await server.waitForEntry(thirdId, (entry) => entry.role === "assistant");

    const foreign = systemText(server.dataDir, thirdId);
    assert.ok(!foreign.includes(NOTE), "another agent must not see this agent's memory");
    assert.ok(
      !foreign.includes(scratch),
      "another agent must not be told this agent's scratch directory",
    );
  },
};
