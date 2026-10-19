/**
 * Image smoke test: a real model actually sees an image sent through the attachment path.
 *
 * `npm run e2e` proves the pipeline against the faux provider, and the faux provider is the right tool for
 * everything except this: it counts the blocks it was handed, it cannot tell whether a real model can read
 * one. So this asks for a property only the picture carries — the colour that fills it — and fails loudly if
 * the answer does not have it. A model that received pi-ai's placeholder instead of the image
 * ("(image omitted: model does not support images)") cannot pass that.
 *
 * Run: npm run smoke:image   (costs one short real model call)
 */
import { deflateSync } from "node:zlib";
import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
import { USER_ENTRY_KIND, prepareUserMessage } from "../src/attachments.ts";
import { imagePolicy } from "../src/capabilities.ts";
import { context, installExtensions, openHarness } from "../src/harness.ts";
import { resolveDefaultModel } from "../src/models.ts";
import { entriesToMsgs } from "../src/transcript.ts";

const SIZE = 64;
/** The colour the model has to name. Nothing in the prompt hints at it. */
const FILL: [number, number, number] = [222, 28, 34];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    const index = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour PNG, built here so the fixture has no dependency and the colour is unambiguous. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const model = await resolveDefaultModel();
console.log("model default:", model.provider + "/" + model.modelId);

const policy = imagePolicy(model, false);
if (!policy.allowed) {
  console.log("skipped: " + policy.reason);
  process.exit(0);
}

// The harness owns the Photon processor the upload path normalizes with, so it has to be open first — the
// server guarantees that (it opens at boot, before any route), and a script has to do it in order too.
const harness = await openHarness();
console.log("harness open (sqlite storage)");

// Prove what the provider was actually asked with: a real image block, or a placeholder string. Without this
// the answer alone cannot tell "the model ignored the picture" from "the picture never arrived".
installExtensions([
  defineExtension({
    name: "smoke-image-probe",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          let images = 0;
          let bytes = 0;
          let placeholders = 0;
          for (const message of messages) {
            const content = (message as { content?: unknown }).content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (!block || typeof block !== "object") continue;
              const typed = block as { type?: unknown; data?: unknown; text?: unknown };
              if (typed.type === "image") {
                images += 1;
                bytes += typeof typed.data === "string" ? typed.data.length : 0;
              }
              if (typed.type === "text" && typeof typed.text === "string" && typed.text.includes("image omitted")) {
                placeholders += 1;
              }
            }
          }
          console.log("request: " + images + " image block(s), " + bytes + " base64 chars, " + placeholders + " placeholder(s)");
          return undefined;
        },
      }),
    ],
  }),
]);

// The whole write boundary the route uses, so this exercises the same code as an upload.
const prepared = await prepareUserMessage(
  {
    text: "What single colour fills this image? Answer with one word.",
    requestId: "smoke-image",
    attachments: [
      { name: "sample.png", mimeType: "image/png", data: solidPng(SIZE, FILL).toString("base64") },
    ],
  },
  policy,
);
console.log("prepared file:", JSON.stringify(prepared.data.files[0]));

const conversation = await harness.createConversation(
  {
    ownership: { kind: "ownerless" },
    // No tools: the question is about the picture in the message, and a model with `read` will go looking for
    // a file on disk whose name matches the attachment instead of answering from what it was given.
    agent: { model, instructions: "Answer as briefly as possible.", tools: [] },
  },
  context,
);
console.log("conversation:", conversation.id);

const submission = await conversation.submit(
  {
    type: "input",
    requestId: prepared.data.requestId,
    content: prepared.content,
    entry: { kind: USER_ENTRY_KIND, data: prepared.data },
  },
  context,
);
console.log("submission:", submission.id);
console.log("status:", (await submission.wait(context)).status);

const view = await conversation.viewState(context);
const messages = entriesToMsgs(view.value.entries);
for (const message of messages) {
  const files = message.files?.length ? " (+" + message.files.length + " file)" : "";
  console.log("[" + message.role + "] " + message.text.slice(0, 300) + files);
}

await harness.close(context);

const answers: string[] = [];
for (const message of messages) {
  if (message.role === "assistant") answers.push(message.text.toLowerCase());
}
const answer = answers.join(" ");
if (!answer.includes("red")) {
  console.error(
    "\nFAIL: the model did not name the colour, so it probably did not receive the image. Answer: " + answer,
  );
  process.exit(1);
}
console.log("\nok: the model saw the image, and the entry kept it");
