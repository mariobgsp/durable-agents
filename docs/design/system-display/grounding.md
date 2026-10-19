# Grounding — System panel (Update / Restart) and the display simplification

This is the shared Phase A artifact for the architect arena. Read it before sketching. It is the contract
every candidate answers to.

## The request

Two changes to dura-agents, in one deliverable:

1. **A display enhancement** — make the app's UI *simpler, more direct, minimalist*. Fewer labels, less
   chrome, one obvious action per screen. This is a real design change, not a colour tweak.
2. **An in-app System panel** with **Update** and **Restart**:
   - **Update** updates the tools automatically. If the process is *not* sandboxed (repo writable), it runs
     the real package update and UI rebuild. If it *is* sandboxed (the hardened systemd unit mounts the repo
     read-only), it cannot install packages: it must fall back to an in-process reload and say why.
   - **Restart** restarts the app. Under a supervisor (systemd `Restart=always`, or `npm run dev`) the server
     comes back; without one it stops, and the UI must say so rather than pretend.

Fixed by the human before sketching (do not re-litigate):

- The actions live in an **in-app System panel** (a new view), not a shell script or an existing screen.
- Update = **package update when sandboxed off, in-process reload when sandboxed on**.
- The display change is **app-wide**, alongside the panel.

## What the existing app is

- Local, single-user web app. Svelte 5 (runes) + Vite in `packages/web`; Fastify + `@fastify/websocket` +
  `@fastify/static` in `packages/server`. One SQLite file in `data/` holds every thread, entry and tool call.
- Server entry `packages/server/src/index.ts` (603 lines): resolves the token, opens the harness, registers
  all `/api` routes in one plugin with `api.addHook("onRequest", makeAuthHook(token))`, then serves the built
  UI from `packages/web/dist` when it exists, then `app.listen({ host, port })`. On SIGINT/SIGTERM it calls
  `app.close()` and exits. It prints `PI_SERVER_READY {port, token}` — the E2E harness reads that line.
- Auth: every `/api` route requires `X-PI-Token` (or `?token=` for WS and `<img>`). `packages/server/src/auth.ts`.
- Paths: `packages/server/src/paths.ts` — `dataDir`, `dbPath`, `serverPort`, `host`, `configuredToken`,
  `piAuthPath`. `dataDir` is derived from the file location, so dev and prod agree.
- Harness: `packages/server/src/harness.ts`. `openHarness()` builds one `Registry`, installs the extensions
  (`createCodingTools`, memory, permissions, question, search, codemode + codemode-loader), opens SQLite, and
  calls `instance.resume()`. `registry.install(ext)` **replaces by name** and publishes at once; `uninstall`
  removes. `toolsByName()` filters `registry.snapshot().tools()` by an agent's tool list.
- Agents: `packages/server/src/agents.ts` — `listAgents()`, `readAgent(id)`, `writeAgent(input)`,
  `setAgentEnabled`. `packages/server/src/sessions.ts` — `rebindAgent(agentId)` re-reads one agent's files and
  `configure()`s every live thread of it, returning how many threads took the change.
- Rooms, storage, usage: `rooms.ts`, `storage.ts` (`storageReport()`, `cleanupStorage()`), `usage.ts`
  (`usageReport()`). These are the closest precedent for a new read-only status module.

### Web side

- `packages/web/src/router.svelte.ts` — `Route` is a hand-written union (`home | session | groups | agents |
  providers | usage | agent`), parsed from `location.hash`; `go(hash)` navigates. Add a variant here.
- `App.svelte` — the shell: off-canvas drawer, `<aside class="sidebar">` with brand, `<Sidebar/>`, and a
  footer of three tab buttons (`Agents`, `Models`, `Usage`) plus a connection dot; `<main>` switches on
  `route.name`. The new view is one more branch and one more footer tab.
- `packages/web/src/api.ts` — the one HTTP client (`req<T>`), plus `attachmentUrl`. `token` comes from
  `window.__PI_BOOT__`. `ApiError` carries `status` and `code`. Add methods here; do not open a second client.
- `packages/web/src/state.svelte.ts` — the runes `store` (sessions, agents, entries, pending, activity,
  connection, modelGroups, …) and the actions on it (`loadAgents`, `loadSessions`, `send`, `abort`, …).
- `packages/web/src/views/Usage.svelte` — the precedent for a panel that calls a route `api.ts` does not
  wrap: a local `storageCall()` using `fetch` + `x-pi-token`. `#/usage` owns the Usage *and* Storage panels.
- Components: `Sidebar.svelte` (sections, thread rows, `⋯` menus, Dialogs), `Chat.svelte` (header chips, mode
  switch, timeline, per-role labels, activity indicators, Composer, ContextBar), `AgentEditor.svelte` (two
  markdown textareas + a right column of identity/model/thinking/permissions controls), `Dialog.svelte`,
  `ActivityIndicator.svelte`, `ActivityStrip.svelte`, `ToolCallRow.svelte`, `Composer.svelte`.
- Styling: one stylesheet, `packages/web/src/app.css` (2628 lines). Tokens at `:root`: `--bg #000`,
  `--panel #0a0b0d`, `--panel-2 #131519`, `--line`, `--text`, `--muted`, `--accent #e0a35c`, `--paper`,
  `--ink`, `--danger`, `--ok`; radii `--r-lg 20 / --r-md 14 / --r-sm 10`; `--ease`, `--t 180ms`,
  `--t-slow`, `--t-status 1600ms`; `--font-sans` Geist, `--font-mono` Geist Mono. Classes in use:
  `.app`, `.sidebar`, `.brand`, `.btn`/`.btn--primary`/`.btn--ghost`/`.btn--danger`/`.btn--block`,
  `.chip`, `.card`, `.page`, `.page__head`, `.page__title`, `.field`, `.empty`, `.error`, `.ok`, `.notice`,
  `.thread`, `.section`, `.menu`, `.icon-btn`, `.timeline`, `.msg`, `.bezel`.

