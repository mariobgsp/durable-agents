# dura-agents

Durable agents with a CLI and Telegram bots. The daemon owns the durable state; Telegram is the only chat
surface; the terminal provides setup, administration, log inspection and a read-only fleet monitor.

Built on [@earendil-works/pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.3.0: every message,
tool call and generation is a durable task in SQLite, so killing the daemon or losing the network does not lose work
in flight.

~~~text
dura CLI  ── unix socket ──►  daemon  ──►  Telegram Bot API (one poller per bot)
   │                            │
   └─ fleet TUI                 └─ SQLite · agents · schedules · mesh · vault · artifacts
~~~

## Why this shape

- **One process owns durability.** The harness, SQLite, the scheduler, the agent network and the provider registry
  live in the daemon. Telegram is a transport: it can fail, rate-limit or be replaced without losing a run.
- **No listening port.** The CLI and TUI connect over a 0600 Unix socket. Nothing is exposed to the network except
  the outbound Bot API calls.
- **Telegram is the product surface.** Threads, groups, questions, files, usage, memory and admin actions are
  commands and menus in chat. No browser, no build step, no PWA.
- **The fleet is monitoring, not a second UI.** `dura monitor` renders the live roster; its only write is an
  explicit add-agent form.

## Quick start

```bash
npm install
npm link                       # optional: puts `dura` on PATH; otherwise use node packages/cli/bin/dura.ts
dura init
dura status
```

`dura init` is a strictly sequential wizard:

| Step | What it does |
| --- | --- |
| 1 Agents | Creates the orchestrator (always asked when missing; asks to replace when present) and any extra agents. Model and bot are deferred to steps 2 and 3. |
| 2 Provider | Detects existing credentials, defaults to opencode-go / deepseek-v4.1-flash, or adds any built-in pi-ai provider by API key (validated before saving). |
| 3 Telegram | Adds one or more bots (getMe validated), binds the owner with a short /start code or --owner-id, assigns a home bot to every agent, then writes the staged agents. |
| 4 Service | Offers the systemd user unit and reports zram/sysctl tuning. |
| 5 Connection test | Starts the daemon and proves provider completion, bot identity, owner delivery, socket/no-TCP, SQLite and one live agent round-trip. Writes setup.verifiedAt only on success. |

A re-run resumes at the first unfinished step. `--yes` accepts the current/default value everywhere;
`--skip-test` records the test as skipped and leaves setup unverified.

```bash
dura verify                    # the same checks, any time
dura monitor                   # fleet TUI (q quit, r refresh, a add agent)
dura logs -f                  # JSON lines: lifecycle, connection, conversations, errors
```

## CLI

| Command | Purpose |
| --- | --- |
| `dura init` | Five-step setup wizard |
| `dura start` / `stop` / `restart` | Daemon lifecycle (foreground on a TTY, background otherwise) |
| `dura status` | Daemon, bots, agents, runs, memory, verification time |
| `dura verify` | Connection test against a running daemon (or `--start` one) |
| `dura logs` | Read or follow the daemon log |
| `dura agent list \| show \| create \| set \| enable \| disable \| delete \| docs \| edit-doc \| restore-doc \| suggest` | Agent records and personas |
| `dura orchestrator show \| set \| create \| replace` | The orchestrator pointer |
| `dura provider list \| add \| models \| test \| remove \| default` | Providers and API keys |
| `dura bot list \| add \| remove \| default \| enable \| disable \| test` | Telegram bot registry |
| `dura user list \| add \| remove \| owner \| pending \| approve \| deny \| invite` | Allowlist and group invite links |
| `dura group list \| create \| show \| mode` | Durable groups (bind one in Telegram with /bind) |
| `dura thread list \| prune \| delete \| restore \| purge` | Thread hygiene: prune by age, purge with export, vacuum |
| `dura mcp list \| add \| remove \| reload \| tools` | Global MCP servers (stdio) available to every agent |
| `dura monitor [--json] [--read-only]` | Fleet TUI |
| `dura usage` / `memory` / `schedule` / `storage` / `vault` | Reports and data |
| `dura config get \| set \| edit \| validate` | config.json |
| `dura service install \| uninstall \| status` | systemd user unit |
| `dura tune status \| apply` | zram/sysctl report; applies only missing defaults |
| `dura migrate` | Copy an older data directory into DURA_HOME |
| `dura doctor` | Diagnostics, without making model calls |
| `dura telegram whoami \| test` | Bot identity and owner self-test |
| `dura bench` | Five-agent memory benchmark |

Global flags: `--json`, `--home <path>`, `--help`, `--version`. Exit codes: 0 ok, 1 runtime error, 2 usage,
3 daemon unavailable, 4 refused.

## Telegram

**One bot is one agent.** Each Telegram bot belongs to exactly one agent; a message to that bot goes to that agent,
never to a shared roster. `/new` starts a thread, `/threads` lists the agent's threads, and replies route to the
thread that produced the message. An agent without a bot is not unreachable: the orchestrator can message or
delegate to it. Adding a bot creates a pairing job: `/connect <agent> <token>` (the token message is deleted),
`dura bot add --token … --agent <id>`, `dura bot connect <label> <agent>`, `/bots` for buttons, or ask the
orchestrator to `bot_connect` it with a token. An unpaired bot answers the owner with a pairing prompt and refuses
everyone else. No browser or Telegram web automation is needed for connection; the token is the input.

Groups can be bound to a durable group thread (`/bind <id>`); the group keeps its nyahut/moderator/silent modes
and one speaker bot. A group is the deliberate multi-agent surface; direct chats are strictly one-to-one.

The command menu is scoped and rewritten on every start, so an older integration's commands cannot linger:
`/new` (thread), `/threads`, `/plan [goal]` (plan without executing), `/model` (show, or choose a model from
buttons for the current thread), `/usage`, `/reload` (owner: tools and thread rebind), `/restart` (owner:
service restart, with confirmation), `/agents`, `/memory`, `/schedules`, `/group`, `/bind`, `/status`,
`/whoami`, `/compact`, `/stop`, `/abort`, `/grant`, `/connect`, `/orchestrator`, `/bots`, `/settings`, `/mcp`,
`/prune`, `/help`.
Each message gets a brief `Think · planning the next step` placeholder plus short DSH-style progress lines
(`Bash · running a command · step 1`). A message sent while the run is live is **steered** into it
(`Steer · added to the current run`). Final answers use Telegram **Rich Messages** (GFM headings, tables, task lists,
long code, up to 30k characters) when the API supports them, with HTML as fallback; generated files follow.
`/stop` aborts the active run and withdraws queued messages. The `question` tool renders inline buttons.

The allowlist is global across bots. Unknown users are refused, queued as pending, and the owner gets
Approve/Block buttons. A bot cannot add members to a group itself; `dura user invite --chat <id>` prints a
single-use invite link, and `dura user add <id>` authorises them.

### Orchestrator

The config stores one pointer. The orchestrator receives administrative tools that other agents never get:

- `agent_admin_list`, `agent_read`, `agent_create`, `agent_update`, `agent_set_enabled`, `agent_delete`,
  `agent_suggest`
- `agent_write_doc`: change another agent's AGENT.md/SOUL.md with a sha256 guard, replace/append/patch modes,
  a 64 KiB cap, five versions of history and an immediate rebind of every existing thread.
- The existing mesh tools: `agents_list`, `agents_message`, `agents_delegate`.

When several bots exist, `agent_create` without a bot returns an instruction to ask the owner with the question
tool, then retries with the chosen label. The orchestrator can never edit MEMORY.md, read vault values, drop the
pointer or delete itself.

Any agent can ask to take the role with `orchestrator_claim`. If no orchestrator exists the claim takes effect at
once and the owner is notified; if one exists the owner gets Approve/Deny buttons in Telegram. An approved claim
rebinds the conversations so the administrative tools move immediately.

The orchestrator also owns the bot-to-agent map: `bot_list`, `bot_assign`, `bot_release` and `bot_connect`. The last
one takes an owner-provided bot token, starts the poller, pairs the agent and rebinds both sides; it never opens a
browser or Telegram web. That is the "sync and connect" path when the owner adds another bot.

## Models

The provider catalog is the full pi-ai catalog, not a shortlist: `opencode-go` alone exposes 29 models in this
version. Telegram's `/model` shows every model in pages of ten (Prev/Next), and `/model provider/model` accepts any
id directly. `dura provider models opencode-go` prints the full table for scripts.

## Orchestrator edits the system

The orchestrator can read and edit the durable-agents checkout like any other file tree. `repo_info` shows the
branch and working-tree changes, and `system_apply` runs `npm run check` and then restarts the service. Because the
systemd unit runs from the same checkout, the restart loads the edited source and config. A failed check applies
nothing. This is meant for workflow and system changes, not for replacing the owner's uncommitted work.

## MCP (global)

MCP servers are installed once and belong to every agent. The daemon speaks the stdio transport: a command, its
arguments and optional environment. Installing or removing a server connects/disconnects it, re-registers its tools
as `mcp__<server>__<tool>` and rebinds every conversation, so existing threads gain or lose the tools immediately.

~~~bash
dura mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/mariobgsp
dura mcp list
dura mcp remove filesystem
~~~

From Telegram the owner can use `/mcp add <name> <command> [args…]`, `/mcp remove`, `/mcp reload`, or simply ask
the orchestrator to install one (it has `mcp_add`, `mcp_list` and `mcp_remove`). MCP tool calls run in the server
process with the daemon's OS permissions, so the server command is trusted code; only the owner may install.

## Thread storage

New threads are one row in `sessions.json` plus a conversation in SQLite; the index is written atomically. Stale
threads are handled without loading conversations in bulk:

~~~bash
dura thread prune --days 3 --dry-run               # preview
dura thread prune --days 3 --yes                   # soft delete (recoverable)
dura thread prune --days 3 --purge --vacuum --yes  # export, delete rows/artifacts, vacuum
~~~

Retention is **automatic** by default: every six hours and at boot, threads older than **3 days** are soft-deleted,
and tombstones older than another 3 days are purged (transcripts exported first) and vacuumed. The values live in
`config.json` under `storage` (`auto`, `pruneAfterDays`, `purgeAfterDays`, `intervalHours`). Before a batch disappears,
a **single summary per agent** is appended to that agent's MEMORY.md — titles, last request and last answer, capped
at 12 detailed threads plus a count — so the gist survives without one note per thread.

A prune reads the index once and writes it once, whether it deletes one thread or a thousand. Purge processes one
thread at a time (transcript to `~/.dura-file/exports`, rows, artifacts) so peak memory is one transcript, then
vacuum reclaims the file. Purpose threads (inbox/delegate/schedule) are kept unless `--include-purpose`. From
Telegram, `/prune [days]` offers Delete or Purge with confirmation. The Telegram binding self-heals when its thread
was pruned.

## Data layout

```text
~/.dura-file/                  (DURA_HOME overrides; PI_DATA_DIR is a one-release alias)
  config.json                  0600
  credentials.json             provider keys, 0600
  secrets/telegram.json        bot tokens, 0600
  app.sqlite                   durable conversations, tasks, entries
  agents/<id>/                 agent.json, AGENT.md, SOUL.md, MEMORY.md, .history/
  artifacts/<conversation>/    generated files
  vault/                       AES-256-GCM secrets and key
  telegram/                    users.json, state.json (offsets, bindings)
  logs/daemon.log[.1..3]       JSON lines, rotated
  run/daemon.sock              0600 control socket
  work is wherever an agent's cwd points (default $HOME)
```

Agents default to permission tier **full**, cwd **$HOME**, and every tool. Tiers, blocked tools and per-thread grants
remain available. The tier is a policy, not a sandbox: the operating-system account is the boundary.

## Providers

The wizard and `dura provider` accept any of pi-ai's 42 built-in providers. Key-only providers (opencode-go,
openai, anthropic, google, deepseek, openrouter, groq, mistral, xai, nvidia, together, fireworks and others) are
configured with an API key. Providers that need an endpoint, region or OAuth (azure, bedrock, vertex, cloudflare,
github-copilot) are listed with that requirement instead of a half-working form. Keys can come from a hidden
prompt, stdin (`--key-stdin`) or the environment; they are never taken from argv or sent through Telegram.

