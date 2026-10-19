# Candidate 2 — System actions as first-class operations

## Problem

The app has no concept of *itself as a process*: `GET /api/health` reports `sandboxed` and nothing else, so the
user cannot see what version of the tools is running, whether a supervisor will bring the server back, or why
`npm update` is impossible inside the hardened unit. Update and Restart are not one-shot requests: an update
prints for tens of seconds and must stay readable after the user navigates away, and a restart deliberately kills
the process that would be reporting it. Fixed constraints: an in-app System panel; Update = packages when the
repo is writable, an in-process reload when it is not; Restart = back under systemd and `npm run dev`, stopped
under bare `npm start`, with the UI saying which. `@fastify/websocket`, the token hook, `data/` as the only
writable path, E2E-only testing, the screenshot gate, English text and the animation/consistency rules bind.

## Usage (caller's view)

README addition: *System panel — open `#/system` (or the footer status) to see the running version, the
boundary and the supervisor, and to Update or Restart. Both are server-owned operations: close the tab and they
keep going; the panel reads the record the server writes.*

```bash
tok=$(cat data/token)
# What can this process do, and what has it done?
curl -s -H "x-pi-token: $tok" localhost:8787/api/system | jq '.process.capability, .current, .last'
# → {"update":"packages","restart":"supervised"} / null / null
# Start an update. The answer is the operation, not its outcome.
curl -s -H "x-pi-token: $tok" -H 'content-type: application/json' \
  -d '{"kind":"update"}' localhost:8787/api/system/operations | jq '.state'
# → {"name":"running","step":"checking"}
```

```ts
// packages/web/src/state.svelte.ts — the only writes the UI performs. 202: the server owns it from here.
export async function updateSystem(): Promise<void> { await api.startOperation("update"); }
export async function restartSystem(): Promise<void> { await api.startOperation("restart"); }
// packages/web/src/App.svelte — the socket is app-wide: watchSystem() in onMount, unwatchSystem() in onDestroy,
// because the footer shows the step on every route. One socket per tab, like watchActivity().
```

```svelte
<!-- packages/web/src/views/System.svelte — the only place the operation is read. -->
<script lang="ts">
  import { store } from "../state.svelte.ts";
  const shown = $derived(store.system?.current ?? store.system?.last ?? null);
  const phase = $derived(shown?.state.name ?? "idle");
</script>
```

What the caller never sees: npm, child processes, log capping, the persisted record, the restart sentinel, the
exit code, or the difference between a reload and an update beyond the `mode` field.

## Shape

### Data structures

```ts
// packages/server/src/system.ts
export type Supervisor = "systemd" | "dev" | "none";
export type ToolVersions = {
  packages: Record<string, string>;   // "@earendil-works/pi-durable" → "1.3.0", read from node_modules
  commit: string | null;              // `git rev-parse --short HEAD`; null outside a checkout
};
/** What this process can actually do. Derived at boot, never stored: the UI must not offer the impossible. */
export type Capability = {
  update: "packages" | "reload";      // packages = npm + build possible; reload = repo is read-only
  restart: "supervised" | "stops";    // stops = nothing will start the process again
};
export type ProcessFacts = {
  pid: number;
  startedAt: number;
  sandboxed: boolean;                 // PI_SANDBOXED === "1", the same single source /api/health uses
  supervisor: Supervisor;
  capability: Capability;
  /** What this process loaded at boot. Disk may have moved on: the two are reported apart on purpose. */
  versions: ToolVersions;
};
export type OperationKind = "update" | "restart";
/** Observed, never timed: a step starts when the process that performs it starts. */
export type Step = "checking" | "installing" | "building" | "reloading" | "stopping";
export type UpdateOutcome = {
  kind: "update";
  mode: "packages" | "reload";
  before: ToolVersions;
  after: ToolVersions;
  changed: boolean;                   // compared once here, so the panel never re-derives it
};
export type RestartOutcome = {
  kind: "restart";
  supervisor: Supervisor;
  restartedAt: number | null;         // filled by the next boot; null until the process actually came back
  downtimeMs: number | null;
};
/** Terminal names match the panel's states one-to-one. `running` is the only non-terminal state. */
export type OperationState =
  | { name: "running"; step: Step }
  | { name: "done"; outcome: UpdateOutcome | RestartOutcome }
  | { name: "failed"; reason: string; exitCode: number | null }
  | { name: "restarting"; supervisor: Supervisor }
  | { name: "stopped" }
  | { name: "interrupted"; reason: string };
export type LogLine = { seq: number; at: number; kind: "state" | "log"; text: string };
export type Operation = {
  id: string;
  kind: OperationKind;
  state: OperationState;
  startedAt: number;
  endedAt: number | null;
  log: LogLine[];                     // the last LOG_LINES lines, oldest first
  truncated: boolean;                 // earlier lines were dropped, so the panel calls this a tail
};
export type SystemSnapshot = {
  process: ProcessFacts;
  /** The one operation still allowed to transition, or null. At most one: this module is its only writer. */
  current: Operation | null;
  /** The most recent terminal operation — including one left behind by the process before this one. */
  last: Operation | null;
};
export type SystemFrame =
  | { type: "system"; system: SystemSnapshot }                 // whole snapshot: on connect and every transition
  | { type: "log"; operationId: string; from: number; lines: LogLine[] }; // append only when contiguous
```

