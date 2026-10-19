# System panel and the display pass — synthesized design

Arena record: [`system-display/`](system-display/). Base: candidate 2 (operations model); grafts from
candidate 1. This file is the contract for the implementation.

## Problem

The app cannot describe itself: `GET /api/health` reports `sandboxed` and nothing else. "Tool" here means the
extensions registered in `harness.ts`; their code arrives through `node_modules`, and a running Node process
cannot hot-swap an ES module. So **Update is two operations**: install + rebuild when the repo is writable, an
in-process reload when the hardened unit has made it read-only (`PI_SANDBOXED=1`). **Restart is three
outcomes**: systemd `Restart=always` brings the unit back, `npm run dev` must be taught to respawn only the
server, bare `npm start` stops. The panel must say which, never promise a comeback that does not exist.
Alongside it, the display gets simpler: one obvious action per screen.

## Usage (caller's view)

```sh
tok=$(cat data/token)
curl -s -H "x-pi-token: $tok" localhost:8787/api/system | jq '.process.capability, .current, .last'
# → {"update":"reload","restart":"supervised"} / null / null
curl -s -H "x-pi-token: $tok" -H 'content-type: application/json' \
  -d '{}' localhost:8787/api/system/update | jq '.state'
# → {"name":"running","step":"reloading"}    (poll GET /api/system until terminal)
```

```ts
// packages/web/src/state.svelte.ts — the UI never owns an operation.
export async function startUpdate(): Promise<void> {
  store.systemOperationError = null;
  try { store.system = await api.startUpdate(); pollSystem(); }
  catch (error) { store.systemOperationError = messageOf(error); }
}
```

```svelte
<!-- views/System.svelte -->
<button class="btn btn--primary" disabled={busy} onclick={startUpdate} data-testid="system-update">
  {capability?.update === "reload" ? "Reload" : "Update"}
</button>
```

## Shape

```ts
// packages/server/src/system.ts — one owner of every process fact and every operation.
export type Supervisor = "systemd" | "dev" | "none";
export type UpdateMode = "packages" | "reload";
export type ToolVersions = { piDurable: string; piCodemode: string; piAi: string; chord: string; node: string };

export type ProcessFacts = {
  pid: number;
  startedAt: number;
  sandboxed: boolean;
  supervisor: Supervisor;
  /** What is possible here. Derived at boot: the panel cannot offer the impossible. */
  capability: { update: UpdateMode; restart: "supervised" | "stops" };
  /** What this process loaded at boot. The disk may have moved on. */
  versions: ToolVersions;
};

export type Step = "checking" | "installing" | "building" | "reloading" | "stopping";
export type UpdateOutcome = { kind: "update"; mode: UpdateMode; before: ToolVersions; after: ToolVersions; changed: boolean };
export type RestartOutcome = { kind: "restart"; supervisor: Supervisor; downtimeMs: number | null };
export type OperationState =
  | { name: "running"; step: Step }
  | { name: "done"; outcome: UpdateOutcome | RestartOutcome }
  | { name: "failed"; reason: string; exitCode: number | null }
  | { name: "restarting"; supervisor: Supervisor }
  | { name: "stopped" }
  | { name: "interrupted"; reason: string };
export type LogLine = { seq: number; at: number; kind: "state" | "log"; text: string };
export type Operation = {
  id: string; kind: "update" | "restart"; state: OperationState;
  startedAt: number; endedAt: number | null;
  log: LogLine[]; truncated: boolean;
};
export type SystemSnapshot = { process: ProcessFacts; current: Operation | null; last: Operation | null };
```

```ts
export type SystemHooks = {
  /** Re-install the core extensions from the modules already in memory; return their names. */
  reloadTools: () => string[];
  /** Close Fastify, then exit. The supervisor (or nothing) does the rest. */
  stop: () => Promise<void>;
};

/** Once, before listen: read versions, reconcile the previous process's record, derive capability. */
export async function openSystem(hooks: SystemHooks): Promise<void>;
/** The only read path; routes and the view both use it. */
export function systemSnapshot(): SystemSnapshot;
/** Single-flight. Same kind running joins it; another kind refuses. */
export function startOperation(kind: "update" | "restart"): Operation;
/** Kill a running child and mark its operation interrupted on SIGTERM. */
export function disposeSystem(): void;
/** Persist the terminal restart record, drop the dev sentinel, then leave. Called after the reply flushed. */
export async function performRestart(): Promise<void>;
```

