# System panel and the display pass — candidate 1: the process-facts module

## Problem

The app can change agents, models and threads, but it cannot say which `pi-durable` is loaded, whether the
systemd boundary is on, or whether a supervisor will bring it back. One screen must answer that and offer
Update and Restart honestly under both deployments. The shape is non-obvious because "tool" means the
extensions registered in `harness.ts`: their code arrives through `node_modules`, and a running Node process
cannot hot-swap an ES module. So Update is two operations — package install plus `npm run build` when the repo
is writable, in-process reload when `ProtectSystem=strict` has made it read-only (the unit sets
`PI_SANDBOXED=1`, already reported by `/api/health`). Restart is three outcomes: systemd `Restart=always`
returns the unit in 3 s, `scripts/dev.mjs` currently kills everything on server exit, bare `npm start` stops.
Everything is token-authenticated on loopback; the UI must survive navigating away mid-update; tests are
E2E-only through `scripts/e2e/harness.mjs`; screenshots are a gate with routes hard-coded in
`packages/web/scripts/shots.mjs`; the bundle has a 100 kB gzip budget. One owner for every process fact: `system.ts`.

## Usage (caller's view)

```sh
curl -s -H "x-pi-token: $(cat data/token)" http://127.0.0.1:8787/api/system
# → { "runtime": { "pid": 4211, "sandbox": "on", "supervisor": "systemd", "port": 8787,
#     "versions": { "piDurable": "1.3.0", "piCodemode": "1.3.0", "node": "v22.19.0" }, … },
#     "update": null }   # null = idle; otherwise the running or last job

curl -s -X POST -H "content-type: application/json" -H "x-pi-token: $(cat data/token)" \
     -d '{}' http://127.0.0.1:8787/api/system/update      # starts or joins; answers with the running job
curl -s -H "x-pi-token: $(cat data/token)" http://127.0.0.1:8787/api/system   # poll until terminal

curl -s -X POST -H "content-type: application/json" -H "x-pi-token: $(cat data/token)" \
     -d '{}' http://127.0.0.1:8787/api/system/restart
# → { "supervisor": "systemd", "effect": "restarting", "exitCode": 0, "expectBackMs": 5000, "detail": "systemd restarts the unit after RestartSec=3." }
```

### Call site 1 — the browser store polls one snapshot

```ts
// packages/web/src/state.svelte.ts
import { api } from "./api.ts";

export async function loadSystem(): Promise<void> {
  try {
    store.system = await api.system();          // SystemSnapshot
    store.systemError = null;
  } catch (error) {
    // During a restart the connection is expected to fail; that is not an error to show.
    if (store.restart?.state !== "waiting") store.systemError = String(error);
  }
}

export async function startUpdate(): Promise<void> {
  store.system = await api.startUpdate();       // same shape as GET, with update.phase === "running"
  pollSystem();                                 // 1 s until update.phase !== "running"
}
```

### Call site 2 — the view asks for one action and renders the state it gets back

```svelte
<!-- packages/web/src/views/System.svelte -->
<button class="btn btn--primary" disabled={state === "running"} onclick={startUpdate}>
  {state === "running" ? "Updating…" : "Update"}
</button>
<button class="btn" disabled={state === "running"} onclick={requestRestart}>Restart</button>

{#if job}
  <section class="job" data-state={state} data-testid="system-job">
    <p aria-live="polite">{job.summary}</p>
    {#if job.phase !== "running"}
      <p class="job__versions">{job.before.piDurable} → {job.after?.piDurable ?? "unknown"} ·
        {job.signal ? "killed by " + job.signal : job.exitCode === null ? "in-process" : "exit " + job.exitCode}</p>
      <pre class="job__output">{job.output.join("\n")}</pre>
    {/if}
  </section>
{/if}
```

### Call site 3 — the E2E scenario drives it like a client, not like a unit test

```js
// scripts/e2e/scenarios/system.mjs (server booted with PI_SANDBOXED=1)
const before = await server.api("/api/system");                              // 200, update: null
await server.api("/api/system/update", { method: "POST", body: "{}" });      // reload mode
const done = await waitFor(async () => {
  const { body } = await server.api("/api/system");
  return body.update?.phase === "done" ? body.update : null;
});
assert.equal(done.mode, "reload");
assert.equal(done.exitCode, null);
assert.equal(done.after.piDurable, before.body.runtime.versions.piDurable);
```

## Shape

### Data structures first

