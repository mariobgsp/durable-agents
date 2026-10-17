# UI review — 2026-10-17 (identity + model picker round)

Screenshots: 16 files in this directory, at **1440×900** and **1024×700**, produced by `npm run shots`.

Scope of this round: agent and group **identity** (colour + emoji face), the **spine** that ties a thread
row back to its agent's avatar, the **per-agent model picker**, the **Group Settings** dialog, and the
first pass of the **design system** (Geist, OLED base, hairlines, motion tokens) plus **responsive**
behaviour.

## Verdict

The round's goals are met and visible in the screenshots. Build and tests are green:

- `npm run check` — tsc + svelte-check **0 errors** + `lint:lang` clean
- `npm run build` — **58.07 kB** JS + **5.35 kB** CSS gzip (budget: 100 kB)
- `npm run e2e` — **3/3 PASS** (`identity`, `models`, `sessions`)

## What reads well

| Screen | Observation |
| --- | --- |
| `01-home` | Section headers carry the agent's avatar; each thread row is a dot on the spine with **no** avatar of its own — the requested placement. |
| `01-home` | `No agent` and `Groups` sections are visually distinct from agent sections; group rows show **stacked** member avatars because they have no emoji yet. |
| `05-agent-editor` | Identity block previews live (`AG` · `AG · #e0a35c`); 12 desaturated swatches, hex field, Shuffle, and the emoji grid are all reachable without scrolling past the model block. |
| `05-agent-editor` | The model picker shows the real capability line: `can see images · context 1000000 · cost 0.15/0.6 per Mtok · reasoning`, with `Test model` beside it. |
| `07-group-chat` | Group bubbles use each speaker's own colour and face, so a room reads as several people rather than one voice. |

## Findings

### F1 — `Thread__meta` truncates in narrow groups (cosmetic, open)
At 1024 px a group row shows `3 · Nyahut` next to a title that is already ellipsised, so the mode is the
first thing to be clipped. Acceptable, but the mode could move to the `title` attribute.

### F2 — Group rows have no emoji by default (by design, open)
Groups fall back to stacked member avatars, which is the intended fallback. The **Group Settings** dialog
now lets a group pick its own face; no screenshot yet exercises the emoji branch, because the existing
`data/` groups predate the field. Worth one screenshot after a group is given a face.

### F3 — Colour swatches are deliberately muted (by design)
Swatches render through `color-mix(… 42%)` so the picker itself does not shout. The avatar is where the
colour reaches full strength. Left as is.

### F4 — 2 svelte-check warnings (open, low)
Both are a11y warnings on the dialog overlay's click handler in `Dialog.svelte`. Not errors; the overlay
is a presentation element with a keyboard-reachable close path.

### F5 — Mobile drawer not yet screenshotted (open)
The off-canvas drawer, scrim and sticky composer below 720 px are implemented in `app.css`, but `shots.mjs`
only captures 1440 and 1024. A 390 px capture is the next addition so the drawer is covered by the gate.

## Note on the type-checking tooling

`pi-lens` reports six errors claiming `AgentRecord.enabled`, `AgentRecord.color`, `AgentRecord.avatar`,
`Session.deletedAt` and `RoomConfig.color/avatar` do not exist. **These are false positives.** They were
disproved three ways in the same session:

1. `grep` on disk shows the declarations (`types.ts:31 deletedAt?`, `:56 enabled?`, and the `color`/`avatar`
   pair on both `AgentRecord` and `RoomConfig`).
2. `svelte-check`, reading the **same tsconfig** the lens reads, reports **0 errors** on exactly those files.
3. A compile-time probe imported all three types and touched every disputed property —
   `npx tsc -p packages/web/tsconfig.json --noEmit` exited **0 with no output**. A missing property would
   have failed right there.

