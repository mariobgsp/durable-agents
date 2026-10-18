/**
 * Tools E2E: using a tool leaves exactly one line in the session, and that line is durable.
 *
 * The live trace comes from `pi.live`, which pi-durable empties when the run ends, so the durable half has to
 * come from the `pi.tool-result` entry instead. This scenario drives a real tool call through the faux
 * provider and then checks the line twice: right after the round, and again after a restart, which proves it
 * was read from SQLite rather than from memory.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll the transcript until a tool line shows up. */
async function toolLines(server, id, timeoutMs = 20000) {
  const started = Date.now();
  let lines = [];
  while (Date.now() - started < timeoutMs) {
    const { body } = await server.api("/api/sessions/" + id + "/messages");
    lines = (body.entries ?? []).filter((entry) => entry.role === "tool");
    if (lines.length > 0) return lines;
    await sleep(150);
  }
  throw new Error("no tool line appeared within " + timeoutMs + "ms (last: " + JSON.stringify(lines) + ")");
}

export default {
  name: "tools",
  async run(server) {
    // 1. An agent that may run a command. The trace only exists for an agent that has tools.
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Tool test", tools: ["bash"] }),
    });
    assert.equal(created.status, 200, "creating an agent should succeed");
    const agentId = created.body.record.id;

    const session = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Tool trace", agentId }),
    });
    assert.equal(session.status, 200, "creating a thread should succeed");
    const id = String(session.body.id);

    // 2. Call bash, then answer. If the call were swallowed, the model would answer with nothing to show.
    await server.script([
      { toolCall: { name: "bash", arguments: { command: "echo tool-trace-ok" } } },
      { text: "ran it" },
    ]);
    const posted = await server.api("/api/sessions/" + id + "/messages", {
      method: "POST",
      body: JSON.stringify({ text: "run the command" }),
    });
    assert.equal(posted.status, 200, "posting a message should succeed");

    const lines = await toolLines(server, id);
    assert.equal(lines.length, 1, "one tool call should leave exactly one line");
    assert.equal(lines[0].tool.name, "bash", "the line should name the tool that ran");
    assert.equal(lines[0].tool.isError, false, "a successful call must not read as failed");
    assert.ok(lines[0].text.length > 0, "the line should carry a gist of the result");
    assert.ok(!("output" in lines[0].tool), "a finished line carries no running output");

    // 3. A restart replays the same line from SQLite: this is the part `pi.live` alone cannot do.
    await server.stop({ keepData: true });
    const restarted = await startServer({ dataDir: server.dataDir });
    try {
      const replayed = await restarted.api("/api/sessions/" + id + "/messages");
      const after = (replayed.body.entries ?? []).filter((entry) => entry.role === "tool");
      assert.equal(after.length, 1, "the tool line should survive a restart");
      assert.equal(after[0].tool.name, "bash", "the replayed line should still name the tool");
      assert.equal(after[0].text, lines[0].text, "the replayed line should be identical");

      // 4. The usage report counts that call: the aggregates must agree with the transcript.
      const usage = await restarted.api("/api/usage");
      assert.equal(usage.status, 200, "GET /api/usage should succeed");
      assert.ok(usage.body.totals.toolCalls >= 1, "the report should count the tool call");
      const bash = (usage.body.tools ?? []).find((row) => row.name === "bash");
      assert.ok(bash, "the report should list the bash tool");
      assert.ok(bash.calls >= 1, "bash should have at least one call");
      assert.equal(bash.errors, 0, "the successful call must not be counted as an error");
    } finally {
      await restarted.stop({ keepData: true });
    }
  },
};
