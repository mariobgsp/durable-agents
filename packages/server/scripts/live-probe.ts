/** Debug tool: are assistant partials published to the pi.live document during generation? */
import { context, harnessInstance, openHarness } from "../src/harness.ts";
import { conversationIdFromParam, sendMessage } from "../src/sessions.ts";

const sessionId = process.argv[2] ?? "2";
const conversationId = conversationIdFromParam(sessionId);
if (conversationId === null) throw new Error("sessionId is not a number");

await openHarness();
const conversation = await harnessInstance().conversation(conversationId, context);
if (!conversation) throw new Error("session not found");

type Live = { generation?: { attempt?: number; message?: { content?: unknown[] } } };
let running = true;
const stamp = () => new Date().toISOString().slice(17, 23);

const poller = (async () => {
  let lastLength = -1;
  while (running) {
    const view = await conversation.viewState(context);
    const live = view.value.docs["pi.live"] as Live | undefined;
    const length = JSON.stringify(live?.generation?.message?.content ?? []).length;
    if (length !== lastLength) {
      console.log(stamp(), "live:", live?.generation ? "attempt " + String(live.generation.attempt ?? "-") : "-", "content bytes:", length);
      lastLength = length;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
})();

await new Promise((resolve) => setTimeout(resolve, 400));
const result = await sendMessage(sessionId, { text: "Sebutkan lima warna, satu kata masing-masing." });
console.log(stamp(), "post:", result ? "ok" : "failed");
await new Promise((resolve) => setTimeout(resolve, 7000));
running = false;
await poller;
process.exit(0);