```ts
// packages/server/src/system.ts — every process fact in this app lives here.
export type Sandbox = "off" | "on";              // names the mode; a boolean invites `!sandboxed`
export type Supervisor = "systemd" | "dev" | "none";

export type Versions = {
  piDurable: string; piCodemode: string; node: string;  // installed at boot; node = process.version
};

export type RuntimeFacts = {
  pid: number; startedAt: string; sandbox: Sandbox; supervisor: Supervisor;
  versions: Versions;   // what is running, not what is on disk
  port: number; dataDir: string;
};

export type UpdateMode = "packages" | "reload";  // chosen by the sandbox, never by the caller
export type UpdateStep = "install" | "build" | "reload";

type UpdateJobBase = {
  id: string;           // `${pid}-${seq}`: stable while it runs, different on the next run
  mode: UpdateMode; startedAt: string; before: Versions;
  output: string[];     // bounded tail: last 40 lines, each at most 500 chars
  summary: string;      // the one sentence the panel shows, written by the server
};

export type UpdateJob = UpdateJobBase &
  (
    | { phase: "running"; step: UpdateStep }
    | { phase: "done"; finishedAt: string; after: Versions; exitCode: number | null; signal?: string }
    | { phase: "failed"; reason: string; finishedAt: string; after?: Versions; exitCode: number | null; signal?: string }
  );

export type SystemSnapshot = { runtime: RuntimeFacts; update: UpdateJob | null }; // null = idle

/** `expectBackMs` exists only where a supervisor exists; "stopping" cannot promise a return. */
export type RestartPlan =
  | { supervisor: "systemd" | "dev"; effect: "restarting"; exitCode: number; expectBackMs: number; detail: string }
  | { supervisor: "none"; effect: "stopping"; exitCode: number; detail: string };

/** data/system.json — only the last outcome, only read at boot. */
type PersistedSystem = { lastUpdate: UpdateJob | null };
```

### Signatures

```ts
// packages/server/src/system.ts
export async function openSystem(): Promise<void> { throw new Error("not implemented"); }
// ^ reads disk versions + persisted outcome; a persisted "running" becomes "failed"
export function runtimeFacts(): RuntimeFacts { throw new Error("not implemented"); }
/** The one read: runtime + current/last job. Cheap enough to poll once a second. */
export async function systemSnapshot(): Promise<SystemSnapshot> { throw new Error("not implemented"); }
/** Start the update, or join the one already running. Never two jobs; no body, no options. */
export async function startUpdate(): Promise<SystemSnapshot> { throw new Error("not implemented"); }
/** What a restart would achieve here. The shell performs the exit; this module owns the facts. */
export function restartPlan(): RestartPlan { throw new Error("not implemented"); }

// packages/server/src/harness.ts — one new export, used only by system.ts.
/** Re-install the extension set from the modules already imported; return the extension names. */
export function reloadTools(): string[] { throw new Error("not implemented"); }
```

```ts
// packages/server/src/index.ts — the shell stays thin.
api.get("/system", async () => systemSnapshot());
api.post("/system/update", async () => startUpdate());      // POSTs carry {} because req() sets JSON
api.post("/system/restart", async (_request, reply) => {
  const plan = restartPlan();
  // Answer before leaving, or the browser sees a dropped connection instead of a plan.
  reply.raw.once("finish", () => void app.close().then(() => process.exit(plan.exitCode)));
  return plan;
});
// /health keeps its shape but stops computing its own sandbox: runtimeFacts().sandbox === "on"
```

### How an update runs