### Signatures

```ts
export type SystemHooks = {
  reloadTools: () => Promise<void>;       // re-install the core extensions into the live registry
  stop: (code: number) => Promise<void>;  // close Fastify, then exit; EXIT_RESTART when supervised
};
export class OperationBusyError extends Error { readonly operation: Operation; }  // the one that is running
/** Called once from index.ts before listen: reconcile the previous process's record, read versions. */
export async function openSystem(hooks: SystemHooks): Promise<void> { throw new Error("not implemented"); }
/** The only read path. Routes and the socket fan-out both call this; there is no second copy. */
export function systemSnapshot(): SystemSnapshot { throw new Error("not implemented"); }
/** Single-flight. Same kind already running → that operation; another kind → OperationBusyError. */
export function startOperation(kind: OperationKind): Operation { throw new Error("not implemented"); }
export function subscribeSystem(listener: (frame: SystemFrame) => void): () => void { throw new Error("not implemented"); }
/** Kill a running child on SIGTERM and mark its operation interrupted. */
export function disposeSystem(): void { throw new Error("not implemented"); }
```

```ts
// TODO: runUpdate — one body, two modes, selected by capability and recorded in the outcome.
async function runUpdate(op: Operation): Promise<void> {
  const before = await readVersions();
  if (facts.capability.update === "reload") {
    move(op, { name: "running", step: "reloading" });   // appends a `state` LogLine, then publishes
    await hooks.reloadTools();
    finish(op, { name: "done", outcome: { kind: "update", mode: "reload", before, after: before, changed: false } });
    return;                                             // nothing was downloaded; the log says so
  }
  move(op, { name: "running", step: "checking" });
  // npm from the same interpreter when npm started us (npm_execpath), else a PATH lookup.
  if (await exec(op, npmCommand(), ["update", ...PI_PACKAGES]) !== 0) return fail(op, "npm update failed");
  move(op, { name: "running", step: "building" });
  if (await exec(op, ["npm", "run", "build"]) !== 0) return fail(op, "the UI build failed");
  const after = await readVersions();
  finish(op, { name: "done", outcome: { kind: "update", mode: "packages", before, after, changed: !same(before, after) } });
}
// TODO: runRestart — record the intent, give the reply and the socket 150 ms, then exit.
async function runRestart(op: Operation): Promise<void> {
  move(op, { name: "running", step: "stopping" });
  // `stopped` when no supervisor exists, `restarting` when one does: both terminal for this process.
  move(op, facts.supervisor === "none" ? { name: "stopped" } : { name: "restarting", supervisor: facts.supervisor });
  await persist(op);                                    // atomic: .tmp + rename, no half record on a crash
  await sleep(150);
  await hooks.stop(EXIT_RESTART);
}
// TODO: reconcile — data/system/last-operation.json, read once at openSystem(): "running" → interrupted,
//   "restarting" → done (restartedAt = now, downtimeMs = now - endedAt — the proof it came back), rest unchanged.
```