```bash
dura provider list --all              # the whole catalog and what is configured
dura provider add groq                # hidden key prompt, validated, saved 0600
dura provider test opencode-go deepseek-v4.1-flash
dura provider default opencode-go deepseek-v4.1-flash
```

## Memory and performance

The design target is an **8 GB host** with five agents running full tools concurrently, under a 2 GB daemon cap.
The measured budget is five agents running full tools concurrently under 2 GB. The daemon opens at ~130 MB RSS;
the benchmark runs the same scripted complex task in five conversations at once — a CPU-bound shell loop, a 20 KiB
file write and read, and a memory note per round, eight rounds each — with the faux provider and two transport
pollers. It samples PSS for the daemon and every descendant every 100 ms.

| Run | Completed | Wall | Peak PSS | p95 | p50 | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| `npm run bench` | **5/5** | 4.6 s | **246 MB** | 190 MB | 105 MB | < 2048 MB |

	extit{This run used the offline faux provider; see the caveat at the end of this README.}

Levers: a five-slot run semaphore with a bounded queue; harness retention (partial commits 250 ms, context 30 s,
documents 60 s); code mode capped at 128 MB; one Chromium with idle shutdown; bounded render caches; watchers only
for conversations with an active chat; one provider module per configured provider (the catalog is imported only by
the CLI). The systemd unit sets `MemoryHigh=1700M`, `MemoryMax=2G`, `MemorySwapMax=1G`.

