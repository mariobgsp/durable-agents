/**
 * Smoke test: the harness opens, SQLite storage works, the model answers.
 * Run: npm run smoke  (or: node packages/server/scripts/smoke.ts "question")
 */
import { context, openHarness } from "../src/harness.ts";
import { resolveDefaultModel } from "../src/models.ts";
import { entriesToMsgs } from "../src/transcript.ts";

const prompt = process.argv[2] ?? "Answer with one number only: what is 2+2?";
const model = await resolveDefaultModel();
console.log("model default:", model.provider + "/" + model.modelId);

const harness = await openHarness();
console.log("harness open (sqlite storage)");

const conversation = await harness.createConversation(
  { ownership: { kind: "ownerless" }, agent: { model, instructions: "Answer as briefly as possible." } },
  context,
);
console.log("conversation:", conversation.id);

const submission = await conversation.submit({ type: "input", content: prompt }, context);
console.log("submission:", submission.id);

const settled = await submission.wait(context);
console.log("status:", settled.status);

const view = await conversation.viewState(context);
for (const message of entriesToMsgs(view.value.entries)) {
  console.log("[" + message.role + "] " + message.text);
}

await harness.close(context);
console.log("done");
