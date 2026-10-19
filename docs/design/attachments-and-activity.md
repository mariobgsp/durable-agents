# Attachments and live activity — design

Synthesis of the arena run for the four features: image input, document input, an honest loading
indicator, and tool-call/processing motion. The locked decisions this implements live in
[`../roadmap.md`](../roadmap.md) (rows *Animation*, *Attachments*, *Image normalization*, *Documents*,
*Groups and attachments*, `bodyLimit`, *Live activity*). Read that table first; this file explains the
shape behind it.

## Problem

Four features have to land on a durable-first system. The composer could only send a string, the
transcript mapper (`transcript.ts:entryToMsg`) collects only content blocks that carry a `text`
property, `WireMsg` had no attachment field, `store.pending` reconciled local echoes by trimmed-text
equality (which cannot see a message that has no text), the roadmap's animation rule forbade
continuous motion, and the server's `bodyLimit` was 2 MiB for every route.

Three facts decide the design, all verified in `pi-durable` 1.3.0 and `pi-ai`:

1. `submit({ type: "input", content, entry })` takes `content: string | (TextContent | ImageContent)[]`
   and places it as `entry.model`, for **any** entry kind that does not start with `pi.`
   (`harness/inbox.js:72-78`, `harness/submissions.js:112`). An input entry can therefore carry both
   the model's own content and a UI-facing `data` payload.
2. Context derivation is kind-agnostic: `entry.model ?? []` is what contributes messages
   (`harness/context.js:163`). Nothing keys on `pi.user`.
3. `ImageProcessor.prepare()` from `@earendil-works/pi-durable/images/node` **returns `undefined` for a
   Node `Buffer`** and works for a plain `Uint8Array` (measured on this machine: 5565-byte PNG →
   `undefined` for a Buffer, `image/png` for `new Uint8Array(...)`). The upload path must copy. `read` is not
   affected: its bytes come from the execution environment as plain `Uint8Array` chunks.
4. A queued or steered input is copied into `pi.inbox.items[].content` until the boundary places it, so
   "the bytes exist exactly once" holds for a *placed* message, not for one still in the queue.

So there is no conflict between "the model sees the image" and "the UI shows the image": they are two
views of one immutable record.

## Usage (caller's view)

```jsonc
// send: one request, one commit, one entry. Nothing is durable on a refusal.
POST /api/sessions/12/messages
{ "text": "what is in this screenshot?", "requestId": "2f1c…", "whenBusy": "steer",
  "attachments": [ { "name": "shot.png", "mimeType": "image/png", "data": "iVBORw0K…" } ] }
→ 200 { "submissionId": "41" }
→ 400 { "code": "images_unsupported", "error": "You cannot send images to e2e/faux-text." }

// read the bytes back: entryId, then the file's index in data.files
GET /api/sessions/12/attachments/94/0?token=<hex>
→ 200 content-type: image/png, cache-control: private, max-age=31536000, immutable
```

```ts
// server: the whole write boundary in one call, and the only place an attachment becomes durable
const { data, content } = await prepareUserMessage(body, await attachmentPolicy(record));
await conversation.submit({ type: "input", requestId: data.requestId, content,
  entry: { kind: USER_ENTRY_KIND, data }, whenBusy }, context);
```

```svelte
<!-- client: the composer owns drafts, never policy -->
const ok = await onsend({ text, files });   // the draft is cleared only when this is true
```

## Shape

### The durable record

```ts
export const USER_ENTRY_KIND = "chat.user";

type FileRef = { name: string; kind: "image" | "document";
  state: "included" | "truncated" | "omitted"; code?: string; reason?: string };

type UserEntryData = { requestId: string; text: string; author: string | null; files: FileRef[] };
```

`data.files[i]` describes *that same entry's* `i`-th file block, and it says **which block** by index. Byte
size, mime type and character count are derived from that block rather than stored, so those cannot drift;
the block index is stored because deriving it would mean parsing text we generated ourselves (the typed line,
a document's header, an image's marker are all text blocks). Both are written once, by one function, into an
immutable record, so "stored" here means "named", not "kept in sync". Content layout:

