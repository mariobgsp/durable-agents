# Roadmap and decisions

This document is binding for the CLI + Telegram product. It replaces the browser-first plan.

## Locked decisions

| Item | Value |
| --- | --- |
| Shape | One daemon process; CLI + Telegram bots + read-only fleet TUI. No HTTP listener. |
| Engine | `@earendil-works/pi-durable` **1.3.0**, pinned. No fork; only public options. |
| Chat surface | Telegram, one long-poll loop per registered bot. Agents store a home bot label. |
| Setup | `dura init`: five strictly sequential steps (Agents, Provider, Telegram, Service, Connection test), resumable via `config.setup`. |
| Data | `~/.dura-file` (DURA_HOME overrides). Provider keys in credentials.json 0600; bot tokens in secrets/telegram.json 0600. |
| Providers | Any pi-ai built-in provider; key-only wizard; default opencode-go / deepseek-v4.1-flash. Catalog imported only by the CLI. |
| Permissions | Agents default to tier full, cwd $HOME, all tools. Policy, not a sandbox; systemd MemoryMax bounds the process. |
| Runs | At most five concurrent, bounded queue; schedules skip when busy; Telegram notices queue position. |
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

## Known gaps

- No E2E scenario for the group/nyahut flow end to end (the room code itself is unchanged and unit-covered by the
  previous suite; the transport path is not).
- Voice/video, MCP servers, per-agent hooks and a skills curator are not started.
- The benchmark uses the faux provider: it measures daemon memory under tool load, not real provider buffers.
- `dura tune` reports zram-generator steps instead of installing packages.
