# Roadmap and decisions

This document is binding. Change the plan here first.

## Locked decisions

| Item | Value |
| --- | --- |
| Shape | Local web app, browser-first. Tauri/PWA belong to phase 5 and are optional. |
| Frontend | Svelte 5 + Vite, no SvelteKit, own hash router. Deps: `marked` + `dompurify`. |
| Backend | Fastify + `@fastify/websocket` + `@fastify/static`; `@earendil-works/pi-durable` **pinned to 1.3.0**. |
| Provider | `opencode-go` / `deepseek-v4.1-flash`; credentials from `~/.pi/agent/auth.json` (then `OPENCODE_API_KEY`, then `data/credentials.json`). Other providers are registered but unused. |
| Data model | One thread = one conversation. A group is a thread with N members (group = thread = room). |
| Group modes | `Nyahut` (default) · `Moderator` · `Silent`, stored per group in the session record. |
| Meaning of `Nyahut` | The members that **feel responsible according to SOUL.md** answer; the rest oversee and may add when needed. Not "everyone answers", not "one fixed duty agent". |
| When nobody claims | Default: the highest-confidence member answers plus a `room.no-claim` system entry; per-room option `ifNobodyClaims: "silent"`. |
| Nyahut budget | Claim + oversee are short stateless calls (`models.completeSimple`); answers are full durable calls. About `2N − R` short calls plus `R` full ones per user message. |
| Input modalities | pi-ai supports **`["text", "image"]` only** (`pi-ai/dist/providers/model-schema.d.ts:9`). Image: native content blocks. Video: the browser extracts 6 frames and sends them as images. Voice: browser STT (`webkitSpeechRecognition`) plus TTS (`speechSynthesis`). No video or audio reaches a model directly. |
| Model per agent | Each agent stores its own `provider`/`modelId`; groups may mix models. The editor shows per-model capability badges (image, context window, cost) and only offers thinking levels the model supports. |
| Navigation | Sidebar is grouped **per agent (one section) with its threads underneath**, plus `No agent` and `Groups` sections. Groups and agent threads carry different markers (see Phase 6.0). |
| Language | All system text English; Indonesian only in `data/` and maintainer briefs; `npm run lint:lang` enforces it. |
| Animation | **State change**: only `opacity` + `transform`, 120–180 ms, `cubic-bezier(.2,.8,.2,1)`, at most 2 animated elements per frame. **Live indicator** (an element that says work is happening and nothing about how much): continuous motion is allowed under five rules — (1) `opacity` + `transform` only, inside a fixed-size box, so no frame reflows or repaints text; (2) indeterminate: never a percentage, a filling bar, or any shape whose position can be read as progress; (3) at most one animated element per tool row plus one round-level sweep, and per-row motion stops once more than 3 calls are in flight in one round (the round-level sweep still moves); (4) it appears only while the server reports the activity it represents, so an idle frame has no motion at all; (5) under `prefers-reduced-motion: reduce` it is fully static and the same information is carried by the phase word, the counts and the elapsed time in text. |
| Attachments | Bytes live in the entry the model was given: the user message's own model content, in SQLite. No content store, no upload route, no temp file, no second copy. `chat.user` is the only kind a user message is placed as; `data.files[]` describes that same entry's own blocks. |
| Image normalization | Server-side, with the same Photon processor `read` uses, to `imageLimits(model)` from the model's own `inputLimits`. The browser uploads originals and never re-implements a limit. **Photon's worker needs a plain `Uint8Array`**: a Node `Buffer` makes `prepare()` return `undefined`, so the bytes are copied before the call. |
| Documents | Server-side: UTF-8 text inlined into the prompt; PDFs through `pdftotext` (poppler) on **stdin**, never a path. Truncation is stated to the model and to the user with the same numbers. No `pdfjs-dist`/`mammoth`/`xlsx` dependency. |
| Groups and attachments | A group refuses attachments (400, readable reason): each member conversation is its own model-visible entry, so supporting it would keep N copies of every byte. The room's own user entry stays `{requestId, text, author: null, files: []}` and still carries no model content. |
| `bodyLimit` | 2 MiB stays the global limit. `POST /api/sessions/:id/messages` declares its own 24 MiB, because one request carries its own attachments and nothing else needs to. |
| Live activity | The phase comes from `pi.live` and from nothing else: no timers, no heuristics. "Thinking" requires observed thinking tokens, "writing" observed text, "tool" a call that is not done. Whole-list snapshots on change, the same rule as presence and the tool trace. |
| Screenshots | Required for every UI step: `npm run shots` → `docs/ui-review/<date>/` + `findings.md` (at most 2 polish rounds per step). |
| Testing | **E2E only.** No unit tests. Deterministic E2E uses the official faux provider (`fauxProvider()`, `fauxToolCall()`, `FauxModelDefinition.input`) plus a `PI_E2E` control endpoint; one optional smoke test hits the real model. UI E2E uses `puppeteer-core` with the system Chromium. |
| Code mode | `codemode` is registered only for an agent whose tool list names it (`installCodemode()` in `harness.ts`, through a synchronous `require`). An ownerless thread resolves to every *installed* tool, so a fresh default thread has no code mode: the model gets `Tool codemode is not available` and the turn still answers. Owner-approved consequence, taken for the behaviour, **not** for the ~1.5 MB it saves. The registry is process-wide, so a thread created after any agent used it gets it back until the process restarts. |
| Security | Bind `127.0.0.1`, require `X-PI-Token` (or `?token=` for WS), allowlist `Host`, no permissive CORS. |