```ts
// packages/server/src/index.ts — the whole route surface, inside the existing authed plugin.
api.get("/system", async () => systemSnapshot());
api.post("/system/operations", async (request, reply) => {
  const kind = kindOf((request.body as { kind?: unknown } | undefined)?.kind);   // boundary: 400 otherwise
  try { await reply.code(202).send(startOperation(kind)); }
  catch (error) {
    if (error instanceof OperationBusyError)
      await reply.code(409).send({ code: "operation-in-progress", operationId: error.operation.id });
  }
});
// Same shape as /ws/presence: one socket per tab, a whole snapshot on connect, a frame on every change.
api.get("/ws/system", { websocket: true }, (socket) => { /* subscribeSystem → send; unsubscribe on close */ });
```

### Module map and data flow

| File | Change |
| --- | --- |
| `packages/server/src/system.ts` | new. Facts, registry, child runner, persistence, reconcile, subscribe. ~280 lines. |
| `packages/server/src/exit.ts` | new. `export const EXIT_RESTART = 75;` — imported by `scripts/dev.mjs` too, so the number exists once. |
| `packages/server/src/harness.ts` | extract `reinstallCore()` (the six `registry.install` calls) from `openHarness()` and export it. |
| `packages/server/src/index.ts` | `await openSystem({...})` before `listen`; three routes; `disposeSystem()` on SIGTERM; `/health` reads `systemSnapshot().process.sandboxed`. |
| `scripts/dev.mjs` | `PI_SUPERVISOR=dev`; watch `data/system/restart-request`; respawn the server child only. |
| `packages/web/src/{types,api,ws,state.svelte}.ts` | mirrors of the snapshot types; `system()`, `startOperation(kind)`, `connectSystem()`; `store.system`, `store.systemLog`, `watchSystem()`. |
| `packages/web/src/{views/System.svelte,router.svelte.ts}` | new panel; `{ name: "system" }` from `#/system`. |
| `packages/web/scripts/shots.mjs`, `scripts/e2e/scenarios/system.mjs` | one more screenshot route (`09-system`); one new scenario. |

Flow: `POST` → route parses the body into `OperationKind` → `startOperation` (single writer) → the runner appends
`LogLine`s and moves state → listeners get a whole `system` frame per transition and `log` frames per batch → the
`/ws/system` route fans them out → the client replaces its snapshot and appends only contiguous lines →
`System.svelte` reads. `GET /api/system` is `systemSnapshot()`; there is no other read.

### What each action actually achieves

The tool *code* is `node_modules/@earendil-works/*`; a running process cannot hot-swap ESM modules. An update
never changes the code this process is executing — it changes what the next process will load.

| | sandbox off — `mode: "packages"` | sandbox on — `mode: "reload"` |
| --- | --- | --- |
| runs | `npm update` on the four `@earendil-works` packages, then `npm run build` | nothing on disk |
| disk | lockfile, `node_modules`, `packages/web/dist` change | unchanged; the repo is read-only |
| this process | tools stay as loaded; the rebuilt UI is served on the next browser reload (`index.html` is read per request) | the six extensions are re-installed into the live registry; live threads see them at their next call |
| versions before/after | the real numbers, possibly equal (`changed: false` → "already up to date") | identical by construction; the log says "no packages were downloaded" |
| does **not** | `git pull`, restart the server, or run `check`/`e2e` | update anything; it cannot |

