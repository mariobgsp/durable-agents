/**
 * Questions E2E: the `question` tool asks in the thread, and the answer comes back as a normal message.
 *
 * The point of the assertions is the client contract, not the wording: the question is a durable
 * `chat.question` entry with `text`, `author` and `options`, so the existing transcript mapper renders it as an
 * assistant bubble and the client can draw `data.options` as buttons. The model is told the turn is over, and the
 * user's answer is an ordinary user message — nothing special has to happen for the next turn to see it.
 */
import assert from "node:assert/strict";

const QUESTION = "Deploy now or wait for the review?";
const OPTIONS = ["Deploy now", "Wait for the review"];

export default {
  name: "questions",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Question test", tools: ["question"] }),
    });
    assert.equal(created.status, 200, "creating an agent should succeed: " + JSON.stringify(created.body));
    const agentId = created.body.record.id;

    const session = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Question", agentId }),
    });
    assert.equal(session.status, 200, "creating a thread should succeed");
    const id = String(session.body.id);

    await server.script([
      { toolCall: { name: "question", arguments: { text: QUESTION, options: OPTIONS } } },
      { text: "Waiting for your answer." },
    ]);
    const posted = await server.send(id, { text: "should I ship this?" });
    assert.equal(posted.status, 200, "posting a message should succeed");

    // 1. The question is one entry, written while the turn is still running, and the mapper sees a bubble.
    const question = await server.waitForEntry(id, (entry) => entry.kind === "chat.question");
    assert.equal(question.role, "assistant", "text + author must render as an assistant bubble");
    assert.equal(question.text, QUESTION, "the bubble should show the question itself");
    assert.equal(question.author, agentId, "the question should be attributed to the agent");
    assert.deepEqual(question.data.options, OPTIONS, "the client reads data.options to draw the buttons");

    // 2. The model was told its turn is over; it must not keep working on an answer it does not have.
    const tool = await server.waitForEntry(
      id,
      (entry) => entry.role === "tool" && entry.tool.name === "question",
    );
    assert.equal(tool.tool.isError, false, "asking should not be an error");
    assert.match(tool.text, /turn is over/i, "the result should end the turn, got: " + tool.text);
    assert.match(tool.text, /next user message/i, "the result should say how the answer arrives");

    // 3. The answer is a normal user message, through the same path as anything the user types.
    await server.script([{ text: "Deploying now." }]);
    const answer = await server.send(id, { text: OPTIONS[0] });
    assert.equal(answer.status, 200, "posting the answer should succeed");
    const reply = await server.waitForEntry(
      id,
      (entry) => entry.role === "user" && entry.text === OPTIONS[0],
    );
    assert.equal(reply.kind, "chat.user", "the answer should be a plain user entry, not a special kind");
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "Deploying now.");
  },
};