### Deploy and the sandbox

`deploy/dura-agents.service` is a systemd **user** unit. It sets `PI_SANDBOXED=1`, `ProtectSystem=strict`,
`ProtectHome=read-only`, `ReadWritePaths=<repo>/data`, `PrivateTmp=yes`, `Restart=always`, `RestartSec=3`.
So under the unit the repo (including `node_modules`) is **read-only** and the npm cache in `$HOME` is
read-only: a package install cannot work there. `PI_SANDBOXED=1` is already reported by `GET /api/health`
as `sandboxed`. Nothing else in the app reports process facts today.

`npm run dev` (`scripts/dev.mjs`) spawns the server with `node --watch` and Vite as two children, and on
either child's exit calls `shutdown()` — killing both. A user service is `systemctl --user restart
dura-agents`.

## Constraints that are binding

From `docs/roadmap.md` "Locked decisions" and `docs/ui-review/checklist.md`:

- **Testing: E2E only, no unit tests.** Deterministic scenarios use the faux provider and the `PI_E2E` control
  endpoint; `scripts/e2e/run.mjs` boots one throwaway server per scenario via `startServer()` in
  `scripts/e2e/harness.mjs` (`PI_SERVER_PORT=0`, fresh `PI_DATA_DIR`, token). A new scenario is one file in
  `scripts/e2e/scenarios/` with a default `{ name, run(server) }`.
- **Screenshots are required for every UI step**: `npm run shots` (8 routes × 5 viewports) writes
  `docs/ui-review/<date>/` + manifests + `findings.md`; at most 2 polish rounds. The routes are hard-coded in
  `packages/web/scripts/shots.mjs` — a new view must be added there.
- **Language**: all system text English; `npm run lint:lang` must stay clean.
- **Animation**: state change animates only `opacity`/`transform`, 120–180 ms; live indicators follow the five
  rules in the roadmap (indeterminate, no percentages, at most one per row, only while the server says so,
  static under `prefers-reduced-motion`). Nothing else moves.
- **Consistency**: radii from the scale; separation is a hairline ring or inset highlight, never a 1 px solid
  grey border; colours from `app.css` variables; `var(--font-mono)` for code.
- **Security**: bind `127.0.0.1`, token on every route, `Host` allowlist, no permissive CORS.
- `npm run check` = `tsc` (server) + `svelte-check` (web) + `lint:lang`. `npm run build` has a 100 kB gzip JS
  budget (current entry ≈ 69.6 kB gzip). `npm run e2e` is currently 13/13.
- The roadmap's own note: the `pi-durable` package is pinned in prose to 1.3.0, but the manifest is `^1.3.0`.

## Hard questions the design must answer

- **What is a "tool" here?** The registry's extensions are the tools. Their *code* is what a package update
  changes; a running process cannot hot-swap it, so "update" is two different operations depending on the
  sandbox. The design must state plainly what each mode actually achieves.
- **How is Update reported?** A package update + `npm run build` takes tens of seconds to minutes and prints
  a lot. The panel must show honest progress and the real result (versions before/after, exit code, the tail of
  the output), and must survive the user navigating away.
- **What does Restart do under each supervisor?** systemd restarts an exited process; `npm run dev` kills
  everything on server exit (`dev.mjs` must be taught otherwise, e.g. a distinct exit code it restarts);
  bare `npm start` just stops. The UI must distinguish "back up" from "stopped".
- **Where does the state live?** One writer. A background child process, the HTTP routes and the UI all need
  a view of the same operation without two copies of the truth.
- **What exactly gets simplified?** Name the concrete removals, not adjectives. The screenshot rubric judges
  hierarchy, spacing, contrast, empty/error states, language and the 390 px tier.

## Two directions for the candidates (one each)

The arena needs structurally different shapes, not two flavours of one.

- **Candidate 1 — the process-facts module.** Design a `system.ts` that owns every process fact and one
  request/response operation model: a status snapshot (`GET /api/system`) plus actions that answer with the
  outcome (`POST /api/system/update`, `POST /api/system/restart`). Update is a bounded job the route awaits or
  reports; the UI polls while it runs. The display pass is derived from "one obvious action per screen".
- **Candidate 2 — the operations model.** Treat system actions as first-class asynchronous operations with
  identity, state and a log, and stream them (WS or SSE) rather than poll: an operation registry in the
  server, `POST /api/system/operations`, `GET /api/system` for the current/last operation and its log tail.
  The display pass is derived from "show the state, hide the controls": progressive disclosure in the sidebar,
  chat and editor.

Each candidate must produce: caller's usage first, then a type sketch (types + signatures + module map), the
UI shape, a rationale shaped per `references/rationale-template.md`, and the concrete list of display
simplifications.

## Deliverable

`docs/design/system-display/candidate-<n>/DESIGN.md` — one file, the design package. Keep it under ~400
lines. It is a sketch: `not implemented` bodies, `// TODO` pseudocode, real types and signatures, and prose.
No production code changes outside your candidate directory.
