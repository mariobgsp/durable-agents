/**
 * Terminal E2E: the agent's shell is a tool, and its result is reachable in the thread.
 *
 * The transcript keeps one trace line per call by design, so this test asserts two things separately: the line
 * the owner sees (the command it ran), and the durable record the model was given (the output, the directory and
 * the exit code). The environment assertion is the security one: the server token must not reach a child shell.
 */
import assert from "node:assert/strict";

export default {
  name: "terminal",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Shell test", tools: ["terminal"] }),
    });
    assert.equal(created.status, 200, "creating the shell agent should succeed: " + JSON.stringify(created.body));
    const agentId = created.body.record.id;

    const session = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Shell", agentId }),
    });
    assert.equal(session.status, 200);
    const id = String(session.body.id);

    await server.script([
      {
        toolCall: {
          name: "terminal",
          arguments: { command: 'echo "token=$(printenv PI_API_TOKEN || echo unset)"; pwd; echo ok' },
        },
      },
      { text: "Ran it." },
    ]);
    assert.equal((await server.send(id, { text: "check the shell" })).status, 200);

    const line = await server.waitForEntry(id, (entry) => entry.role === "tool" && entry.tool?.name === "terminal");
    assert.equal(line.tool.isError, false, "a zero exit is not an error: " + line.text);
    assert.match(line.text, /^\$ echo "token=/, "the transcript line starts with the command it ran");

    // The durable record is what the model reads: output, directory and exit code.
    const okRows = server.query("SELECT record FROM entries WHERE record LIKE ?", "%token=unset%");
    assert.ok(okRows.length > 0, "the child environment must not have the server token");
    assert.ok(okRows.some((row) => String(row.record).includes(server.dataDir)), "the scratch directory is the cwd");
    assert.ok(okRows.some((row) => String(row.record).includes("[exit code 0]")), "the exit code is recorded");

    // A failing command is data, not a crash: the exit code comes back and the turn continues.
    await server.script([{ toolCall: { name: "terminal", arguments: { command: "exit 3" } } }, { text: "Failed." }]);
    assert.equal((await server.send(id, { text: "now fail" })).status, 200);
    const failed = await server.waitForEntry(
      id,
      (entry) => entry.role === "tool" && entry.tool?.name === "terminal" && entry.tool.isError === true,
    );
    assert.match(failed.text, /^\$ exit 3/, "the failing command is still named in the thread");
    const failedRows = server.query("SELECT record FROM entries WHERE record LIKE ?", "%exit code 3%");
    assert.ok(failedRows.length > 0, "the non-zero exit code is recorded for the model");
  },
};
