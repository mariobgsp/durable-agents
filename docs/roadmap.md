# Roadmap and decisions

This document is binding for the CLI + one-chat-surface product. It replaces the browser-first plan.

## Locked decisions

| Item | Value |
| --- | --- |
| Shape | One daemon process; CLI + one chat surface (Telegram or Discord) + read-only fleet TUI. No HTTP listener. |
| Engine | `@earendil-works/pi-durable` **1.3.0**, pinned. No fork; only public options. |
| Chat surface | Mutually exclusive: `chat.active` is Telegram or Discord. Telegram uses one long-poll loop per registered bot and one home bot per agent. Discord uses one outbound Gateway connection per bot and binds agents at the thread/channel level. |
| Setup | `dura init`: five strictly sequential steps (Agents, Provider, Chat surface, Service, Connection test), resumable via `config.setup`. The surface step records `chat:<platform>`. |
| Data | `~/.dura-file` (DURA_HOME overrides). Provider keys in credentials.json 0600; bot tokens in secrets/telegram.json or secrets/discord.json 0600. |
| Providers | Any pi-ai built-in provider; key-only wizard; default opencode-go / deepseek-v4.1-flash. Catalog imported only by the CLI. |
| Permissions | Agents default to tier full, cwd $HOME, all tools. Policy, not a sandbox; systemd MemoryMax bounds the process. Approved sudo maintenance is installed per host by `dura sudo install` and runs in transient units. |
| Runs | At most five concurrent, bounded queue; schedules skip when busy; the active surface notices queue position. |
| Orchestrator | A config pointer. Admin tools are role-scoped: create several agents, message/delegate, read and patch AGENT.md/SOUL.md with a sha256 guard and history. |
| Fleet | `dura monitor` only. Read-only except the explicit add-agent form. |
| Language | System text English; `npm run lint:lang` enforces it. |

## Phases

### Phase 1 — CLI + daemon + IPC (DONE)
- `packages/server` renamed to `packages/core`; Fastify, the web package and the desktop shell removed.
- One daemon owns harness, SQLite, scheduler, mesh, providers, run limiter and the 0600 Unix socket.
- CLI skeleton: start/stop/status/logs/config/doctor/service/migrate.

### Phase 2 — Init wizard, providers, bots (DONE)
- Sequential wizard with staged agents (written at the end of step 3) and a resumable setup record.
- Provider catalog + key validation + lazy registration; opencode-go default.
- Bot registry, allowlist, owner binding, invite links.
- Agent CLI: create/set/enable/disable/delete/docs/edit-doc/restore-doc/suggest.

### Phase 3 — Telegram transport (DONE)
- Client with pacing, 429 retry_after, 5xx backoff, 409/401 isolation, long-poll abort on shutdown.
- Per-bot pollers, offsets and health; DM/topic/group routing; owner prompt when no orchestrator.
- Streaming edits with a coalescing sink; final answer + footer + artifacts; question inline buttons.
- Media in (photo/document) and out (sendDocument); group binding with a speaker bot and duplicate suppression.
- Admin/user notifications.

### Phase 4 — Orchestrator administration (DONE)
- Admin tools, bot-choice rule, doc store (sha guard, patch mode, 64 KiB, history, rebind), filesystem watcher,
  audit lines.

### Phase 5 — Fleet TUI (DONE)
- Fleet subscription over IPC, ANSI renderer with bot/run/memory headers, explicit add-agent form.

### Phase 6 — Memory budget and verification (DONE)
- Run limiter, harness retention tuning, lazy subsystems, systemd memory limits, `dura tune`, five-agent benchmark.
- Connection test shared by the wizard and `dura verify`.

### Phase 7 — Docs and gates (DONE)
- README/roadmap/design docs rewritten; the old E2E suite replaced by seven daemon + fake-Bot-API scenarios.
- `npm run check`, `npm run e2e`, `npm run bench` green.

