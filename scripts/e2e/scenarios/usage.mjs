/**
 * Usage and run-summary E2E. The faux provider reports token usage and cache counters, so the assertions are
 * about the durable entries and the report's own arithmetic, not about a mocked number.
 */
import assert from "node:assert/strict";

export default {
  name: "usage",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Usage agent", tools: [] }),
    });
    assert.equal(created.status, 200);
    const agentId = created.body.record.id;
    const thread = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Usage thread", agentId }),
    });
    const id = String(thread.body.id);

    await server.script([{ text: "First answer." }]);
    await server.send(id, { text: "first question", requestId: "usage-one" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "First answer.");

    await server.script([{ text: "Second answer." }]);
    await server.send(id, { text: "second question", requestId: "usage-two" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "Second answer.");

    const entries = (await server.api("/api/sessions/" + id + "/messages")).body.entries;
    const answers = entries.filter((entry) => entry.role === "assistant");
    assert.equal(answers.length, 2);
    for (const answer of answers) {
      assert.ok(answer.run, "each completed answer should carry a run summary");
      assert.ok(answer.run.durationMs >= 0, "the run summary should have a duration");
      assert.ok(answer.run.usage.totalTokens > 0, "the run summary should have tokens");
      assert.ok(answer.ts > 0, "the message timestamp should be real");
    }
    assert.ok(answers[1].run.usage.cacheRead > 0, "the second turn should read the prompt cache");

    // A stateless call has no conversation entry, so the ledger is what makes it visible.
    await server.script([{ text: "Documentation" }]);
    const suggested = await server.api("/api/agents/suggest-responsibility", {
      method: "POST",
      body: JSON.stringify({ soulMd: "You own documentation." }),
    });
    assert.equal(suggested.status, 200);

    const report = await server.api("/api/usage?fresh=1");
    assert.equal(report.status, 200);
    const body = report.body;
    assert.ok(body.timezone, "the report names the server time zone");
    assert.ok(body.firstAt > 0, "the report should have a first recorded call");
    assert.ok(body.totals.tokens > 0, "tokens should be counted");
    assert.ok(body.totals.cacheRead > 0, "cached tokens should be counted");
    assert.ok(body.periods.today.tokens > 0, "today should include the calls");
    assert.ok(body.periods.all.tokens >= body.periods.today.tokens);
    assert.ok(body.months.length > 0, "the report should include a month series");
    assert.ok(body.days.length > 0, "the report should include a day series");
    assert.ok(
      body.days.some((day) => day.tokens > 0 && day.cacheRead > 0),
      "the day bucket should carry tokens and cache",
    );
    const row = body.agents.find((agent) => agent.id === agentId);
    assert.ok(row, "the agent should be attributed");
    assert.ok(row.all.tokens > 0);
    assert.ok(row.today.tokens > 0);
    assert.ok(row.all.cacheRead > 0);
    assert.ok(body.stateless.turns >= 1, "the suggestion should be in the stateless ledger");
    assert.ok(body.stateless.tokens > 0);

    // A soft-deleted thread still spent tokens; only a purge removes rows for good.
    const second = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Will be deleted", agentId }),
    });
    await server.script([{ text: "Deleted answer." }]);
    await server.send(String(second.body.id), { text: "spend here", requestId: "usage-deleted" });
    await server.waitForEntry(String(second.body.id), (entry) => entry.role === "assistant");
    await server.api("/api/sessions/" + second.body.id, { method: "DELETE" });
    const afterDelete = await server.api("/api/usage?fresh=1");
    assert.ok(afterDelete.body.totals.sessions >= 2, "soft-deleted threads still contribute to the report");
    assert.ok(afterDelete.body.totals.tokens > body.totals.tokens, "the deleted thread's tokens were counted");
  },
};