| restart under | what happens | what the UI says |
| --- | --- | --- |
| systemd user unit (`INVOCATION_ID`) | record `restarting`, flush, exit 75; `Restart=always` starts it in ~3 s | "Restarting — systemd starts it again." Then, after reconnecting: "Restarted · back after 3.1 s." |
| `npm run dev` (`PI_SUPERVISOR=dev`) | same exit; **`node --watch` swallows it and waits for a file change** (measured: it prints "Waiting for file changes" and stays alive), so the server also writes `data/system/restart-request`; dev.mjs sees it, deletes it, kills the watch child and respawns the server only. Vite keeps running. | same |
| bare `npm start` (none) | record `stopped`, flush, exit 75; nothing starts it again | "Stopped. Nothing supervises this process." The footer dot reads "reconnecting…" and stays there. |

### Invariants encoded in types

- `current: Operation | null` is a single slot; two operations cannot exist. `startOperation` is the only writer.
- `OperationState.name` is exactly the six panel states, so a screen cannot invent a seventh rendering.
- `restarting` is not `done`: only the next boot writes `restartedAt`, so "asked to restart" and "came back" are
  different facts in different processes. `interrupted` exists so a missing terminal state is never success.
- `UpdateOutcome.mode` makes a reload unable to masquerade as an installation; `changed` is computed once.
- `ProcessFacts.versions` (loaded) and `UpdateOutcome.after` (on disk) are separate fields, which is how the panel
  says "installed 1.3.1 · running 1.3.0 — restart to load it".
- `seq` on every `LogLine` plus `from` on every log frame: the client appends only when contiguous, otherwise it
  refetches a snapshot. A dropped frame cannot produce a plausible-looking log.
- Persisted JSON is parsed by a narrow reader that returns `null` on any mismatch; a corrupt record is not an
  interrupted operation, it is no record.

### Interface depth

Public surface: two routes, one socket, three client functions. Hidden behind it: supervisor detection, sandbox
policy, command construction, spawn/stream/cap, child kill on shutdown, atomic persistence, crash reconciliation,
version diffing, and a restart that spans a process boundary. The panel knows none of it — it renders
`capability`, `state`, `log`. The one thing deliberately exposed is `mode`, because the panel must not pretend a
reload was an update; that is information, not an implementation option. `system.ts` owns policy; `index.ts`
supplies two process-shaped hooks and stays thin.

## The System panel UI

`#/system` → `<System />`, entered from the sidebar footer's status button (see the display pass), which also
carries the live step. `shots.mjs` gains the route.

