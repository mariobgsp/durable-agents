import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startHarness, ROOT } from "../harness.mjs";

async function waitFinal(client, sessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await client.request("sessions.transcript", { id: sessionId });
    const answer = [...entries].reverse().find((entry) => entry.role === "assistant" && entry.run);
    if (answer) return entries;
    await new Promise((done) => setTimeout(done, 200));
  }
  const entries = await client.request("sessions.transcript", { id: sessionId });
  throw new Error("no final answer; entries: " + entries.slice(-4).map((entry) => entry.role + ":" + String(entry.text).slice(0, 80)).join(" | "));
}

export default {
  name: "mcp-global",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "mcp__fake__echo", arguments: { text: "one" } } },
        { text: "first done" },
        { toolCall: { name: "mcp__fake__echo", arguments: { text: "two" } } },
        { text: "second done" },
      ],
      agents: [
        { id: "helper", name: "Helper" },
        { id: "worker", name: "Worker" },
      ],
    });
    try {
      const fixture = resolve(ROOT, "scripts/e2e/fixtures/fake-mcp.mjs");
      const added = await h.client.request("mcp.add", {
        name: "fake",
        command: process.execPath,
        args: [fixture],
      });
      assert.ok(added.tools.includes("mcp__fake__echo"), "the MCP tool registered");
      assert.ok(typeof added.rebound === "number", "the add reports how many conversations were rebound");

      const list = await h.client.request("mcp.list");
      assert.equal(list.servers[0].name, "fake");
      assert.equal(list.servers[0].connected, true);
      assert.ok(list.tools.some((tool) => tool.registeredName === "mcp__fake__echo"));

      const first = await h.client.request("sessions.create", { title: "MCP helper", agent: "helper" });
      await h.client.request("sessions.send", { id: first.id, text: "use the echo tool once" });
      const firstEntries = await waitFinal(h.client, first.id);
      const firstTool = firstEntries.find((entry) => entry.role === "tool" && String(entry.text).includes("echo: one"));
      assert.ok(firstTool, "helper used the MCP tool");

      const second = await h.client.request("sessions.create", { title: "MCP worker", agent: "worker" });
      await h.client.request("sessions.send", { id: second.id, text: "use the echo tool twice" });
      const secondEntries = await waitFinal(h.client, second.id);
      const secondTool = secondEntries.find((entry) => entry.role === "tool" && String(entry.text).includes("echo: two"));
      assert.ok(secondTool, "the unpaired agent also has the global MCP tool");
    } finally {
      await h.stop();
    }
  },
};
