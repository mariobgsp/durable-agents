/**
 * Agent mesh E2E: directed inboxes, multi-target delegation, fan-out messages, link indexing, and the guard
 * rails (self, disabled, cycles are covered by the same check).
 *
 * Delegation is deterministic because the sender waits for every target before it asks the model again; the
 * two target answers can arrive in either order, but both must arrive.
 */
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "mesh",
  async run(server) {
    const agent = async (name, extra = {}) => {
      const created = await server.api("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name, tools: [], mesh: "full", ...extra }),
      });
      assert.equal(created.status, 200, "creating " + name + " should succeed: " + JSON.stringify(created.body));
      return created.body.record.id;
    };
    const thread = async (agentId, title) => {
      const created = await server.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title, agentId }),
      });
      assert.equal(created.status, 200, "creating " + title + " should succeed");
      return String(created.body.id);
    };
    const sessions = async () => (await server.api("/api/sessions")).body.sessions;
    const findThread = async (agentId, purpose) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const hit = (await sessions()).find(
          (session) => session.agent === agentId && session.purpose === purpose,
        );
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error("no " + purpose + " thread for " + agentId + "; saw " + JSON.stringify(await sessions()));
    };
    const entries = async (id) => (await server.api("/api/sessions/" + id + "/messages")).body.entries;

    const ann = await agent("Ann");
    const bob = await agent("Bob");
    const chef = await agent("Chef");
    const dora = await agent("Dora", { enabled: false });
    const annThread = await thread(ann, "Ann thread");

    // 1. One delegation to two agents. The tool waits, so the script order is deterministic: tool call,
    //    two target answers (either order), then Ann's final answer.
    await server.script([
      { toolCall: { name: "agents_delegate", arguments: { to: ["bob", "chef"], task: "Reply with one short word." } } },
      { text: "bob answer" },
      { text: "chef answer" },
      { text: "ann final" },
    ]);
    const posted = await server.send(annThread, { text: "delegate this", requestId: "mesh-one" });
    assert.equal(posted.status, 200, "posting the delegation request should succeed");
    await server.waitForEntry(annThread, (entry) => entry.role === "assistant" && entry.text === "ann final");

    const bobTask = await findThread(bob, "delegate");
    const chefTask = await findThread(chef, "delegate");
    assert.equal(bobTask.peer, ann, "the task thread names the sender");
    assert.equal(chefTask.peer, ann);

    const delegatedAnswers = [];
    for (const id of [bobTask.id, chefTask.id]) {
      const all = await entries(String(id));
      const incoming = all.find((entry) => entry.role === "user" && entry.via?.kind === "agent");
      assert.ok(incoming, "the target thread should carry a provenance user message");
      assert.equal(incoming.via.from, ann);
      assert.equal(incoming.via.mode, "delegate");
      assert.equal(incoming.author, ann);
      const answer = all.find((entry) => entry.role === "assistant");
      assert.ok(answer, "the target should answer the delegated task");
      delegatedAnswers.push(answer.text);
      assert.ok(answer.run, "the answer should carry a run summary");
      assert.ok(answer.run.durationMs >= 0, "the run summary should have a duration");
      assert.ok(answer.run.usage.totalTokens > 0, "the run summary should have tokens");
    }
    assert.deepEqual(delegatedAnswers.toSorted(), ["bob answer", "chef answer"], "both targets answer");

    const fleet = await server.api("/api/fleet");
    assert.equal(fleet.status, 200, "GET /api/fleet should succeed");
    const links = fleet.body.links.filter((link) => link.kind === "delegate");
    assert.equal(links.length, 2, "one link per delegated target");
    assert.equal(new Set(links.map((link) => link.batchId)).size, 1, "both links share one batch");
    assert.ok(links.every((link) => link.status === "answered"), "delegated links should be answered");
    assert.ok(links.every((link) => link.threadId), "every link names the target thread");
    const annRow = fleet.body.agents.find((row) => row.id === ann);
    assert.ok(annRow, "the fleet should include Ann");
    const bobRow = fleet.body.agents.find((row) => row.id === bob);
    assert.ok(bobRow, "the fleet should include Bob");

    // 2. Fan-out message to every enabled agent except the sender. The tool returns after admission, so the
    //    target runs and Ann's next turn race for the scripted answers; only delivery and both inbox answers
    //    are asserted, not which text lands where.
    await server.script([
      { toolCall: { name: "agents_message", arguments: { to: ["all"], text: "A note for the team." } } },
      { text: "inbox one" },
      { text: "inbox two" },
      { text: "ann notices" },
    ]);
    const fan = await server.send(annThread, { text: "send the note", requestId: "mesh-fan" });
    assert.equal(fan.status, 200, "posting the fan-out should succeed");
    const bobInbox = await findThread(bob, "inbox");
    const chefInbox = await findThread(chef, "inbox");
    for (const id of [bobInbox.id, chefInbox.id]) {
      const all = await entries(String(id));
      assert.ok(
        all.some((entry) => entry.role === "user" && entry.via?.kind === "agent" && entry.via.from === ann),
        "the inbox should carry Ann's provenance",
      );
      await server.waitForEntry(String(id), (entry) => entry.role === "assistant");
    }
    const afterFan = await server.api("/api/fleet");
    const messageLinks = afterFan.body.links.filter((link) => link.kind === "message");
    assert.ok(messageLinks.length >= 2, "one message link per enabled target");
    assert.ok(messageLinks.every((link) => link.batchId), "message links share a batch id");
    // A single disabled target has a readable first line, unlike a fan-out whose first line is a delivery.
    await server.script([
      { toolCall: { name: "agents_message", arguments: { to: ["dora"], text: "are you there?" } } },
      { text: "disabled handled" },
    ]);
    await server.send(annThread, { text: "try disabled", requestId: "mesh-disabled" });
    const disabledLine = await server.waitForEntry(
      annThread,
      (entry) =>
        entry.role === "tool" &&
        entry.tool?.name === "agents_message" &&
        /disabled/i.test(entry.text),
    );
    assert.match(disabledLine.text, /disabled/i, "a disabled target is refused");

    // 3. A self-target is refused without writing another link.
    const beforeSelf = (await server.api("/api/fleet")).body.links.length;
    await server.script([
      { toolCall: { name: "agents_message", arguments: { to: ["ann"], text: "hello me" } } },
      { text: "self handled" },
    ]);
    await server.send(annThread, { text: "try self", requestId: "mesh-self" });
    const selfLine = await server.waitForEntry(
      annThread,
      (entry) =>
        entry.role === "tool" &&
        entry.tool?.name === "agents_message" &&
        /cannot target itself/i.test(entry.text),
    );
    assert.match(selfLine.text, /cannot target itself/i);
    const afterSelf = (await server.api("/api/fleet")).body.links.length;
    assert.equal(afterSelf, beforeSelf, "a refused self-target should not add a link");

    // 4. agents_list is a real tool, not just a definition.
    await server.script([
      { toolCall: { name: "agents_list", arguments: {} } },
      { text: "roster read" },
    ]);
    await server.send(annThread, { text: "who is here?", requestId: "mesh-list" });
    const listLine = await server.waitForEntry(
      annThread,
      (entry) => entry.role === "tool" && entry.tool?.name === "agents_list",
    );
    assert.match(listLine.text, /@bob/);
    assert.match(listLine.text, /@chef/);

    // 5. The inboxes are real sessions with the Inbox purpose and badges, not transient tasks.
    assert.equal(bobInbox.purpose, "inbox");
    assert.equal(chefInbox.purpose, "inbox");
  },
};