```svelte
<script lang="ts">
  const facts = $derived(store.system?.process ?? null);
  const shown = $derived(store.system?.current ?? store.system?.last ?? null);
  const phase = $derived(shown?.state.name ?? "idle");
  const busy = $derived(store.system?.current !== null);
  const outcome = $derived(shown?.state.name === "done" ? shown.state.outcome : null);
  // "Installed" is what the last update left on disk; "running" is what this process loaded at boot.
  const installed = $derived(outcome?.kind === "update" ? outcome.after : facts?.versions ?? null);
  const stale = $derived(installed !== null && facts !== null &&
    installed.packages["@earendil-works/pi-durable"] !== facts.versions.packages["@earendil-works/pi-durable"]);
</script>

<section class="page" data-testid="system-page">
  <header class="page__head">
    <h2 class="page__title">System</h2>
    <span class="chip" data-testid="system-versions">pi-durable {facts?.versions.packages["@earendil-works/pi-durable"]} · {facts?.versions.commit ?? "no git"}</span>
  </header>
  <div class="card system__facts"><!-- facts that decide what the buttons can do: state, not controls -->
    <div class="system__row"><span>Boundary</span><span>{facts?.sandboxed ? "sandboxed · repo read-only" : "not sandboxed · repo writable"}</span></div>
    <div class="system__row"><span>Supervisor</span><span>{facts?.supervisor === "none" ? "none" : facts?.supervisor + " · restarts the server"}</span></div>
    {#if stale}<div class="system__row system__row--notice"><span>Installed</span><span>{installed.packages["@earendil-works/pi-durable"]} · restart to load</span></div>{/if}
  </div>
  <div class="card system__op" data-state={phase} data-testid="system-state">
    <p class="system__headline">
      {#if phase === "idle"}Nothing has run since this server started.
      {:else if phase === "running"}<ActivityIndicator size="sm" label="working" />{stepWord(shown.state.step)}
      {:else if phase === "done" && outcome?.kind === "update"}{outcome.changed ? "Updated." : "Already up to date."} {versionLine(outcome)}
      {:else if phase === "done" && outcome?.kind === "restart"}Restarted · back {outcome.downtimeMs} ms later.
      {:else if phase === "failed"}{shown.state.reason} (exit {shown.state.exitCode ?? "—"})
      {:else if phase === "restarting"}Restarting — {shown.state.supervisor} starts it again.
      {:else if phase === "stopped"}Stopped. Nothing supervises this process.{/if}
    </p>
    <details class="system__output" open={phase === "failed"}>
      <summary>Output · last {LOG_LINES} lines{shown?.truncated ? " (earlier lines dropped)" : ""}</summary>
      <ol class="system__log" data-testid="system-log">
        {#each store.systemLog as line (line.seq)}<li class="system__line system__line--{line.kind}">{line.text}</li>{/each}
      </ol>
    </details>
  </div>
  <div class="card system__actions">
    <button class="btn btn--primary" disabled={busy} onclick={updateSystem} data-testid="system-update">{facts?.capability.update === "packages" ? "Update" : "Reload"}</button>
    <p class="hint">{facts?.capability.update === "packages"
      ? "Installs newer @earendil-works packages and rebuilds the UI. Restart afterwards to load them."
      : "The repo is read-only, so nothing can be installed. Reload re-registers the tools already loaded in this process."}</p>
    <button class="btn btn--danger" disabled={busy} onclick={restartSystem} data-testid="system-restart">Restart</button>
    <p class="hint">{facts?.capability.restart === "supervised"
      ? "The server goes down for a few seconds and comes back."
      : "Nothing supervises this process: the server stops and stays down until you start it again."}</p>
  </div>
</section>
```

`versionLine` renders `before → after` per package plus the commit, built once from the outcome; each command's
exit code is a `state` line in the log, so the headline never restates the log.

```ts
// state.svelte.ts — the client mirror, never a writer.
store.system: SystemSnapshot | null;
store.systemLog: LogLine[];           // replaced by a snapshot, appended only by a contiguous log frame
store.systemConnection: "idle" | "open" | "closed";
function onSystemFrame(frame: SystemFrame): void {
  if (frame.type === "system") {
    store.system = frame.system;
    store.systemLog = (frame.system.current ?? frame.system.last)?.log ?? [];
    return;
  }
  const current = store.system?.current;
  if (current?.id !== frame.operationId || frame.from !== lastSeq(store.systemLog) + 1) {
    void refreshSystem();             // a gap: one snapshot restores one truth
    return;
  }
  store.systemLog = [...store.systemLog, ...frame.lines];
}
```

| phase | condition | motion | actions |
| --- | --- | --- | --- |
| idle | `current === null && last === null` | none | enabled |
| running | `current !== null` | one `ActivityIndicator`, step word | disabled |
| done | `last.state.name === "done"` | none | enabled |
| failed | `last.state.name === "failed"` | none; output open | enabled |
| restarting | `last.state.name === "restarting"` | indicator until the socket drops | disabled |
| stopped | `last.state.name === "stopped"` | none; footer dot goes "reconnecting…" | disabled |

Honest reporting: before/after versions per package and the commit; `changed: false` when nothing moved; the exit
code of each command in the log and of the failed one in the headline; the tail with its own truncation notice;
and for a restart the two separate facts — "asked to restart" and "back after 3.1 s", written by two different
processes. No percentage and no elapsed-time progress: the step word is a spawned process, not a clock. The log
does not animate; only the headline indicator moves, and it is static under `prefers-reduced-motion`.

## The display simplification pass

Show the state, hide the controls. One list, twenty-three concrete edits.