```text
content = [ text?, (document header + extracted text + truncation marker)*, "[attached image: name]"?*, ImageContent* ]
```

The marker line per image is a graft from the losing candidate: compaction serializes only text blocks
(`harness/compaction.js:299-330`), so without it a compacted thread silently forgets that an image was
ever attached. Because markers are text blocks, `blockOfFile` cannot tell them from a document's text by
scanning — which is why the file names its block index instead.

`chat.user` is the only kind a user message is placed as, in a direct thread and in a group alike. The
group path writes `{requestId, text, author: null, files: []}` through the same constructor and still
carries no model content (a model-bearing entry in a room conversation would try to generate).

### Retrieval

`GET /api/sessions/:id/attachments/:entryId/:index?token=` — the token is already accepted on every
`/api` route (`auth.ts:tokenOf`), so `<img>` needs no new auth scheme. The route resolves the entry
through `tx.entry(entryId)`, checks that the entry belongs to **that** conversation (`tx.entry` is a global
lookup, so `:id` would otherwise be decorative), derives the block, and serves image bytes or extracted
document text with `immutable` caching (entries are immutable, so that is a true statement).

### Documents

`documents.ts` owns extraction and nothing else: a `TextDecoder` with `fatal: true` plus a NUL sniff in
the first 8 KiB for text, `pdftotext - -` over stdin for PDFs (no path, no temp file, nothing to clean
up), and the per-file/per-message character budgets. A file that cannot be read is `omitted` with a
readable reason and a code; the rest of the message still sends.

### Phase model

Derived server-side from `pi.live` in `live.ts`, in this order, each row an *observed* signal:

| Condition | phase |
| --- | --- |
| `compactions` non-empty | `compacting` |
| `generation.retry` present | `retrying` |
| some call not `done` | `tool` |
| partial has a non-empty text block | `writing` |
| partial has a non-empty thinking block | `thinking` |
| `run` present, no generation yet | `starting` |
| nothing running | `null` |

"Thinking" requires observed thinking tokens; "writing" observed text. Elapsed time comes from the run
task's durable `startedAt` (`types.d.ts:502`), so `resume()` does not reset it, and it is `null` when the
record cannot be read — the UI then shows no timer rather than a number nobody observed. That is the *only*
elapsed time in the system: there is deliberately no per-call timer, because with
`toolExecution: "parallel"` a call is already `running` on the first publish that mentions it, so no
connection can observe when it began, and a stamp taken at first sight would really mean "since I
connected". `queued` carries `pi.inbox` items' `requestId` and `mode`, never their content. A group has no
`pi.live`, so its phase is `null` and it keeps the presence + `chat.typing` indicator it has today.

One `activity` frame replaces the old `tools` frame (snapshot, never diff — the rule the tool trace and
presence already follow), so a phase and a tool list can never disagree.

### Motion

`ToolCallRow` (shared by both halves of the trace) gains `since?: number` and an indeterminate sweep
inside a fixed-size slot; `ActivityStrip` carries the round header (phase, counts, elapsed, queued) and
the rows. One ticker in `state.svelte.ts` feeds every elapsed label and runs only while a phase is live.
Under `prefers-reduced-motion` the global rule at `app.css:2193` removes the motion and the same
information stays in text.

## Synthesis decision

Two candidates were designed independently from the same grounding.

- **Base: candidate 2, entry-owned attachments** (bytes in the entry the model was given, no side
  store). It won on four of the five rubric criteria: the durable record stays faithful to what the
  model actually saw (so a future fork/export/replay is not a lie), the phase model is honest by
  construction, its public surface is smaller, and it adds no second lifecycle (no GC, no orphan sweep,
  no second auth scheme, no Vite proxy line, no boot-time walk over every conversation). It also
  verified the Photon `Buffer` trap on the exact call it will make, which candidate 1's sketch did not
  mention and which would have silently dropped every image.