```ts
type ChildResult = { code: number | null; signal: string | null; timedOut: boolean };

/** One npm step in the repo, streaming lines into the bounded tail. Minimal child env: no PI_API_TOKEN
 *  (npm has no business holding it), no NODE_OPTIONS (the unit's 768 MB heap is not Vite's build budget). */
async function runStep(job: UpdateJob, step: UpdateStep, args: string[]): Promise<ChildResult> {
  // TODO spawn("npm", args, { cwd: repoRoot, env: { PATH, HOME, LANG } })
  // TODO stdout+stderr: split lines, append, shift past 40, slice each line to 500 chars
  // TODO 15 min deadline for the whole job: SIGTERM, 2 s, SIGKILL, timedOut = true
  throw new Error("not implemented");
}

async function runUpdate(job: UpdateJob): Promise<void> {
  if (job.mode === "reload") {
    const names = reloadTools();                              // extension objects from loaded code
    let threads = 0;
    for (const agent of await listAgents()) threads += await rebindAgent(agent.id);  // re-read AGENT/SOUL
    return finish(job, "done", { after: job.before, exitCode: null, summary:
      `Reloaded ${names.length} extensions and rebound ${threads} threads. Versions are unchanged: the repo ` +
      "is read-only under the systemd unit, so packages cannot be installed." });
  }
  const install = await runStep(job, "install", ["update", "--save", "--no-audit", "--no-fund"]);
  if (install.timedOut || install.code !== 0) return fail(job, install, "the package update did not finish");
  const build = await runStep(job, "build", ["run", "build"]);
  if (build.timedOut || build.code !== 0) return fail(job, build, "packages updated, but the UI build failed");
  const after = await readVersions();
  finish(job, "done", { after, exitCode: build.code, summary:
    after.piDurable === job.before.piDurable
      ? "Already on the newest version in range; the UI was rebuilt. Restart if the bundle changed."
      : `pi-durable ${job.before.piDurable} → ${after.piDurable}. Restart to load the new code — this ` +
        "process still runs the old one." });
}
```

### Single writer, and the crash case

`system.ts` owns one module-level `job` and one `running` promise; the route never touches either. Starting an
update while one runs returns the running snapshot with the same `id`, so a second click is the same
operation, not a second npm. The job is persisted only at a terminal phase (`writeFile(tmp)` + `rename` into
`data/system.json`, the only writable path under the unit). At boot `openSystem()` reads it and turns a
persisted `phase: "running"` into `failed` ("the process restarted before this update finished") — the only
writer is gone, and a job cannot outlive it.

### What each action actually achieves

| Where | Update | Restart |
| --- | --- | --- |
| Sandbox **off** (repo + npm cache writable) | `npm update --save`, then `npm run build`. New package code and bundle land on disk. The **running process keeps the old modules**; the summary says so and the panel's primary action becomes Restart. Before/after are real reads of `node_modules`. | `restartPlan()` reports `none` under bare `npm start`: the response says `stopping`, then the process exits and does not return. Under `npm run dev`, `dev.mjs` sees exit code 75 and respawns the server with the same token; Vite stays. |
| Sandbox **on** (systemd, repo read-only) | No install is attempted. `reloadTools()` re-installs the extension set from code already in memory and every agent is rebound, so edited `AGENT.md`/`SOUL.md` and tool lists take effect. **Versions do not change.** The summary names the read-only repo. | systemd detected via `INVOCATION_ID`; `Restart=always` + `RestartSec=3` return the unit; the plan promises ~5 s. `data/token` is reused, so the page's existing token still authorises its poll. |

Restart depends on the supervisor, not the sandbox: systemd, dev and none map to those three outcomes whatever `PI_SANDBOXED` says.

### Module map and data flow

```text
server:  paths.ts +repoRoot · system.ts NEW · harness.ts +reloadTools() · index.ts openSystem() + 3 routes
web:     types.ts +mirrors · api.ts +3 methods · state.svelte.ts +store.system/restart +4 actions
         router.svelte.ts +{name:"system"} · App.svelte +branch · views/System.svelte NEW
scripts: dev.mjs +respawn on exit 75 · e2e/scenarios/system.mjs NEW · web/scripts/shots.mjs +09-system

route → system.ts ─┬─ runtimeFacts(): one value computed at module load
                   ├─ job: mutated by exactly one async runner
                   └─ data/system.json: read at boot, written at terminal
GET /api/system → SystemSnapshot;  POST /update → join-or-start → snapshot → poll;
POST /restart → RestartPlan → response flushed → process.exit(code)
# dominant read: the whole snapshot once a second — one small object, no map, index or cache
```

### Invariants encoded in types

- `UpdateMode` is never a parameter: nobody can ask for `packages` while sandboxed, so the combination has no spelling.
- `RestartPlan` has no `expectBackMs` on the `none` branch; the UI cannot promise a comeback that does not exist.
- `runtime.versions` (executing) versus `job.after` (on disk) forces every version label to choose a side.
- `exitCode: number | null` with `null` = in-process keeps a reload from looking like a successful command.
- `update: null` means idle; absence is not a sentinel string.

**Interface depth.** Public surface: 4 functions + 6 types. Hidden: supervisor detection, mode selection, version discovery,
spawning, env sanitising, line bounding, timeout/kill escalation, join semantics, crash normalisation, atomic
persistence, and the user-facing summary. Each route is one line; none parses a body or knows what npm is.
`per boundary-discipline`, validation lives only at the two edges (process env, `data/system.json`); inside,
types are trusted. Deep by construction: implementation ~10× the interface.