1. `App.svelte` — remove the three footer tabs (`Agents`, `Models`, `Usage`); replace with one `⋯` menu holding the same three destinations, because navigation that never changes should not hold three permanent slots.
2. `App.svelte` — replace the footer's `dot + connected` span with a button that opens `#/system`; while an operation runs its text becomes the step ("installing…"). The footer should carry state, and this one matters.
3. `App.svelte` — remove the hero's `.eyebrow` and the four-line durability paragraph; replace with "Pick a thread, or start one." — the hero's only job is the next action.
4. `App.svelte` — add the `#/system` branch to `<main>` and `watchSystem()`/`unwatchSystem()` beside the presence ones.
5. `Sidebar.svelte` — remove the always-visible `Search threads…` input; replace with a magnifier `icon-btn` in `sidebar__head` that reveals and focuses the same input (Escape closes it, `data-testid` kept). Search is occasional; it currently costs a full row on every visit.
6. `Sidebar.svelte` — remove the `active · N` section meta; replace with `N` alone, only when `N > 0` (a disabled agent shows `off`). "Active" is the default, and `0` beside an empty section is noise.
7. `Sidebar.svelte` — remove the per-thread `⋯` in the resting state; show it on `.thread-row:hover` / `:focus-within`, always under `@media (hover: none)`. Thirty rows × one icon compete with the one action, open a thread. Opacity only, `var(--t)`.
8. `Sidebar.svelte` — remove `No threads yet.` from every empty section (the header count already says `0`); keep exactly one search-empty state, "No threads match …".
9. `Sidebar.svelte` — move Full Access out of the chat header into the thread `⋯` menu ("Allow" / "Revoke Full Access"); a permission that is off by default should not own a permanent chip.
10. `Chat.svelte` — remove the agent `@chip`; the avatar becomes a button (`title="Edit agent"`) to `#/agents/<id>`. Identity is state; its navigation is one control, not two.
11. `Chat.svelte` — remove the three visible mode buttons (`modes`); replace with one `chip--link` showing the current mode that opens `GroupSettings`, where the three modes and their hints live.
12. `Chat.svelte` — remove the `Full Access: off` chip; replace with a muted `Full Access` mark beside the title, only when granted. Off is the default; a permanent control to turn it on is not.
13. `Chat.svelte` — remove the `model` chip from the header; the `ContextBar` under the composer already shows the model and is where it changes. One model display, at the place of change.
14. `Chat.svelte` — remove the header `Stop`; the composer's primary button becomes `Stop` while replying (`type="button"`, calls `abort`), and Enter still steers as the placeholder says — one obvious action either way.
15. `Chat.svelte` — remove `Restart thread` from the disabled-agent notice; keep the sentence and one primary `Enable agent` (restart lives in the thread menu). A notice reports state; two buttons make it a toolbar.
16. `Chat.svelte` — remove the `.msg__who` label for `user` and `system` entries; keep the speaker name only for assistant and group messages. "you" above your own bubble says nothing.
17. `AgentEditor.svelte` — replace the flat right column with two `<details>`: `Model` (provider, model, thinking, test) open, `Policy` (tools, permissions, cwd, warnings) collapsed with `Standard · read, write, edit` in the summary — eight simultaneous controls become two disclosures.
18. `AgentEditor.svelte` — remove the `model-badges` hint paragraph; fold images/context into the existing `<option>` text and cost into its `title`. The same facts were stated twice, one line apart.
19. `AgentEditor.svelte` — replace the standalone `Suggest from SOUL.md` button with a text link in the responsibility field's label row: a convenience for one field, not a screen-level action.
20. `AgentEditor.svelte` — replace the always-open colour/emoji grid with the identity card plus a `Change` disclosure holding the palette and emoji grid; identity is set once and then only read.
21. `app.css` — remove the dead selectors `.section__dot` (three blocks), `.chip--author`, `.marker--group` and `.marker--plain`; no component uses them.
22. `app.css` — collapse the three `.tab` blocks into one and the two `.msg__who` blocks into one; later declarations currently win by order, which is how a small change breaks a screen silently.
23. `app.css` — add `.system__facts`, `.system__row`, `.system__headline` and `.system__log` (mono, 11–12px, `tabular-nums`), using only existing tokens and `--r-md`/`--r-sm`.

