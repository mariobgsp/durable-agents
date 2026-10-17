/** Debug tool: does the provider really stream tokens (bypassing pi-durable)? */
import { models, resolveDefaultModel } from "../src/models.ts";

const ref = await resolveDefaultModel();
const model = await models.getModel(ref.provider, ref.modelId);
if (!model) {
  console.error("model not found:", ref.provider + "/" + ref.modelId);
  process.exit(1);
}
console.log("model:", ref.provider + "/" + ref.modelId, "api:", (model as { api?: string }).api ?? "-");

const messages = [
  { role: "user" as const, content: "Sebutkan dua warna, satu kata masing-masing.", timestamp: Date.now() },
];

async function attempt(
  label: string,
  run: () => AsyncIterable<{ type: string; delta?: string; error?: unknown }>,
) {
  const started = Date.now();
  let events = 0;
  let deltas = 0;
  let text = "";
  let last = started;
  const gaps: number[] = [];
  let failure = "";
  for await (const event of run()) {
    events += 1;
    if (event.type === "error") {
      failure = String((event.error as { errorMessage?: string })?.errorMessage ?? "").slice(0, 200);
    }
    if (event.type === "text_delta") {
      deltas += 1;
      text += event.delta ?? "";
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }
  }
  console.log(
    label + " → events:", events, "deltas:", deltas, "ms:", Date.now() - started,
    "max gap:", gaps.length ? Math.max(...gaps) : "-",
    "teks:", JSON.stringify(text.slice(0, 120)),
  );
  if (failure) console.log(label + " ERROR:", failure);
}

const sessionId = "stream-probe";
await attempt("stream+session      ", () => models.stream(model, { messages }, { sessionId }));
await attempt("streamSimple+session", () => models.streamSimple(model, { messages }, { sessionId }));