## Phases

### Phase 1 — M0: durable chat + streaming (DONE)

- [x] Monorepo scaffold, one-command `npm run dev` (token + server + Vite)
- [x] pi-durable harness + SQLite (`data/app.sqlite`) + `resume()`
- [x] REST: `POST/GET /api/sessions`, `GET/POST /api/sessions/:id/messages`, `POST /api/sessions/:id/abort`
- [x] WS `/api/ws?conversation=<id>` + text streaming
- [x] Svelte chat UI (sidebar, timeline, composer, local echo, reconnect)
- [x] Screenshot gate + `findings.md`

M0 evidence:

| Criterion | Result |
| --- | --- |
| One dev command | `npm run dev` → server 8787 + Vite 5173 |
| Streaming | `node scripts/ws-probe.mjs <id> "message"` → `entry` → `message-start` → `delta` → `entry` → `message-end` |
| Refresh/restart | transcript read from `viewState()`; unchanged across several server restarts |
| Without token | `POST /api/sessions` → **401** |
| Screenshots | 6 PNGs (3 routes × 2 viewports) + `findings.md` |
| Bundle size | JS **43.25 kB gzip**, CSS 1.71 kB gzip (limit: < 120 kB) |
| Local production | `npm start` serves UI + API on one port, token injected into `index.html` |

Important implementation note: **`message_update` from `watchEvents` is never emitted** for the
`opencode-go` provider (partials never appear as translated view changes). Streaming therefore reads
`docs["pi.live"].generation.message.content` through `conversation.watch()` and diffs it into
`delta` frames. `watchEvents` also emits `message_start`/`message_end` for **user** entries, so only
`pi.assistant` entries close the bubble.

### Phase 2 — M1: agents (`AGENT.md` + `SOUL.md`) (DONE)

- [x] `data/agents/<slug>/{agent.json,AGENT.md,SOUL.md}` + templates
- [x] `AgentEditor`: name, thinking level, tools, cwd, two markdown textareas, prompt preview
- [x] One-line `responsibility` + "Suggest from SOUL.md" (`models.completeSimple`)
- [x] Agent threads: `configure({ model, thinkingLevel, instructions, tools, cwd })`
- [x] Hot reload: `rebindAgent()` applies the latest files to existing threads
- [x] Screenshot gate for `#/agents`, `#/agents/new`

Evidence: the "pirate" agent answered in character (a pirate greeting); after editing SOUL.md the API
reported `rebound: 1` and the next answer switched to a formal assistant voice. Those transcripts are
user data in `data/`, so they keep their Indonesian text.

### Phase 3 — M2: groups + mode switch (DONE)