Server wiring (thin shell, inside the existing authed plugin):

```ts
api.get("/system", async () => systemSnapshot());
api.post("/system/update", async () => startOperation("update"));      // 409 on a restart in flight
api.post("/system/restart", async (_request, reply) => {
  const op = startOperation("restart");                                // already terminal: restarting | stopped
  reply.raw.once("finish", () => void performRestart());               // flush, not a timer
  return op;
});
```

### What each action actually achieves

| | sandbox off — `mode: "packages"` | sandbox on — `mode: "reload"` |
| --- | --- | --- |
| update runs | `npm update` the four `@earendil-works` packages, then `npm run build` | nothing on disk |
| disk | lockfile, `node_modules`, `packages/web/dist` change | unchanged (repo read-only) |
| this process | tools stay as loaded; the rebuilt UI is served on the next browser load | the seven core extensions are re-installed and every agent rebound |
| versions | real before → after, `changed` computed once | identical by construction |

| restart under | happens | UI says |
| --- | --- | --- |
| systemd (`INVOCATION_ID`/`JOURNAL_STREAM`) | record `restarting`, flush, exit; `Restart=always` returns it | "Restarting — systemd starts it again." Then, after reconnect, "Restarted · back after N s." |
| `npm run dev` (`PI_SUPERVISOR=dev`) | same, plus `data/system/restart-request`; `dev.mjs` polls it and respawns **only** the server child | same |
| bare `npm start` | record `stopped`, flush, exit | "Stopped. Nothing supervises this process." |

### Ownership and reconciliation

`system.ts` holds one `current` operation. Starting a second of the same kind returns it (join); a different
kind is refused with `409 operation-in-progress`. The job is persisted only at a terminal phase to
`data/system.json` (atomic tmp + rename) and read once at boot: `running` → `interrupted`; `restarting` →
`done` with `downtimeMs`, written by the *next* process — the proof it came back. `disposeSystem()` kills a
running child on SIGTERM. The log is a bounded tail (60 lines, 500 chars each) with a monotonic `seq`; the
client appends nothing and always renders a whole snapshot, so a missed poll cannot invent a line.

### Deliberate deviation from candidate 2

No `/ws/system`. One tab watches one operation; the snapshot is small and polling it at 1 s hides the same
complexity behind one `GET` and reuses `req<T>`. Streaming is recorded in Alternatives.

## The display pass

One obvious action per screen; everything else is state, not a control.

1. **App** — footer becomes a four-column grid `Agents · Models · Usage · System`; the connection dot moves
   to the brand row (title + `aria-label`), because process state belongs to the process screen and the
   footer's job is navigation.
2. **App** — home hero loses the eyebrow badge and the four-line paragraph; it says "Pick a thread, or start
   one." — the hero's only job is the next action.
3. **Sidebar** — the always-visible search row becomes a `⌕` button in the head that reveals the same
   `thread-search` input; search is occasional and costs a row on every visit.
4. **Sidebar** — section meta shows `N` only when `N > 0` (`off` for a disabled agent); "active · N" states
   the default.
5. **Sidebar** — the per-row marker dot goes; the slot stays for the activity indicator. The section avatar
   already carries identity.
6. **Sidebar** — the thread `⋯` is revealed on hover/focus (always visible where hover does not exist).
7. **Sidebar** — the Groups header `+` goes; `#/groups` owns "New group".
8. **Chat** — the model chip goes; `ContextBar` shows and changes the model.
9. **Chat** — the `@agent` chip goes; the agent avatar itself links to the editor.
10. **Chat** — the three-button mode switch becomes one chip showing the current mode, opening
    `GroupSettings`. One way to do one task.
