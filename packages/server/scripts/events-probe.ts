/**
 * Debug tool: print raw pi-durable events for one session.
 * Pakai: node packages/server/scripts/events-probe.ts <sessionId> ["teks"]
 */
import { watchEvents } from "@earendil-works/pi-durable";
import { context, openHarness, harnessInstance } from "../src/harness.ts";
import { conversationIdFromParam, sendMessage } from "../src/sessions.ts";

const sessionId = process.argv[2];
const text = process.argv[3];
if (!sessionId) {
  console.error("usage: node packages/server/scripts/events-probe.ts <sessionId> [text]");
  process.exit(1);
}

await openHarness();
const conversationId = conversationIdFromParam(sessionId);
if (conversationId === null) throw new Error("sessionId is not a number");

const stream = await watchEvents(harnessInstance(), conversationId, context);
console.log("snapshot: entri =", stream.snapshot.entries.length, "generation =", stream.snapshot.generation?.attempt ?? "-");

stream.start(async (events) => {
  for (const event of events) {
    if (event.type === "message_update") {
      console.log("message_update changes:", JSON.stringify(event.changes.map((change) => change.type)));
      continue;
    }
    if (event.type === "message_end" || event.type === "entry_appended") {
      console.log(event.type, "kind =", event.entry.kind, "id =", String(event.entry.id));
      continue;
    }
    console.log(event.type);
  }
});

if (text) {
  await new Promise((done) => setTimeout(done, 500));
  const result = await sendMessage(sessionId, { text });
  console.log("post =", result ? "ok" : "failed");
}

setTimeout(() => process.exit(0), Number(process.env.PI_PROBE_MS ?? 40000));