## The System panel UI

Route `#/system`, view `packages/web/src/views/System.svelte`.

```svelte
<section class="page" data-testid="system">
  <div class="page__head">
    <h1 class="page__title">System</h1>
    {#if runtime}<span class="hint">pid {runtime.pid} · up {uptime} · {sandboxWord}</span>{/if}
  </div>
  {#if store.systemError}<p class="error" role="alert">{store.systemError}</p>{/if}
  {#if snapshot}
    <dl class="facts" data-testid="system-facts">
      <div class="facts__row"><dt>Versions</dt><dd>pi-durable {runtime.versions.piDurable} · pi-codemode {runtime.versions.piCodemode} · node {runtime.versions.node}</dd></div>
      <div class="facts__row"><dt>Supervisor</dt><dd>{supervisorWord}</dd></div>
      <div class="facts__row"><dt>Sandbox</dt><dd>{sandboxWord} — {sandboxNote}</dd></div>
      <div class="facts__row"><dt>Connection</dt><dd>{store.connection === "open" ? "connected" : "reconnecting…"}</dd></div>
    </dl>

    <div class="row">
      <button class="btn btn--primary" disabled={state === "running"} onclick={startUpdate} data-testid="system-update">
        {state === "running" ? "Updating…" : "Update"}
      </button>
      <button class="btn" disabled={state === "running"} onclick={requestRestart} data-testid="system-restart">Restart</button>
    </div>
    {#if state !== "idle"}
      <section class="job" data-state={state} data-testid="system-job">
        <p class="job__summary" aria-live="polite">{summary}</p>
      </section>
    {/if}
  {/if}
</section>
```

One derived state, precedence top to bottom:

| `state` | When | Drawn |
| --- | --- | --- |
| `restarting` | tracker `waiting` | "Restarting — waiting for the process to answer." Static text + elapsed count, **no sweep**: the server cannot report activity while down (locked rule 4). |
| `stopped` | plan `stopping`, or `missed` after 15 s | "Stopped. {detail}" with the exact command (`npm start`) or "the unit did not come back; check `systemctl --user status dura-agents`". No button pretends it can help. |
| `running` | `update.phase === "running"` | Step word (`Installing packages…` / `Building the UI…` / `Reloading tools…`), one `ActivityIndicator`, last three output lines. Never a percentage. |
| `failed` | `update.phase === "failed"` | `reason`, `exit N` / `signal`, output tail; primary button = `Update` (try again). |
| `done` | job done, or restart `returned` | `before → after`, exit code or "in-process", output tail; `Restart` is primary when `after.piDurable !== runtime.versions.piDurable`, else `Update`. |
| `idle` | no job, no restart | Facts and two buttons. |

Honest reporting: `job.before` is always the running versions; `job.after` is the disk read after install (`unknown` when the install never finished); `exitCode === null` prints as `in-process` only when no child ran, and a signalled child prints its signal; the tail is the last 40 lines the child wrote in `<pre class="job__output">` (mono, max-height 240 px, scrollable); the server's `summary` is the only prose. `aria-live="polite"` on the summary means one announcement per state change, not one per poll.

Store additions (`state.svelte.ts`):

```ts
type RestartTracker =
  | { state: "waiting"; plan: RestartPlan; previousPid: number; since: number }
  | { state: "stopping"; plan: RestartPlan; since: number }   // bare npm start: no poll
  | { state: "returned"; plan: RestartPlan; pid: number; startedAt: string }
  | { state: "missed"; plan: RestartPlan; since: number };

store.system: SystemSnapshot | null;  store.systemError: string | null;
store.restart: RestartTracker | null;
loadSystem(): Promise<void>;  startUpdate(): Promise<void>;
requestRestart(): Promise<void>;  pollSystem(): void;  watchSystem(): () => void;
// watchSystem starts on App mount; 1 s poll (500 ms while restarting); stops when terminal.
```

`api.ts` follows `req<T>` and sends `{}` bodies because `req` sets `content-type: application/json` and
Fastify answers 400 to an empty JSON body:

```ts
system: () => req<SystemSnapshot>("/api/system"),
startUpdate: () => req<SystemSnapshot>("/api/system/update", { method: "POST", body: "{}" }),
requestRestart: () => req<RestartPlan>("/api/system/restart", { method: "POST", body: "{}" }),
```