The lens is holding a pre-Phase-6 snapshot of `types.ts` and does not invalidate it when the file changes
(content edits, `touch`, clearing `node_modules/.cache` and `node_modules/.vite`, and fresh LSP probes were
all tried). It re-reads files it has its own findings for, which is why its `app.css` findings cleared on
write while `types.ts` stayed frozen. This needs the lens's TypeScript server restarted; no change to the
repository can fix it, and no code was altered to appease it.

---

## Round: live "replying" indicator

Screenshots regenerated with `npm run shots` (16 files, 1440×900 + 1024×700).

### What was built

- **Server activity registry** (`packages/server/src/activity.ts`): an in-memory `Map<sessionId, {epoch, startedAt}>`
  with `markActive` / `markIdle` / `activeIds` / `subscribe`. Marked in `sendMessage` (after `submit`),
  in `postToRoom` (the whole multi-agent flow runs inside that call), and cleared by `abortSession` /
  `abortRoom` plus a 10-minute watchdog. Clearing is epoch-guarded, so a waiter that resolves late cannot
  wipe the mark of a generation that started in between.
- **End of generation comes from pi-durable itself**: `ConversationHandle.waitForIdle()` — no polling and no
  transcript scanning.
- **Boot recovery**: after `resume()`, every session is probed with a 300 ms grace window, so work
  rescheduled from before the restart is marked active and an idle session never is.
- **`GET /api/activity`** for assertions, and a **presence WebSocket** (`/api/ws/presence`) carrying
  whole-list snapshots. Snapshots rather than start/stop deltas: no client-side diffing, and a dropped
  frame cannot leave a row spinning.
- **`TypingDots.svelte`**: three dots, opacity + transform only, staggered `animation-delay`, `role="status"`
  with a visually-hidden label. Reduced motion leaves them statically visible.
- **Sidebar**: dots on a thread's or group's row when it is replying **and is not the open thread** — a
  fixed 11 px slot, so no row ever shifts.
- **Chat**: a dots bubble while waiting for the first token, dots beside the live bubble, and the old
  `"name is typing…"` line now carries dots plus the member names.

### Verified

| Check | Result |
| --- | --- |
| `npm run check` | svelte-check **0 errors**, tsc clean, `lint:lang` clean |
| `npm run build` | 58.69 kB JS + 5.54 kB CSS gzip (budget 100 kB) |
| `npm run e2e` | **4 passed, 0 failed** — `activity`, `identity`, `models`, `sessions` |
| built output | `typing-dot` / `typing-dots` present in the emitted CSS and JS |

The new `activity` scenario asserts: an idle thread is not active; a thread is active immediately after
`POST /messages` while the answer streams; it clears once the assistant entry lands; abort clears it
immediately; a group stays active across the whole `postToRoom` flow; and an idle thread is still not
active **after a restart** — which is what proves the boot scan does not mistake idle for running.

### Open

- **The dots are not yet visible in a screenshot.** `shots.mjs` captures static states, so no generation is
  in flight when the shutter clicks. Extending it to hold a generation open (a long faux answer) is the one
  remaining piece of this round, and it is what would make the indicator covered by the visual gate rather
  than only by the API assertions and the component compiling.
- Advisory hints surfaced by a full workspace scan (non-null assertions in `lib/identity.ts`, unused imports
  in `rooms.ts`, nested ternaries) are pre-existing and hint-level; `npm run check` is green.

### Tooling note — the pi-lens false positives are resolved

Earlier rounds reported `AgentRecord.enabled`, `Session.deletedAt`, `RoomConfig.color/avatar` and
`AgentRecord.color/avatar` as missing. Those were **false**, and the cause was a stale pi-lens cache, not the
code: `~/.pi-lens/projects/<slug>/cache/project-snapshot.json.gz` recorded `packages/web/src/types.ts` at
**size 1486** while the real file was **2543**. Deleting that cache entry and forcing a full workspace scan
made the findings disappear entirely — the lens now reports only its normal advisory hints.

