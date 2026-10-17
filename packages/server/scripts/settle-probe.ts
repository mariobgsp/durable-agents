/** Debug tool: shape of the record returned by submission.wait(). */
import { context, harnessInstance, openHarness } from "../src/harness.ts";
import { conversationIdFromParam } from "../src/sessions.ts";

const id = process.argv[2];
if (!id) throw new Error("usage: node packages/server/scripts/settle-probe.ts <sessionId>");
await openHarness();
const conversation = await harnessInstance().conversation(conversationIdFromParam(id)!, context);
if (!conversation) throw new Error("session not found");

const submission = await conversation.submit({ type: "input", content: "Name one colour only." }, context);
const settled = await submission.wait(context);
console.log("keys:", Object.keys(settled));
console.log("status:", (settled as { status?: string }).status, "type:", (settled as { type?: string }).type);
console.log("answer keys:", Object.keys((settled as { answer?: object }).answer ?? {}));
console.log("json:", JSON.stringify(settled).slice(0, 900));
process.exit(0);