- [x] Group config: `kind: "group"` + `room` inside `data/sessions.json`
      (deviation: one index file instead of `data/rooms/<id>.json`, to avoid two sources of truth)
- [x] One conversation per member (`room.conversations`), created on first use.
      **Deviation:** ownerless, not yet an anchor task `{ background: true }`; aborting a group does abort its members.
- [x] Pure `planTargets()` in `packages/server/src/router.ts` (mention wins; moderator; silent; nyahut)
- [x] Roster prompt: each member receives a digest of the last 14 entries plus the member list, so all
      members hear the same conversation (not yet via `section()`)
- [x] UI: mode switch in the room header, coloured member chips, author name per bubble, system entries,
      "is typing" indicator, group-specific composer placeholder
- [x] One agent answers once per user message (stops `@pirate` ↔ `@chef` ping-pong)

Evidence: the "Crew dapur" group (pirate+chef+robot) — `nyahut` mode → 3 answers, each in character;
`silent` → 0 new answers; `moderator` (chef) → 1 answer.

### Phase 4 — M3: 3-phase `Nyahut` (DONE)

- [x] `claimAll()` parallel and stateless (`packages/server/src/nyahut.ts`), fail-closed, parsing that
      survives broken/truncated output, claim reason shown as a `room.claim` system entry
- [x] Durable answers for claimants + `maxResponders` + `ifNobodyClaims`
- [x] `overseeAll()` once per user message, `chat.note` entries, no new round triggered
- [x] Claim reason in the timeline + cost tooltip on the mode button
- [ ] Role badges (Answering/Overseeing) and a `kill -9` test for this phase — not done

Evidence (`node packages/server/scripts/nyahut-probe.ts` and the "Nyahut uji" group):

| Scenario | Result |
| --- | --- |
| "How do I cook fish so it does not smell fishy?" | only **@chef** claimed ("matches the chef's responsibility") → chef answered; pirate and robot stayed silent |
| "Our production server is down, what do we check first?" | only **@robot** claimed ("infrastructure and technical repair") → robot answered |
| A question outside every member's area | all `claim=false` with sensible reasons → `ifNobodyClaims: highest` ran one member |
| Oversee: chef's answer deliberately wrong ("fish is best eaten raw") | **@robot** added a correction, pirate stayed silent |

### Phase 5 — optional (PARTIAL)

- [x] PWA: `public/manifest.webmanifest` + `public/icon.svg` + `public/sw.js` (caches only hashed
      `/assets/*`; HTML is never cached so the injected token cannot go stale)
- [x] Provider screen (`#/providers`): per-provider credential status, readable model list, save/delete
      an API key into `data/credentials.json`
- [ ] OAuth login through the GUI (`models.login` + prompt/notify over WS) — not done
- [~] Tauri v2: full scaffold in `apps/desktop/` (Cargo.toml, tauri.conf.json, `main.rs` that spawns the
      server, waits for `PI_SERVER_READY` and kills the child on exit), **never compiled** because Rust
      is not installed (~1.5 GB and a 5–15 minute first build)
- [ ] Distribution without Node (bundle `node` as a resource / Node SEA) — not done

### Phase 5.5 — language conversion (DONE)

- [x] Language rule documented (README + this file); `npm run lint:lang` wired into `npm run check`
- [x] `scripts/check-language.mjs`: word-bounded marker scan over system paths, `lang-allow` escape
      hatch, `data/` and `node_modules/` excluded
- [x] Model prompts translated (claim, oversee, group digest, responsibility suggestion) — behavior
      re-verified with the same probes
- [x] Server strings, comments and startup logs translated
- [x] Web UI labels, comments, error strings, PWA manifest (`lang: "en"`) and `<html lang="en">`
- [x] Root scripts, `.env.example`, README and docs translated; screenshot route names renamed
- [x] `data/` deliberately untouched: thread titles, conversations and existing agent SOUL.md/AGENT.md
      keep their Indonesian text

Evidence: `npm run lint:lang` went from **452 findings in 44 files** to **0**; the lint itself had a
blind spot (words directly after `\n` escapes were missed, because the `n` counts as a word character)
which was found and fixed while converting, and three replacements that silently missed their target
were reported by the script and fixed by hand.

