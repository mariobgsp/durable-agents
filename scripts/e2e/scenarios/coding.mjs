/**
 * Coding E2E: the hand-off is explicit, and an absent CLI is a readable refusal rather than a crash.
 *
 * The durable branch is the one that must work everywhere: it spawns nothing and tells the model to keep the
 * work in this thread. The opencode branch is asserted for its failure shape on a machine without opencode; on a
 * machine that has it, the test only requires that the call produced a tool result rather than an exception.
 */
import assert from "node:assert/strict";

export default {
  name: "coding",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Coding test", tools: ["coding"] }),
    });
    assert.equal(created.status, 200, "creating the coding agent should succeed: " + JSON.stringify(created.body));
    const agentId = created.body.record.id;

    const session = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Coding", agentId }),
    });
    assert.equal(session.status, 200);
    const id = String(session.body.id);

    await server.script([
      { toolCall: { name: "coding", arguments: { tool: "durable", prompt: "add a test" } } },
      { text: "Keeping it here." },
    ]);
    assert.equal((await server.send(id, { text: "please code this" })).status, 200);
    const durable = await server.waitForEntry(
      id,
      (entry) => entry.role === "tool" && entry.tool?.name === "coding",
    );
    assert.equal(durable.tool.isError, false, "the durable branch never fails: " + durable.text);
    assert.match(durable.text, /do the work in this thread/i, "the model is told to continue itself");
    assert.ok(
      !durable.text.includes("spawn") && !durable.text.includes("exit code"),
      "choosing durable must not start a child process",
    );

    const availability = (await server.api("/api/coding")).body;
    assert.equal(typeof availability.pi.available, "boolean");
    assert.equal(typeof availability.opencode.available, "boolean");

    if (!availability.opencode.available) {
      await server.script([
        { toolCall: { name: "coding", arguments: { tool: "opencode", prompt: "fix the build" } } },
        { text: "opencode is not installed." },
      ]);
      assert.equal((await server.send(id, { text: "use opencode" })).status, 200);
      const missing = await server.waitForEntry(
        id,
        (entry) => entry.role === "tool" && entry.tool?.name === "coding" && entry.tool.isError === true,
      );
      const rows = server.query("SELECT record FROM entries WHERE record LIKE ?", "%opencode%");
      assert.ok(rows.length > 0);
      assert.ok(missing.text.length > 0, "the refusal still has a line in the thread");
    }
  },
};