Polling lives in the store, not the view, so navigating to Chat mid-update keeps it and returning shows the
current state. Restart detection compares `runtime.pid` with the pid recorded before the POST: a new pid means
"returned", even when the supervisor restarts faster than one poll.

## The display simplification pass

One obvious action per screen; everything else is state, not a control.

1. **Sidebar** — Replace the full-width `btn btn--primary btn--block` "New thread" with a `+` icon in `sidebar__head` (keep `data-testid="new-thread"`), because the home view already owns that primary action and a filled button on every screen competes with the screen's own action.
2. **Sidebar** — Replace the always-visible search input with a `⌕` icon that reveals the same `#thread-search` input below the head, because two controls at the top leave neither as the obvious first move.
3. **Sidebar** — Remove `section__meta` (`active · N`) and print only `disabled` when `agent.enabled === false`, because the thread list is the count and "active" is the default.
4. **Sidebar** — Remove the per-row `.marker` dot; keep the 11 px `.thread__slot` for the activity indicator only, because the section avatar already carries identity and a dot per row reads as a status it is not.
5. **Sidebar** — Remove the Groups header `+`, because `#/groups` owns "New group" and this is a second way to start it.
6. **Sidebar** — Replace the `sidebar__foot-note` sentence "Deleted threads are hidden." with just the `Restore last` link, because it explains a state the user just created and costs a permanent footer row.
7. **Chat** — Remove the model chip, because `ContextBar` under the composer already shows the same model as a select.
8. **Chat** — Remove the `@agent` chip, because the avatar and title identify the thread and the sidebar's agent menu is where the agent is edited.
9. **Chat** — Replace the three-button mode switch with one chip showing the current mode that opens `GroupSettings`, because `GroupSettings` already owns that three-way choice (two ways to do one task).
10. **Chat** — Remove the `<p class="typing">` row, because `ActivityStrip`/the phase bubble already reports who is replying and the animation rule allows one indicator per frame.
11. **Chat** — Remove `.msg__who` from user bubbles and show the assistant name only when `firstOfRun(index)`, because avatar, colour and alignment already identify the author.
12. **Chat** — Replace the long composer placeholders with "Write a message…", "Write to the group…", "Steer the reply…", because the keyboard hint and `@name` tutorial are discoverable and the long form clipped at 390 px.
13. **AgentEditor** — Replace colour swatches + hex input + Shuffle with the swatch grid alone, because three controls edit one value and the identity card already prints the hex.
14. **AgentEditor** — Remove the "or type one" emoji input, because it is a second way to do what the grid does.
15. **AgentEditor** — Replace the three permission radios (and conditional fields) with one `select` of the three tiers plus one sentence; show `blockedTools`/`allowedPaths` only for Custom, because three radios and two warnings occupy half the column for one decision.
16. **AgentEditor** — Remove the `Back` button, because the sidebar (and the ☰ at 390 px) is the one navigation.
17. **AgentEditor** — Replace the full-width "Suggest from SOUL.md" button with a small `Suggest` inside the Responsibility field, because it currently reads as a second Save.
18. **App** — Replace the three-tab footer + `foot-status` dot and word with a four-tab grid `Agents · Models · Usage · System`, moving the dot and its `connected`/`reconnecting…` word into the System facts, because process state belongs to the process screen and the footer's job is navigation.
19. **App** — Add the `{#if route.name === "system"}<System/>` branch and `{ name: "system" }` to the router for `#/system`, because the view is one route variant.
20. **app.css** — Remove dead selectors `.list`, `.item*`, `.tabs`, `.section__dot*`, `.marker*`, `.foot-status`; they are unreferenced today or become so with items 4 and 18, and dead rules make the next editor guess which copy wins.
21. **app.css** — Remove the duplicate definitions of `.tab` (~985), `.thread__meta` (~2410), `.typing` (~2423) and the second `.marker` (~1593); consolidate each into one rule so the cascade is readable.
22. **app.css** — Replace `.sidebar__head` block layout and `.sidebar__block` with one flex row (brand, `+`, `⌕`) and the search input below it, using existing tokens and 4/8/12/16/24 spacing.
23. **app.css** — Replace `.sidebar__foot` flex with `display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px`, and set `.tab { padding: 6px 4px; font-size: 12px; }`, so four labels fit the 216 px sidebar at 1024 and the 390 px drawer without overflow.
24. **app.css** — Add `.facts` (`grid-template-columns: 96px minmax(0, 1fr)`, 12 px gap, `dt` muted, `dd` text), `.job` (`background: var(--panel)`, `border-radius: var(--r-md)`, `box-shadow: inset 0 0 0 1px var(--line)`, 16 px padding), `.job__output` (`var(--font-mono)`, 12 px, `max-height: 240px`, `overflow: auto`, `white-space: pre-wrap`, `overflow-wrap: anywhere`), `.job__versions` (`tabular-nums`). No new colours, radii or keyframes; the only motion is the existing `ActivityIndicator` while `data-state="running"`.