## Synthesis decision

Filled by orchestrator.

## Tradeoffs accepted

- We accept one operation at a time in exchange for one writer and no interleaving rules: a second request joins or is refused.
- We accept a persisted record in `data/system/` in exchange for a restart that can prove it came back; it is a tail, not a history: one operation, overwritten.
- We accept a manual mirror of the snapshot types in `packages/web/src/types.ts` in exchange for not generating code; it is the convention `ws.ts` already uses, and a mismatch fails at the read site.
- We accept that `npm run dev` needs a sentinel file because `node --watch` hides the child's exit, in exchange for keeping `--watch`'s file-change reload.
- We accept that a sandboxed "Update" downloads nothing and changes no version, in exchange for never pretending and for recovering a broken registry without a restart.
- We accept losing a permanent Full Access toggle and a permanent search field in exchange for calmer screens; both are one click away, and `npm run shots` shows whether the trade reads on a phone.
- We accept a whole snapshot per transition rather than deltas in exchange for a client that cannot drift.

## Alternatives considered

- **Request/response with polling (the other candidate).** The route awaits the update and answers with the outcome; the panel polls while it runs. Deep interface, but the operation has no identity, the log must be re-fetched on every tick, and the restart request cannot answer at all because the process it answers from is gone. Lost on the restart case, which is half the feature.
- **SSE (`GET /api/system/stream`) instead of a socket.** `EventSource` reconnects by itself and `Last-Event-ID` gives resumption for free, so the server is simpler. Lost because the app already owns one streamed transport with a reconnect policy and a token query convention; two transports is two ways to do one task.
- **The client owns the operation (POST returns immediately, the UI keeps the log and polls).** Smallest server, but it splits ownership: a second tab, a reload or a navigation would each keep its own copy of the truth. Rejected by `split ownership`.
- **In-process soft restart (close the harness and Fastify, then re-listen).** Would work under `--watch` with no sentinel. Lost because it duplicates the boot sequence inside a running process and still cannot load new package code, while opening a second way for the app to be half-up.

## Open questions and risks

- Should Update also `git pull`? The sketch deliberately does not: pulling source behind the user is a larger action than "update the tools". If yes, the operation gains a step and the versions row a commit.
- Is `npm update` the right command, or `npm ci` after a `git pull` (the README's manual recipe)? The first moves within the semver ranges and rewrites the lockfile; the second installs exactly what the manifest pins.
- Does the restart sentinel belong in `data/system/`, or should `dev.mjs` drop `--watch` and own restarts with no file contract? The sentinel keeps `--watch`; dropping it makes the process contract one exit code.
- `npm` may not be on `PATH` under the systemd unit (it runs `node` directly). The design falls back from `npm_execpath` to `PATH` and reports a spawn failure honestly — enough, or should the unit set `PATH`?
- Risk: the WS fan-out must flush before `stop()`. 150 ms is a guess; if a slow client misses `restarting`, the persisted record still explains it after reconnection.
- Risk: `npm update` can leave `node_modules` half-installed if killed mid-run. The operation reports `interrupted`; a follow-up update must be safe to re-run, which it is.
- Risk: the six states assume one operation, but the registry is in memory. A second server on the same data dir (the E2E harness already does this deliberately) would share the record file, not the operation.

## Next implementation step

Write `packages/server/src/system.ts` with `openSystem`/`systemSnapshot`/`startOperation` and the reload path only
(no child processes yet), wire `GET /api/system` and `POST /api/system/operations`, and add
`scripts/e2e/scenarios/system.mjs` asserting the snapshot shape, the 202 body, the single-flight 409, and that a
sandboxed update ends `done` with `mode: "reload"` and `changed: false`.
