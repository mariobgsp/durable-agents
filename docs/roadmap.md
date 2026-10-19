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

Not done:

- [ ] Purge (`POST /api/sessions/:id/purge`) — needs raw SQL against pi-durable's internal tables; the
      columns are known (`conversations`, `entries`, `tasks`, `submissions`, `documents`,
      `document_revisions`) but it deserves a verified implementation instead of a guess
- [ ] `ui.test.mjs` (puppeteer-core) covering the sidebar grouping, the dialogs and the
      "no Indonesian in the rendered DOM" assertion; `puppeteer-core` is not installed yet
- [ ] `app.sqlite` size display in the UI

- [ ] `PI_E2E` mode: faux provider (`faux-vision` with `input: ["text","image"]`, `faux-text` text-only),
      `POST /api/e2e/script`, `GET /api/e2e/state`, guarded by `PI_E2E` **and** the token
- [ ] `scripts/e2e/{harness,run}.mjs`, `npm run e2e` (faux) and `npm run e2e:real` (adds the real-model smoke)
- [ ] Sidebar grouped per agent → threads underneath, plus `No agent` and `Groups` sections, per-item
      type markers (group: `#` + member count + mode; agent thread: agent-coloured dot + `@agent`;
      plain thread: neutral dot), collapse state in `localStorage`, thread search
- [ ] Rename a thread (`PATCH /api/sessions/:id`) with inline editing in the chat header
- [ ] Delete a thread (`DELETE /api/sessions/:id`, soft delete via `deletedAt`, hidden from the list,
      `?includeDeleted=1` to recover) with our own confirm dialog
- [ ] Purge (`POST /api/sessions/:id/purge`): delete that conversation's rows from pi-durable's tables
      (`conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions` — names from
      `dist/storage/sqlite/schema.js:6-15`; `record_ids`/metadata untouched) + show `app.sqlite` size
- [ ] Move a thread to another agent (`PATCH /api/sessions/:id {agentId}` → `configure` + record update)
- [ ] "Make it work again": warning chip with **Enable agent** (`enabled: true` + `rebindAgent`) and
      **Restart thread** (`conversation.reset(handoff)` with an automatic handoff note)

### Phase 6 — agent capabilities (PARTIAL)

Done:

- [x] `capabilities.ts`: `canSeeImages()` from `model.input.includes("image")`, `imageLimits()` from
      `inputLimits.images.resize`, and `modelCatalog()` with input modalities, context window, cost and
      the thinking levels a model actually supports (`null` in `thinkingLevelMap` means unsupported)
- [x] `read` now takes an image processor (`createNodePhotonImages()`), so agents can read photos the
      way pi does (decode, EXIF orientation, resize to the model's limits)
- [x] Code mode installed: `createCodemodeExtension({ sandbox: new CodemodeSandbox({...}) })` with
      `quickjs-wasi`; `@earendil-works/pi-codemode` is now a declared server dependency
- [x] New agents default to pi's tool set: `read`, `write`, `edit`, `bash`, `codemode`
- [x] `agent.json.vision` (`"auto"` | `"off"`) stored and read back

Not done:

- [ ] Image attachments end to end: `{ text, attachments }` → content blocks, client-side downscale,
      rendering in bubbles, byte budget
- [ ] Vision pre-flight: refuse (400) an image for a model that cannot see it, instead of letting pi-ai
      silently write `"(image omitted: model does not support images)"`
- [ ] `GET /api/models?provider=` route and the model picker in the agent editor (per-agent model with
      capability badges and a "Test model" button); the server already stores provider/modelId per agent
- [ ] `agent-extension.ts` (one extension per agent for codemode + hooks + MCP + an optional custom
      `extension.ts`), `blockedTools`, `instructionsSuffix`, `autoContinue`

- [ ] `capabilities.ts`: `canSeeImages(model)` from `model.input.includes("image")`, `imageLimits(model)`
      from `inputLimits.images.resize`, `modelCatalog()` for editor badges; `GET /api/models?provider=`
- [ ] `harness.ts`: `createCodingTools({ images: await createNodePhotonImages() })` so `read` handles images
      like pi, plus `createCodemodeExtension({ sandbox: new CodemodeSandbox({...}) })` (`quickjs-wasi` is installed)
- [ ] `agent.json`: `enabled`, `vision`, `voice`, `skills`, `blockedTools`, `instructionsSuffix`, `hooks`,
      `mcp`, and default tools `read/write/edit/bash/codemode`
- [ ] `agent-extension.ts`: one extension `agent:<id>` per agent (codemode + skills section + quick hooks +
      MCP + optional `extension.ts`), selected per conversation through `configure({ extensions })`
- [ ] Enable/disable agents: hidden from pickers, existing threads keep working behind a warning chip
- [ ] Image attachments: `{ text, attachments: [{ mimeType, data }] }` → content blocks, **pre-flight 400**
      when the model cannot see images (pi-ai silently writes `"(image omitted: model does not support
      images)"` — `transform-messages.js:1`), attachments rendered in bubbles with a warning chip for that placeholder
- [ ] UI: attach button, paste, drag-drop, client-side downscale (1568 px, JPEG q0.82), byte budget
- [ ] Agent editor: model picker per agent with capability badges, thinking levels limited to
      `model.thinkingLevelMap`, "Test model" button, vision toggle driven by the model

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

- [ ] Animated typing bubble (avatar + coloured name + three dots using `transform`/`opacity`) for both
      groups and private threads; static under `prefers-reduced-motion`
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

Two real bugs the new E2E caught immediately, both worth remembering:

1. **An instant faux answer never streams.** With the default faux speed the answer completed before the
   first partial commit (`progress.partialIntervalMs: 80`), so no `delta` frames appeared. The faux
   provider now streams at `tokensPerSecond: 12`, which makes the streaming path testable.
2. **A harness that sends `content-type: application/json` on an empty body gets 400 from Fastify.**
   `DELETE` looked broken until the harness only announced a JSON body when it had one.

Remaining phases, in the order I would do them: finish phase 6 (attachments + pre-flight + model picker),
phase 10 (animation + responsive, which is what makes the UI usable on a phone), phase 9 (voice + video),
phase 7 (MCP + hooks), phase 8 (skills + curator), then the phase 6.0 leftovers (purge, UI E2E).

## Known gaps (do not claim these are done)

- The pi-lens checker still reports **stale** findings for web files (for example "api.ts has no
  `createRoom`" when it is at line 69, or "Session has no `kind`" when it is at types.ts:25). Verified
  false with `grep`, `npx tsc -p packages/web/tsconfig.json --noEmit`, `svelte-check` (0 errors) and
  `npm run build`. Trust those four, not the checker's cache.
- Error state, pending state and the streaming bubble have not been photographed (they need interaction).
  Streaming is verified separately through `scripts/ws-probe.mjs`.
- Image/file attachments do not exist yet (needs `createNodePhotonImages`; planned in phase 6).
- The Tauri shell has never been compiled, and `tauri-plugin-single-instance` is not installed: do not
  run the desktop app twice before that lands (two servers, one `app.sqlite`).
- System notifications on turn completion (Web Notification API) are not wired up; the PWA is installable.
- `nyahut` mode makes 2×members short calls per user message; there is no real cost counter yet, only an
  estimated tooltip.
- No multi-user, remote deployment, billing, mobile or marketplace.