Rubric check: `09-system` is added to `shots.mjs` across all 5 viewports; the facts list stacks under 720 px; output wraps instead of overflowing; both buttons stay ≥40 px in one row at 390 px.

## Synthesis decision

Filled by orchestrator.

## Tradeoffs accepted

- We accept 1 s polling instead of streaming, in exchange for no second channel, no operation registry, and a client that reuses `req<T>`; the only consumer is a human watching a 30 s job.
- We accept one job per process and no history beyond the last outcome, in exchange for a single writer and a provable "no two npm processes touch the same `node_modules`".
- We accept that Update does not auto-restart, in exchange for never killing in-flight turns or a bare `npm start` without a click; the primary action becomes Restart when the disk version differs.
- We accept that Update under the unit only reloads tools from loaded code, in exchange for saying the truth instead of failing an operation the sandbox forbids.
- We accept a hand-maintained mirror of `SystemSnapshot` in `web/src/types.ts`, in exchange for the pattern every other wire record follows; `svelte-check` catches drift at use sites, not at the declaration.
- We accept `data/system.json` as a second copy of the last outcome, in exchange for surviving a restart; it is read only at boot and written only at a terminal phase, never a competing writer.
- We accept exit code 75 as a dev-only protocol between `system.ts` and `dev.mjs`, in exchange for a signal that cannot collide with a crash (a crash keeps today's shutdown behaviour).

## Alternatives considered

1. **Operations registry with a WS/SSE stream.** The right shape when several operations run at once or many readers need sub-second progress. Here one operation exists per process and one tab watches it, so streaming adds a frame type, an operation-id lifecycle, reconnection reconciliation and a second store for no action the user can take sooner; it lost on surface size at equal honesty.
2. **Blocking `POST /update` until npm exits.** Smallest client and no job type, but a 30 s–2 min request is fragile behind the Vite proxy and tailscale, a reload loses the result, and "survive navigation" needs a second route anyway.
3. **A separate updater process or CLI owning the install and a status file.** Honest separation and it survives a restart, but it adds a second writer, a lock file and a process that can outlive what it updates; the single-owner rule is worth more.
4. **Shell out to `systemctl --user restart dura-agents` from inside the unit.** Uniform restart, but a hardened unit may not reach the user manager's bus, and the code must also work under bare `npm start`. Self-exit plus a supervisor is the only path that works in all three deployments.

## Open questions and risks

- Should a successful package update auto-restart when a supervisor exists and no turn is in flight? The sketch says no; it is one line in `runUpdate` if the human wants it.
- Is `npm update --save` the right verb? It moves within the caret ranges in `packages/server/package.json` (currently `^1.3.0`); a major release still needs a manifest edit. Do we want a named-version path?
- Does `node --watch` (used by `dev.mjs`) swallow `process.exit(75)` and restart the child itself? If so the server still returns with the same token, but `dev.mjs` never sees 75; verify during implementation.
- `npm run build` under the unit's `NODE_OPTIONS=--max-old-space-size=768` could OOM Vite. The child env strips `NODE_OPTIONS`, but the package path is only reachable outside the sandbox; test on a 4 GB machine.
- `GET /api/system` exposes pid, versions and `dataDir` to any token holder. Same trust as the transcript, but a new class of fact on the wire; confirm it is acceptable over the tailnet.
- The per-thread Full Access chip stays in the chat header because it is a security state, not chrome; if the pass is meant to remove it too, that is a product call.
- E2E covers reload mode, all three restart plans and the `{}`-body contract; the real packages path stays a manual check because it needs the network and writes `node_modules`.

## Next implementation step

Write `packages/server/src/system.ts` (`runtimeFacts`, `openSystem`, `systemSnapshot`, the reload-only
`startUpdate` branch, `restartPlan`), add `repoRoot` to `paths.ts` and the three routes to `index.ts`, and land
`scripts/e2e/scenarios/system.mjs`; the packages path and `System.svelte` follow once the contract is proven.