`dura tune` checks zram and the VM settings before changing anything, writes only missing sysctl values with a
sudo operation, and never overwrites a custom value. This host already had zram0 (zstd) and swappiness 150.

## Testing

```bash
npm run check     # tsc + language lint
npm run e2e       # twenty-three daemon-driven scenarios, offline
npm run bench     # the five-agent memory gate
```

The E2E harness starts a real daemon in a temporary home with the faux provider and a fake Bot API; it injects
Telegram updates and inspects the resulting messages, edits, callbacks, files and SQLite state. Scenarios:
`init-wizard`, `provider-catalog`, `command-scopes`, `telegram-chat`, `telegram-question`, `telegram-plan`,
`telegram-admin-commands`, `bot-pairing`, `telegram-orchestrator`, `orchestrator-docs`, `orchestrator-claim`,
`orchestrator-claim-approval`, `orchestrator-repo`, `mcp-global`, `memory-tool`, `thread-prune`, `retention`,
`telegram-stop`, `telegram-steer`, `telegram-progress`, `bot-token-connect`, `verify`, `tui-json`. `verify` is also tested against the real API on this machine:
bot @samriobot, opencode-go, a live
agent answer in ~2.8 s.

## Migrating from the web version

`dura migrate` (offered by the wizard when the repository has an old `data/` directory) checkpoints the source
SQLite WAL, copies the database, agents, artifacts, vault, schedules and credentials into `~/.dura-file`, verifies
the copy with `PRAGMA integrity_check` and never deletes the source. Existing agents are assigned the default bot;
reassign with `dura agent set <id> bot=<label>`.

Retired with the web UI: the Fleet bubbles screen (replaced by the TUI), display customization, PWA/service worker,
the boot screen, completion sounds/toasts, the hash router, the composer toolbar, the mermaid drawer (diagrams are
code blocks now), the memory graph (use `dura memory`) and the screenshot gate.

## Known limits

- Direct chats are strictly one bot per agent; a group remains a multi-agent surface with one speaker bot, and the
  nyahut flow is exercised by the unit-level room code, not yet by an E2E scenario.
- MCP supports the stdio transport only (no HTTP/streamable transport yet).
- The benchmark uses the faux provider, so it measures the daemon's memory under tool load, not a real model's
  network buffers.
- Voice and video are not implemented. MCP servers, per-agent hooks and a skills curator are not started.
- `dura tune` does not install packages; when no zram device exists it prints the zram-generator configuration to
  apply.

## License

MIT. See [LICENSE](LICENSE).