Translating the prompts needed behaviour work, not only words. After the oversee prompt became English
the overseer stopped adding a correction to a deliberately unsafe answer (0/3 probe runs). The cause was
truncated JSON rather than the language: the parser matched the first \`}\` (non-greedy) and the token
budget was 200. Fixed with a greedy match, 300/500-token budgets, a more directive oversee prompt, and
English negation keywords in the keyword fallback. Re-measured: 3/3 runs add a correction.

### Phase 6.0 — E2E harness + navigation + thread management (PARTIAL)

Done:

- [x] `PI_E2E` mode: faux provider with two models (`faux-vision` accepting images, `faux-text` text-only),
      streaming at a realistic pace so partials are actually exercised; `POST /api/e2e/script` (a small
      step DSL: `text`, `thinking`, `toolCall`, `error`, and `echo: model|systemPrompt|images|lastUser`)
      plus `GET /api/e2e/state`, both guarded by `PI_E2E` **and** the token
- [x] `scripts/e2e/{harness,run}.mjs`: each scenario boots a throwaway server (own data dir, own port via
      `PI_SERVER_PORT=0`, own token), drives it over HTTP and WebSocket, and can restart it on the same
      data dir; `npm run e2e` and `npm run e2e:real`
- [x] Scenario `sessions` passing: create → scripted answer over WS (snapshot, deltas, entry) → transcript
      over REST → rename → delete → `?includeDeleted=1` still lists it → restart the server and both the
      rename and the deletion survive
- [x] Sidebar grouped per agent with its threads underneath, plus `No agent` and `Groups` sections,
      type markers (group: `#` + member count + mode; agent thread: agent-coloured dot + `@agent`;
      plain thread: neutral dot), thread search, per-section collapse stored in `localStorage`
- [x] Thread rename (inline in the chat header), delete (soft, own dialog), restore route,
      move to another agent (dialog), restart thread (`reset()` with a generated handoff)
- [x] Agent enable/disable (section menu) with an in-chat notice offering **Enable agent** and
      **Restart thread** when the agent behind a thread is disabled
- [x] Storage: `GET /api/storage` reports the data directory split by what a reader recognises (database,
      write-ahead log, shared memory, the session index, agent files, and their total), and
      `POST /api/storage/cleanup` folds the write-ahead log back in, vacuums, and returns the sizes **before
      and after** plus `reclaimedBytes` — so the caller reports what came back instead of claiming a win it
      never measured
- [x] Purge (`POST /api/sessions/:id/purge`): each table's conversation column is discovered from the schema
      (`PRAGMA table_info`, the column matching `/conversation/i`) instead of assumed, the transcript is
      written to `data/exports/<id>.json` **before** any row is deleted, and the session record is removed
      rather than soft-deleted. The E2E proves the rows left the `entries` table, not just the list