The lesson for this repo: when the lens contradicts `svelte-check`, `tsc` and `vite build` at once, clear
`~/.pi-lens/projects/*/cache/project-snapshot.json.gz` and re-scan rather than touching the code.

---

## Round: responsive proof + design consolidation

### Why "responsive was gone"

It was never broken — it was **never photographed**. `shots.mjs` had only `1440x900` and `1024x700`, so the
mobile drawer had never been captured, and at 1024px the only change was the sidebar going 260px → 216px.
The CSS (`app.css` responsive block) and the drawer markup (`App.svelte`) were correct the whole time.

`shots.mjs` now captures **five** viewports — 1440x900, 1280x800, 1024x700, **768x900**, **390x844** —
which is 40 files. At 390x844 the ☰ appears, the sidebar is correctly off-canvas, content is full-width and
there is no horizontal overflow.

### Design consolidation

The tokens existed but most rules ignored them; earlier append-only edits had layered new rules on top of
old ones instead of replacing them.

| Fixed | Before | After |
| --- | --- | --- |
| Radius scale | 15× `border-radius: 8px`, 6× `var(--radius)` | all `var(--r-sm)` — **0 left** |
| Mono stack | `ui-monospace, "JetBrains Mono"` in 2 places | `var(--font-mono)` (Geist Mono) — **0 left** |
| Duplicate rules | `.modes`/`.mode`/`.mode--active` defined twice, so the old `border` rendered *under* the new inset ring | old block deleted; one definition |
| Empty state | floating text on a black field | double-bezel: outer shell + inner core, eyebrow tag, 28px display heading, pill CTA |
| Bubbles | hard `1px solid` box | hairline ring + top highlight at `--r-md`; your own messages tinted by the accent |
| Panels / cards | hard `1px solid` box, 10px radius | outer shell ring + hairline + inner highlight, `--r-lg`, with a staggered entry animation |
| Primary CTA | flat rounded rectangle | pill with the trailing glyph in its own circle (button-in-button) |
| Chat header | overflowed on a phone | wraps tidily; duplicated `.chat__title` merged |

### Bugs found and fixed along the way

- `App.svelte` — the bezel edit left **three open `div`s with one close**; `svelte-check` caught it and the
  build failed until they were balanced.
- `GroupSettings.svelte` — called `identityOfMember(member, [])` with an **empty** agents array, so member
  chips never picked up the real agent colour or emoji. Now passes `store.agents`.
- `rooms.ts` — two unused imports (`toolsByName`, `renderInstructions`).
- `shots-replying.mjs` — imported `existsSync` from `node:fs/promises`.

### The replying indicator is now covered by the gate

`npm run shots:replying` boots a throwaway E2E-mode server (faux provider, no credentials, no network),
creates two threads, holds one generating with a long answer, and photographs three states:
`09-replying-sidebar-1440x900.png` (dots on the *other* thread's sidebar row),
`09-replying-chat-1440x900.png` and `09-replying-chat-390x844.png` (dots inside the chat).
This could not live in `shots.mjs`, which runs against the dev server where a generation cannot be held open.

### Verified

| Check | Result |
| --- | --- |
| `npm run check` | svelte-check **0 errors**, tsc clean, `lint:lang` clean |
| `npm run build` | 58.77 kB JS + 5.73 kB CSS gzip (budget 100 kB) |
| `npm run e2e` | **4 passed, 0 failed** |
| `npm run shots` | 40 files, 5 viewports |
| `npm run shots:replying` | 3 files |

### Still open

- The double-bezel on `.panel`/`.card` is a single-element read (outer ring + hairline + inner highlight)
  rather than true nesting. Real nesting is used on the hero surfaces (empty state, identity card) where the
  depth actually shows; nesting every list card would add markup for no visible gain.
- `docs/ui-review/checklist.md` item 9 asks for tap targets ≥40 px; the current CSS uses 40 px on coarse
  pointers, not the ≥44 px Apple figure.