11. **Chat** — the `typing` row goes; the strip or the phase bubble already reports it, one indicator per frame.
12. **Chat** — user bubbles lose their "you" label; alignment and colour already say it.
13. **Chat** — composer placeholders become short: "Write a message…", "Write to the group…", "Steer the reply…".
14. **AgentEditor** — colour swatches only; the hex input and Shuffle go, because the identity card prints the
    hex and three controls edit one value.
15. **AgentEditor** — the model-badge paragraph goes; the facts stay in the option text and `title`.
16. **AgentEditor** — tools, permissions, cwd and the warnings move into a collapsed **Advanced** disclosure;
    the model block stays open. Eight simultaneous controls become two disclosures.
17. **app.css** — delete dead `.list`/`.item*`/`.tabs`/`.section__dot*`/`.marker*`/`.foot-status` and collapse
    the duplicate `.tab`, `.msg__who`, `.thread__meta`, `.typing`, `.marker` blocks.
18. **app.css** — add only `.facts`, `.job*` and `.system__*` using existing tokens; the only motion is the
    existing `ActivityIndicator` while the server reports `running`; `restarting`/`stopped` are static text.

## Synthesis decision

Base: **candidate 2**, for complete single-writer ownership (`disposeSystem`, `interrupted`, reconciling
`restarting` in the next process), honesty encoded as `capability` (`Reload` vs `Update`, installed vs running),
and a verifiable `npm run dev` comeback (sentinel, not exit-code propagation — candidate 1's exit-75 protocol
never reaches `dev.mjs` because it spawns `node --watch`).

Grafted from candidate 1: (1) deterministic exit after the reply is flushed (`reply.raw.once("finish")`) instead
of candidate 2's 150 ms guess; (2) the wider dead-CSS sweep and duplicate collapse; (3) static text with no
animated indicator while the server is down or stopping (roadmap live-indicator rule 4).

Rejected: candidate 2's `/ws/system` (one consumer, a second transport for no earlier action); candidate 1's
`npm update --save` summary claiming a restart the UI does not need; candidate 2's "six extensions" count —
`harness.ts` installs **seven**.

## Tradeoffs accepted

- One operation per process, no history beyond the last outcome: a single writer and no two npm runs on one
  `node_modules`.
- 1 s polling instead of streaming: one route, no frame union, no reconnect reconciliation.
- The packages path is manual-verification only (needs network and writes `node_modules`); E2E proves the reload
  path and all three restart plans.
- The panel exposes `mode`, package versions and the sandbox, but not pids or paths, keeping process internals
  off the wire beyond what the decision needs.
- A manual mirror of the snapshot types in `web/src/types.ts`, the same convention as `wire.ts`.

## Alternatives considered

- **Streaming the operation over a dedicated WS** (candidate 2). Deep on ownership but adds a frame type, a
  socket lifecycle and a second store for one button; polling is the smaller surface at equal honesty.
- **Blocking `POST /update` until npm exits** (candidate 1 alternative 2): fragile behind the Vite proxy and
  Tailscale, and losing the result on reload needs a second route anyway.
- **A separate updater process** owning a lock file: honest separation, but a second writer that can outlive
  what it updates.
- **`systemctl --user restart` from inside the unit**: a hardened unit may not reach the user manager's bus,
  and it cannot work under bare `npm start`.

## Open questions and risks

- `npm update` moves within the caret ranges; a major bump still needs a manifest edit. Out of scope here.
- The unit's `NODE_OPTIONS=768 MB` is stripped from the child env; a 4 GB box still needs swap for Vite.
- `npm` may not be on the unit's `PATH`; `npm_execpath` is preferred and a spawn failure is reported as `127`.
- A 60-line tail may cut a long failure; the exit code and the first failing step stay visible.

## Next implementation step

`packages/server/src/system.ts` + `paths.ts` roots + the three routes + `scripts/e2e/scenarios/system.mjs`;
then `System.svelte` and the display edits.