- [x] The data directory's size in the UI: the **Storage** panel in `#/usage` shows every part with its
      share of the total, a **Cleanup** button that prints the measured result (including the honest "0 B
      reclaimed" of a second run), and the note that a purge is per thread, irreversible and exports first

Not done:

- [ ] `ui.test.mjs` (puppeteer-core) covering the sidebar grouping, the dialogs and the
      "no Indonesian in the rendered DOM" assertion; `puppeteer-core` is not installed yet

### Phase 6 — agent capabilities (PARTIAL)

Done:

- [x] `capabilities.ts`: `canSeeImages()` from `model.input.includes("image")`, `imageLimits()` from
      `inputLimits.images.resize`, and `modelCatalog()` with input modalities, context window, cost and
      the thinking levels a model actually supports (`null` in `thinkingLevelMap` means unsupported)
- [x] `read` now takes an image processor (`createNodePhotonImages()`), so agents can read photos the
      way pi does (decode, EXIF orientation, resize to the model's limits)
- [x] Code mode: `createCodemodeExtension({ sandbox: lazySandbox })` with `quickjs-wasi`;
      `@earendil-works/pi-codemode` is a declared server dependency. Two layers of lazy loading:
      the **extension** is installed by `installCodemode()` the first time an agent change names `codemode`
      (so the module graph is not imported at boot), and the **sandbox** module is imported by the first
      script that runs: a proxy stands in for the class and a `codemode-loader` extension wraps the tool's
      `execute()`, so the `import()` happens before the extension's synchronous `start()` can ask for the class
- [x] New agents default to pi's tool set: `read`, `write`, `edit`, `bash`, `codemode`
- [x] `agent.json.vision` (`"auto"` | `"off"`) stored and read back
- [x] The model picker in the agent editor: the provider/model selects, the capability badges
      (images, context window, cost, reasoning), the thinking levels limited to the model's own
      `thinkingLevels`, and a **Test model** button (`GET /api/models?provider=` + `POST /api/models/test`)
- [x] Image attachments: `{ text, attachments: [{ name, mimeType, data }] }` → content blocks, **pre-flight
      400** when the model cannot see images, attachments rendered in bubbles with the server's own sentence
      for a file it could not read
- [x] UI: attach button, paste, drag-drop, byte budget. **Deviation:** no client-side downscale; the server
      normalizes with the model's own limits

Not done:

- [ ] `agent-extension.ts` (one extension per agent for codemode + hooks + MCP + an optional custom
      `extension.ts`), `blockedTools`, `instructionsSuffix`, `autoContinue`
- [ ] `agent.json`: `voice`, `skills`, `blockedTools`, `instructionsSuffix`, `hooks`, `mcp` (`enabled`,
      `vision` and the default tool set are in)
- [~] Enable/disable agents: the section menu, the inline warning chip and `enabled` in `agent.json` are in,
      but a disabled agent is still offered by the group member picker (`Groups.svelte:78` does not filter on
      it) and `POST /api/sessions` does not refuse one
- [ ] Agent editor: the agent's own `vision` toggle (the switch that would drive the record's `vision` field;
      the model picker, the badges and **Test model** are already in)

Done in the session that added attachments:

- [x] Image attachments end to end: `{ text, attachments }` → native content blocks, rendered in bubbles,
      per-message byte and count budgets. **Deviation:** normalization runs on the server with the Photon
      processor `read` already loads, not in the browser — one limit table instead of two, and no canvas
      code (see the *Image normalization* row in the locked decisions)
- [x] Vision pre-flight: a 400 with a stable code, before anything is durable, plus the agent's own
      `vision: "off"` switch finally enforced (`capabilities.imagePolicy`)
- [x] Documents: text inlined under its own header, PDFs through `pdftotext` on stdin, truncation stated to
      the model and to the user with the same numbers
- [x] `npm run e2e` scenario `attachments`: the model's own view (`echo: "images"`), the entry's own bytes
      (a SQLite read), a restart, the 400, the budgets, and a deterministic missing-converter branch

Done in the session that added storage, questions, search, links and diagrams:

- [x] `questions.ts`: the `question` tool writes a `chat.question` entry (`{ text, author, options }`) and
      ends the turn — the existing transcript mapper already renders it, and `QuestionOptions.svelte` draws
      the options as buttons, answerable once
- [x] `search.ts`: the `web-search` tool over DuckDuckGo's keyless HTML endpoint, no dependency and no key.
      Naming the provider and reporting a failure as a failure (HTTP status, rate limit, unreadable markup)
      is the point: a changed page must not look like "no results"
- [x] Hyperlinks: `lib/markdown.ts` gives an external link `target="_blank"` + `rel="noreferrer noopener"`
      after sanitizing (`javascript:` is dropped before the hook runs), while a same-page `#` link is left to
      the in-app router
- [x] Mermaid: a fenced ```mermaid block becomes `Mermaid.svelte`, which imports `mermaid` only when a
      diagram is present (`securityLevel: "strict"`, pan + zoom + reset). The library and its layout engines
      stay in their own chunks, so a thread with no diagram fetches none of it
- [x] `npm run e2e` scenarios `questions` and `search` (the search one stubs `fetch` with the real page
      shape, so its parser and its failure paths are asserted without the network)

### Step 3 — deferring the codemode extension graph (LANDED, as a behaviour change)

The codemode module graph — `@earendil-works/pi-durable/codemode` → `pi-codemode/portable` → `inline` → `vm`
→ `quickjs-wasi` — was imported at boot for a tool most agents never call. It is now registered by
`installCodemode()` only when an agent change names `codemode`: **not for the memory**, which is at the edge of
the measurement, but because a default thread should not carry a tool nobody selected. The owner approved that
trade; it is recorded as a locked decision above.

- **The memory is ~1.5 MB and inside the noise.** Boot-idle RSS, same machine, 8–10 samples per state:
  139.0 MB median without a codemode agent vs 140.3 MB with one; the clean ranges are 137.4–139.1 vs
  138.8–140.9 and they overlap, and both states show a ~20 MB machine hiccup (151–159 MB) in 1–2 runs out of
  8–10. In a bare Node process, importing `pi-durable/codemode` costs **+1.4–2.2 MB**. An earlier run of the
  same probe read 139.8 → 140.6 (worse) and another 140.4 → 137.9 (better): the effect is smaller than the
  spread, so the change is not sold as a memory win.
- **The earlier ~35 MB attribution was wrong.** The heavy graph arrives through the static
  `createCodemodeExtension` import, not through the sandbox class: constructing the sandbox costs 0.
- **The shape.** Two synchronous seams, because registration in pi-durable is synchronous and load-bearing:
  `toolsByName()` installs code mode when an agent's own tool list asks for it (a new or rebound agent), and
  `openHarness()` installs it at boot only if some `agent.json` on disk selects it (a restart). The load is a
  `require()` — Node resolves an ESM package through it synchronously — because `toolsByName()` cannot await.
- **The accepted consequence.** An ownerless thread (the sidebar's "New thread", `POST /api/sessions` with no
  `agentId`) leaves its tool list unset, which resolves to *every installed tool*. A fresh default thread
  therefore no longer offers code mode: the model gets `Tool codemode is not available` (diagnostic
  `tool_unavailable`) and the thread answers normally afterwards. The registry is process-wide, so once an
  agent has selected code mode, an ownerless thread in that same process gets it too until the process restarts.
- **The suite was blind to both halves.** `npm run e2e` passed with the old registration and with the deferral,
  so the scenario `codemode` now pins them: a default thread is refused, an agent thread runs a script, and the
  same agent thread still runs one after a restart (the boot scan). Dropping the boot scan makes that scenario
  fail — checked by mutation, not by assumption.

### Phase 7 — MCP and hooks per agent (APPROVED, NOT STARTED)

- [ ] `mcp.ts`: read the `~/.pi/agent/mcp.json` + `data/mcp.json` catalog (pi's own format), connect over
      stdio/HTTP, `tools/list` → `defineTool` named `mcp__<server>__<tool>`, `tools/call` on execute,
      honouring `enabled`/`exposure`/`timeout`/`${ENV}`
- [ ] Per-agent `mcp: string[]`; `exposure: "deferred"` routes tools through `tool_search`
- [ ] Declarative quick hooks (`blockedTools` via `hook(ToolTask,{beforeTool})`, `instructionsSuffix` via
      `beforeRequest`, `autoContinue` via `onYield`) plus `data/agents/<id>/extension.ts` for full custom hooks
- [ ] UI: agent settings panel (enable/disable, MCP multi-select, blocked tools, suffix, autoContinue, skills, curator) + MCP status

### Phase 8 — many skills per agent + curator (APPROVED, NOT STARTED)

- [ ] `skills.ts`: discover `data/agents/<id>/skills/`, `data/skills/` and `~/.agents/skills/` (read-only),
      parse `SKILL.md` frontmatter (`name`, `description`, `license`, `generated`, `disable-model-invocation`),
      CRUD, promotion (agent → shared), dedupe, `renderSkillSection(agentId)`
- [ ] Progressive disclosure: the prompt section lists every enabled skill (name + description + path);
      the body is read on demand through the `skill(name, args?)` tool (always present when an agent has
      skills) or through `read`
- [ ] `curator.ts`: after a run, one stateless call producing
      `{ create, update, name, description, body, reason }`; triggers = manual button, ≥2 tool calls, or a
      similar task seen before; per-agent mode `off | propose | auto` (default `propose`); dedupe turns a
      match into an update; generated skills get `generated: true` and stay with their creator until promoted
- [ ] UI: multi-select skill list with source badges, view contents, add manually, promote, proposal card
      in the timeline (Accept/Reject), "Save as skill" on a bubble

### Phase 9 — voice and video (APPROVED, NOT STARTED)

- [ ] Video: 6 evenly spaced frames + a duration caption; refused when the model cannot see images
- [ ] Voice: STT with feature detection (the mic button appears only when supported, and the UI says why
      when it is not) and TTS through `speechSynthesis` (speaker button per bubble, per-agent `autoRead`)

### Phase 10 — animation and responsiveness (APPROVED, NOT STARTED)

- [x] Honest activity indicator: the run's phase (starting → thinking → writing → tool), the queue depth,
      elapsed time and the calls of the round, from `activity` frames the server derives out of `pi.live`.
      One indeterminate sweep per row, or one round-level sweep past three calls in flight, fully static
      under `prefers-reduced-motion`. The three-dot placeholder remains for a thread whose phase the server
      cannot see (a group, or a socket still connecting)
- [ ] Responsive pass following `redesign-existing-projects`: 64 px icon rail below 1024 px, off-canvas
      drawer below 720 px, `min-height: 100dvh`, sticky composer with safe-area insets, scrollable chat
      header, ≥44×44 px targets, `:focus-visible` rings, skeleton loaders, `text-wrap: balance`,
      `tabular-nums`; screenshots at 1440/1024/390 for six routes

## Status snapshot (end of the session that built phases 5.5 and 6.0)

Verified green at that point:

| Check | Result |
| --- | --- |
| `npm run check` | `tsc` clean + `svelte-check` 0 errors + `lint:lang` clean |
| `npm run e2e` | `PASS sessions` (1 passed, 0 failed) |
| `npm run build` | JS 53.34 kB gzip, CSS 3.19 kB gzip |
| `npm run smoke` | real model answers, credentials still resolve from `~/.pi/agent/auth.json` |
| `npm run smoke:image` | **1 real image block, 0 placeholders** in the request, and `deepseek-v4.1-flash` named the image's colour |

Two real bugs the new E2E caught immediately, both worth remembering:

1. **An instant faux answer never streams.** With the default faux speed the answer completed before the
   first partial commit (`progress.partialIntervalMs: 80`), so no `delta` frames appeared. The faux
   provider now streams at `tokensPerSecond: 12`, which makes the streaming path testable.
2. **A harness that sends `content-type: application/json` on an empty body gets 400 from Fastify.**
   `DELETE` looked broken until the harness only announced a JSON body when it had one.

Remaining phases, in the order I would do them: phase 10's responsive pass (the animation half is done),
phase 9 (voice + video), phase 7 (MCP + hooks), phase 8 (skills + curator), then the phase 6.0 leftovers
(the puppeteer UI E2E) and the agent editor's `vision` toggle.

## Status snapshot (end of the session that added attachments and the live activity frame)

| Check | Result |
| --- | --- |
| `npm run check` | `tsc` clean + `svelte-check` 0 errors + `lint:lang` clean |
| `npm run e2e` | **9 passed, 0 failed**, including the new `attachments` and `live-activity` scenarios |
| `npm run build` | JS **65.53 kB gzip**, CSS 7.29 kB gzip (limit: < 120 kB) |
| `npm run shots:replying` | 9 screenshots + `docs/ui-review/2026-10-19/findings.md`, 4 findings fixed |

Two facts the new E2E proved that reading the source could not:

1. **A per-call start time is not observable.** With `toolExecution: "parallel"` a call is already `running`
   on the first publish that mentions it, so no connection can know when it began. The per-call timer was
   removed rather than faked; the round's own elapsed time comes from the run task and survives a reconnect
   (asserted by two sockets reporting the same `since`).
2. **`pi.live.tools` is emptied when the round's tool phase ends**, so a `done` row is not guaranteed to be
   observable at all. The durable `pi.tool-result` line in the transcript is what records a finished call.

## Status snapshot (end of the session that added storage, questions, search, links and diagrams)

| Check | Result |
| --- | --- |
| `npm run check` | `tsc` clean + `svelte-check` **0 errors, 2 warnings** (both in `Dialog.svelte`, untouched) + `lint:lang` clean |
| `npm run e2e` | **13 passed, 0 failed** (`activity`, `attachments`, `identity`, `live-activity`, `memory`, `models`, `permissions`, `questions`, `search`, `sessions`, `steering`, `storage`, `tools`) |
| `npm run build` | entry **71.86 kB JS** + **7.70 kB CSS** gzip (limit 120 kB); the entry grew by 1.12 kB over the pre-panel tree (70.74 kB), and mermaid/`elk` stay in their own chunks |
| `npm run shots:replying` | 11 screenshots |
| `#/usage` Storage panel | 2 screenshots (1440×900, 390×844) + the rendered DOM read back: 6 rows, no wrapped value, no clipped note, no horizontal overflow at either tier, and the cleanup line checked after a real click — including a second run reporting `0 B reclaimed` |

The panel found one defect while it was being reviewed, and it was the panel's own: `GET /api/storage`
wraps its report (`{ storage: {…} }`), and reading it as the report itself rendered `undefined B` for every
part with a `NaN%` bar. The screenshot is what caught it; `svelte-check` was clean either way.

## Known gaps (do not claim these are done)

- The pi-lens checker still reports **stale** findings for web files (for example "api.ts has no
  `createRoom`" when it is at line 69, or "Session has no `kind`" when it is at types.ts:25). Verified
  false with `grep`, `npx tsc -p packages/web/tsconfig.json --noEmit`, `svelte-check` (0 errors) and
  `npm run build`. Trust those four, not the checker's cache.
  **Worst case seen so far (2026-10-19):** after the permission fields were added, the session cache *and* a
  fresh `source: lsp` probe both insisted that `api.health()` lacked `sandboxed` and that `AgentFiles` lacked
  `policy` — while `svelte-check` reported 0 errors and `grep` showed all four declarations on disk
  (`api.ts:101`, `types.ts:188/190/193`). The probe was quoting the *pre-edit* shapes, so the language
  server was holding stale in-memory copies; `touch`ing the files did not clear it. Do not "fix" these by
  adding duplicate declarations — that would be a real error.
- The error state has still not been photographed (it needs interaction). Streaming is verified separately
  through `scripts/ws-probe.mjs`; the `starting` and `queued` states are asserted in
  `scripts/e2e/scenarios/live-activity.mjs` instead, because their windows are too short to hold open.
- **An agent with `read` may go looking for a file named like an attachment.** `npm run smoke:image` first
  answered "White" because the model called `read sample.png` and found an unrelated file with that name
  (`/usr/share/cups/doc/images/sample-image.png`). The image was in the request the whole time. The smoke
  test now disables tools to isolate the picture, but the real fix would be to tell the model in the prompt
  that the attachment is already provided — worth doing if a real agent ever reads the wrong file.
- Attachments cannot be sent in a group thread: refused with a readable reason, because every member
  conversation would keep its own copy of the bytes.
- A purge has no UI: `POST /api/sessions/:id/purge` is the only way to remove a thread's rows for good, and
  the thread menu's delete stays a soft delete. The Storage panel states the difference without offering the
  button. `#/usage` is also not in the `npm run shots` route list (8 routes), so the panel was reviewed with
  a throwaway DevTools-protocol script instead of the committed gate.
- Web search follows DuckDuckGo's HTML endpoint: keyless and dependency-free, but a shape dependency, so the
  `search` E2E asserts its parser and failure paths against a stubbed page rather than the live one.
- The Tauri shell has never been compiled, and `tauri-plugin-single-instance` is not installed: do not
  run the desktop app twice before that lands (two servers, one `app.sqlite`).
- System notifications on turn completion (Web Notification API) are not wired up; the PWA is installable.
- `nyahut` mode makes 2×members short calls per user message; there is no real cost counter yet, only an
  estimated tooltip.
- No multi-user, remote deployment, billing, mobile or marketplace.