### Phase 8 — Discord surface (DONE, first cut)
- Config `chat.active` and `discord` section; validation rejects unknown surfaces; legacy `telegram` setup step maps to `chat:telegram`.
- `packages/discord`: Gateway v10 (HELLO/IDENTIFY/heartbeat/RESUME, 4004/4014 handling), REST v10 with rate-limit and 429 retry, registry/users/state 0600.
- DM and thread routing; one durable session per Discord thread; `/new`, `/threads`, `/rename`, `/archive`, `/agent`, `/bind`, `/unbind`.
- Native slash commands plus `!command` fallback; streaming edits, 2,000-char splitting with fence repair, files, question buttons.
- Owner-only moderation: timeout, kick, ban, unban, warn, warnings, audit; confirmation buttons; hierarchy and self/owner guards.
- Agent-facing `discord` tool (send, thread create/archive/list, server info, opt-in moderation).
- `dura chat`, `dura discord`, Discord-aware `bot`/`user`/`status`/`doctor`/`verify`; fake Discord E2E server and eight scenarios.
- Phase 2: auto-moderation (spam/link/word/raid), welcome/role menus, tickets, forum-channel parity, group/room bindings.

### Phase 9 — Privileged maintenance (DONE)

- `dura sudo install` detects /etc/os-release and the package manager, prints and writes exact sudoers rules,
  validates with visudo, probes, and records sudo.json. `status` reports OS/drift; `uninstall` removes.
- cleanup, memory and update are fixed actions; `--root` adds arbitrary `run`. Every use is an owner-only,
  one-shot approval showing the exact commands; execution happens in a transient systemd user unit.
- E2E: `sudo-detect`, `sudo-cleanup`, `sudo-deny`, `sudo-not-installed`, `sudo-run-fixed`, `discord-sudo`.

### Phase 10 — Survives a reboot (DONE)

- `dura service install` reads systemd back and prints `starts at boot: yes/no`; a failure to enable lingering is
  reported with the exact `sudo loginctl enable-linger` command instead of a success message. `dura service status
  --json` exposes the same facts, and `dura doctor` shows them as one `boot` row.
- The first bot connection is retried with backoff (1 s to 30 s, until it is up) in both transports. A user unit
  starts at boot, before the laptop's network is, and the user manager has no `network-online.target` to order
  against.
- A bot that comes up late still reports the restart to its chats and recovers the deliveries the previous process
  left behind (Telegram, per bot, once each).
- E2E: `telegram-cold-boot` - the fake Bot API drops the connection for the first identity calls and the bot has to
  come up anyway.
- The unit quotes `NODE_OPTIONS`: systemd splits `Environment=` on whitespace, so the unquoted form kept the heap cap
  and silently dropped `--max-semi-space-size`, with an `Invalid environment assignment` line in the journal on
  every start. `dura service status` prints that journal, which is how it was found.

## Known gaps

- No E2E scenario for the group/nyahut flow end to end (the room code itself is unchanged and unit-covered by the
  previous suite; the transport path is not).
- Voice/video, MCP servers, per-agent hooks and a skills curator are not started.
- Discord auto-moderation, welcome/role menus, tickets and forum-channel parity are phase 2; group/room bindings
  on Discord are not implemented yet.
- The benchmark uses the faux provider: it measures daemon memory under tool load, not real provider buffers.
- `dura tune` reports zram-generator steps instead of installing packages.
- Privileged maintenance supports dnf/dnf5/yum, apt-get, pacman, zypper and apk. Fedora atomic (rpm-ostree)
  reports update unsupported; unknown managers need --root or manual rules. There is no password/askpass path:
  sudo must be NOPASSWD for the installed rule, and the installer needs a terminal for its one password prompt.
- A schedule window missed while the machine was off is counted, not replayed: the run waits for its next window
  and `missedRuns` shows how many were skipped.
- The restart notice ("Back after Xs", interrupted runs resuming) is Telegram-only; a Discord restart reconnects
  the Gateway but says nothing in the channel.
