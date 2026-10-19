/**
 * Permissions E2E: the tiers are a policy, and a refusal is visible and inert.
 *
 * The point of these assertions is that a blocked call must leave **no side effect** — the file the command
 * would have created must not exist — and that the refusal is a readable sentence in the transcript rather
 * than a tool that quietly does not appear. `pi` has no sandbox, so this is the layer that stops an accident
 * or a prompt-injected instruction from reaching a tool; the systemd unit is the layer that contains an
 * allowed one.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { startServer } from "../harness.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

export default {
  name: "permissions",
  async run(server) {
    const canary = "/tmp/durable-permissions-canary-" + Date.now();

    const agent = async (name, extra) => {
      const created = await server.api("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name, tools: ["read", "write", "bash"], ...extra }),
      });
      assert.equal(created.status, 200, "creating an agent should succeed: " + JSON.stringify(created.body));
      return created.body.record.id;
    };
    const thread = async (agentId) => {
      const created = await server.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "permissions", agentId }),
      });
      assert.equal(created.status, 200, "creating a thread should succeed");
      return created.body.id;
    };
    const toolLines = async (id) =>
      (await server.api("/api/sessions/" + id + "/messages")).body.entries.filter(
        (entry) => entry.role === "tool",
      );
    /**
     * Run one scripted tool call and return the transcript line it left.
     *
     * Waits for the line *count* to grow: a wait that matches any tool line is satisfied by the previous
     * call's line, which makes the next assertion test the wrong row.
     */
    const callTool = async (id, call) => {
      const before = (await toolLines(id)).length;
      await server.script([{ toolCall: call }, { text: "noted" }]);
      await server.send(id, { text: "go ahead" });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const lines = await toolLines(id);
        if (lines.length > before) return lines.at(-1);
        await new Promise((done) => setTimeout(done, 150));
      }
      throw new Error("no new tool line for " + call.name);
    };

    // 1. Standard refuses the shell, the refusal is readable, and nothing happened.
    const standard = await agent("Perm standard", { permissions: "standard" });
    const standardThread = await thread(standard);
    const refused = await callTool(standardThread, {
      name: "bash",
      arguments: { command: "touch " + canary },
    });
    assert.match(
      refused.text,
      /not available to a Standard agent/,
      "the refusal must say why, got: " + refused.text,
    );
    assert.equal(refused.tool.isError, true, "a blocked call is an error result");
    assert.ok(!existsSync(canary), "a blocked call must leave no side effect");

    // 2. Full access runs the very same call.
    const full = await agent("Perm full", { permissions: "full" });
    const fullThread = await thread(full);
    await callTool(fullThread, { name: "bash", arguments: { command: "touch " + canary } });
    assert.ok(existsSync(canary), "full access must run the command");
    await rm(canary, { force: true });

    // 3. Custom refuses exactly what the user named, with its own wording.
    const custom = await agent("Perm custom", { permissions: "custom", blockedTools: ["bash"] });
    const customThread = await thread(custom);
    const customRefusal = await callTool(customThread, {
      name: "bash",
      arguments: { command: "touch " + canary },
    });
    assert.match(customRefusal.text, /Custom permissions/, "got: " + customRefusal.text);
    assert.ok(!existsSync(canary), "a Custom block must leave no side effect either");

    // A wildcard rule blocks a whole family of names.
    const wildcard = await agent("Perm wildcard", { permissions: "custom", blockedTools: ["ba*"] });
    const wildcardThread = await thread(wildcard);
    const wildcardRefusal = await callTool(wildcardThread, {
      name: "bash",
      arguments: { command: "echo hi" },
    });
    assert.match(wildcardRefusal.text, /Custom permissions/, "got: " + wildcardRefusal.text);

    // 4. A scoped agent stays inside its root: outside is refused, inside works.
    const scoped = await agent("Perm scoped", { permissions: "standard", cwd: ROOT });
    const scopedThread = await thread(scoped);
    const outside = await callTool(scopedThread, {
      name: "read",
      arguments: { path: "/etc/hostname" },
    });
    assert.match(outside.text, /outside this agent's root/, "got: " + outside.text);
    const inside = await callTool(scopedThread, { name: "read", arguments: { path: "README.md" } });
    assert.doesNotMatch(
      inside.text,
      /outside this agent's root/,
      "a path inside the root must be allowed, got: " + inside.text,
    );
    assert.ok(inside.text.length > 0, "the allowed read should return the file's gist");

    // 5. An agent that already had an escape hatch is reported as full rather than quietly losing it.
    const legacy = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Perm legacy", tools: ["read", "bash"] }),
    });
    assert.equal(legacy.body.record.permissions, undefined, "an old record keeps no tier on disk");
    const legacyThread = await thread(legacy.body.record.id);
    await callTool(legacyThread, { name: "bash", arguments: { command: "echo legacy" } });
    const legacyLine = (await toolLines(legacyThread)).at(-1);
    assert.doesNotMatch(
      legacyLine.text,
      /not available to a Standard agent/,
      "an agent that already had bash must keep it (and be labelled full, not silently downgraded)",
    );
  },
};
