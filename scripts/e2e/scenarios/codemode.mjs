/**
 * Code mode E2E: the extension belongs to the agents that select it.
 *
 * `@earendil-works/pi-durable/codemode` is registered only for an agent whose tool list names `codemode` (see
 * `installCodemode()` in `harness.ts`), so its sandbox graph is not imported at boot. The accepted trade is that
 * a fresh default thread — no agent, every *installed* tool — no longer offers it: the model gets
 * `Tool codemode is not available` back instead of a script result, and the turn still ends with an answer.
 *
 * Both halves are asserted here because the previous measurement pass found that the suite passed with and
 * without the deferral, so a regression on either side would have shipped silently. The restart is the
 * load-bearing part of the agent half: a new process has nothing installed until `openHarness()` reads the
 * agents on disk, so it is what proves the boot scan.
 */
import assert from "node:assert/strict";
import { startServer } from "../harness.mjs";

const CODEOK = "Script completed";

/**
 * Run one scripted codemode call and return the tool line it *adds*.
 *
 * The wait is on the line count, not on "a tool line": after a restart the previous call's line is still in the
 * transcript, so a predicate that matches any tool line would assert on the old result and pass whatever the new
 * process did.
 */
async function callCodemode(server, id, code) {
  const before = (await server.api("/api/sessions/" + id + "/messages")).body.entries.filter(
    (entry) => entry.role === "tool",
  ).length;
  await server.script([
    { toolCall: { name: "codemode", arguments: { code } } },
    { text: "answered" },
  ]);
  await server.send(id, { text: "run a script" });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { body } = await server.api("/api/sessions/" + id + "/messages");
    const lines = (body.entries ?? []).filter((entry) => entry.role === "tool");
    if (lines.length > before) return lines.at(-1);
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error("no new tool line for codemode");
}

export default {
  name: "codemode",
  async run(server) {
    // 1. No agent anywhere: a default thread is ownerless, and code mode is not among the installed tools.
    const plain = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "ownerless code mode" }),
    });
    assert.equal(plain.status, 200, "creating a thread without an agent should succeed");
    const plainId = String(plain.body.id);

    const refused = await callCodemode(server, plainId, "return 1 + 1");
    assert.equal(refused.tool.name, "codemode", "the refusal should name the tool the model called");
    assert.equal(refused.tool.isError, true, "an uninstalled tool must read as a failed call");
    assert.equal(refused.text, "Tool codemode is not available", "the refusal is the runtime's own sentence");
    assert.deepEqual(
      (refused.data?.diagnostics ?? []).map((diagnostic) => diagnostic.code),
      ["tool_unavailable"],
      "the diagnostic should say the tool is unavailable",
    );

    // The refusal is one tool result, not a dead thread: the model's next answer still lands.
    const answer = await server.waitForEntry(
      plainId,
      (entry) => entry.role === "assistant" && entry.text === "answered",
      30_000,
    );
    assert.equal(answer.role, "assistant", "the thread should still answer after the refusal");

    // 2. An agent that lists codemode gets it, installed on demand by the agent change.
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Code mode", tools: ["codemode"], permissions: "full" }),
    });
    assert.equal(created.status, 200, "creating an agent should succeed");
    const agentId = created.body.record.id;

    const bound = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "agent code mode", agentId }),
    });
    assert.equal(bound.status, 200, "creating an agent thread should succeed");
    const boundId = String(bound.body.id);

    const ran = await callCodemode(server, boundId, "return 1 + 1");
    assert.equal(ran.tool.name, "codemode", "the agent's call should reach the codemode tool");
    assert.equal(ran.tool.isError, false, "a real script must succeed");
    assert.equal(ran.text, CODEOK, "the tool should report the script as completed");

    // 3. A restart is a fresh process: the agent's stored tool name only resolves because `openHarness()`
    //    installs code mode for the agents on disk. If that scan is dropped, this call is refused.
    await server.stop({ keepData: true });
    const restarted = await startServer({ dataDir: server.dataDir });
    try {
      const again = await callCodemode(restarted, boundId, "return 2 + 2");
      assert.equal(again.tool.name, "codemode", "the replayed agent thread should still call codemode");
      assert.equal(again.tool.isError, false, "code mode must still work after a restart");
      assert.equal(again.text, CODEOK, "the restarted server should run the script");

      // The install is process-wide (the registry is shared), so once any agent has selected code mode an
      // ownerless thread in that same process gets it too. That is the honest shape of the deferral: it holds
      // until something installs the tool, and a restart of a server with no codemode agent is the fresh case.
    } finally {
      await restarted.stop({ keepData: true });
    }
  },
};