- **Grafted from candidate 1:** (1) the per-image marker text block, so compaction does not lose the
  fact that an image was attached; (2) a typed `code` alongside each file's `reason`, so tests and the
  UI assert on a stable identifier instead of prose; (3) `documents.ts` as its own module, so the
  largest new file stays about the durable record rather than about extraction.
- **Rejected from candidate 1:** the content-addressed store, the `store:` pointer inside `entry.model`,
  the `beforeRequest` hydration hook, the `/media/:id?k=hmac` route family outside the token scope, the
  boot-time sweep, and the `answering` phase for groups (a phase the server cannot observe). The pointer
  design's win was SQLite size, and it does not actually win it: it still keeps the normalized bytes on
  disk plus a pointer, so the total is the same while the durable record stops being a replay of the
  request.
- **Convergence (kept, and treated as strong signal):** `chat.user` as the only user-message kind;
  `requestId` as the echo key instead of text equality; server-side Photon normalization against the
  model's own `inputLimits`; `pdftotext` on stdin; refusing attachments in groups with a readable
  reason; one `activity` snapshot replacing `tools`; no new dependency; no browser-side downscale.

## Tradeoffs accepted

- **No deduplication across messages**: the same photo attached twice is stored twice, inside two
  immutable entries. In exchange there is no second store, no GC and no sync problem.
- **`app.sqlite` grows with attachments** (a 4 MB photo becomes ~5.3 MB of base64 in a JSON record), in
  exchange for the model's own input being the durable record. The roadmap's planned size display is
  where that becomes visible.
- **A 24 MiB body limit on one route** (`POST /api/sessions/:id/messages`), in exchange for the message
  being one atomic commit with no uploaded-but-unreferenced state.
- **No per-call elapsed time at all**, rather than a number that would mean "since I connected": with
  parallel tool execution the start of a call is not observable. The round's own elapsed time is real and is
  shown in the strip and the phase bubble.
- **`pi.user` is no longer written**; the read path keeps rendering existing entries. The alternative
  (two kinds, one with attachments) is two ways to write a user message.
- **Group attachments are refused** rather than copied per member conversation.
- **A client-side 500 ms ticker** while a phase is live, in exchange for elapsed text without a frame per
  second.

## Alternatives rejected

- **Content-addressed file store with a `store:` pointer in `entry.model` and a `beforeRequest`
  hydration hook** (the losing candidate's base). Feasible — `GenerationHooks.beforeRequest` exists and
  the default extension selection is every installed extension — but it makes `entry.model` a pointer
  rather than the request, and it buys no storage it does not also spend.
- **Base64 in `entry.data`** while leaving the kind alone: the bytes then exist twice, once in `data`
  and once in `model`, and the two can diverge.
- **Browser-side canvas downscale + a staged upload route**: a second limits implementation that must
  track `inputLimits` per model, EXIF orientation re-implemented in the browser, and a two-phase protocol
  with an orphan state, to save a wait on the same machine that does the work.
- **Deriving everything from the model blocks with no `data` at all**: the typed line would be
  re-derived from a block that also contains appended document text, so the bubble would show the whole
  prompt; `requestId` would have no home, so an image-only echo could not be reconciled.
- **A separate durable entry per attachment**: two entries to keep in step, a second write that can fail
  after the first, and no repair path.

## Open questions

- Should the card admit that an image was resized or re-encoded? Photon knows it once and it is not
  recoverable afterwards; today the card reports only what the model got.
- Should `pdftotext` be declared as a documented requirement instead of degrading to a visible omission?
- Should the wire types in `packages/web/src/types.ts` stop being a hand-maintained mirror of
  `server/src/wire.ts`? This change makes the mirror bigger.
- Group members' own tool activity stays invisible in the room; showing it means streaming member
  conversations into the room or a server-side merge.

## Next implementation step

`packages/server/src/documents.ts`, then `attachments.ts` with the image path only, then switch
`sendMessage` to place `chat.user` entries through it — that is the smallest change that proves the
direction (one entry, bytes inside it, no second store) and it is what the first E2E scenario asserts.
