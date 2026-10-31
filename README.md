# dura-agents

Durable agents with a CLI and one chat surface: Telegram bots **or** a Discord bot. The daemon owns the
durable state; the user chooses the surface at setup and exactly one transport is active at a time. The
terminal provides setup, administration, log inspection and a read-only fleet monitor.

Built on [@earendil-works/pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.3.0: every message,
tool call and generation is a durable task in SQLite, so killing the daemon or losing the network does not lose work
in flight.

~~~text
dura CLI  ── unix socket ──►  daemon  ──►  Telegram Bot API  (one poller per bot)
   │                            │       or Discord Gateway (one connection per bot)
   └─ fleet TUI                 └─ SQLite · agents · schedules · mesh · vault · artifacts
~~~

## Why this shape

- **One process owns durability.** The harness, SQLite, the scheduler, the agent network and the provider registry
  live in the daemon. Telegram and Discord are transports: either can fail, rate-limit or be swapped without
  losing a run.
- **No listening port.** The CLI and TUI connect over a 0600 Unix socket. Nothing is exposed to the network except
  outbound Bot API calls or the outbound Discord Gateway WebSocket.
- **One chat surface, chosen by the user.** Telegram and Discord are mutually exclusive; the inactive platform's
  credentials stay on disk but are never started. Chat is the product surface: threads, groups, questions, files,
  usage, memory and admin actions. No web UI, no build step, no PWA.
- **The fleet is monitoring, not a second UI.** `dura monitor` renders the live roster; its only write is an
  explicit add-agent form.

## Quick start

```bash
npm install
npm link                       # optional: puts `dura` on PATH; otherwise use node packages/cli/bin/dura.ts
dura init
dura status
```

Node 22.19 or newer is required (`engines` in `package.json`).

`dura init` is a strictly sequential wizard:

| Step | What it does |
| --- | --- |
| 1 Agents | Creates the orchestrator (always asked when missing; asks to replace when present) and any extra agents. Model and bot are deferred to steps 2 and 3. |
| 2 Provider | Detects existing credentials, defaults to opencode-go / deepseek-v4.1-flash, or adds any key-only pi-ai provider by API key (validated before saving). |
| 3 Chat surface | The user chooses **Telegram bot** or **Discord bot**. Telegram adds one or more bots (getMe validated), binds the owner, and assigns a home bot to every agent. Discord validates the bot token, prints the invite URL, binds the owner id, and sets a default agent. Only the chosen surface is recorded and activated. |
| 4 Service | Offers the systemd user unit and reports zram/sysctl tuning. |
| 5 Connection test | Starts the daemon and proves provider completion, bot identity, owner delivery, socket/no-TCP, SQLite and one live agent round-trip. Writes setup.verifiedAt only on success. |

A re-run resumes at the first unfinished step. `--yes` takes the default answer for the prompts that honor it;
a few confirmations still ask. `--skip-test` skips the connection test and leaves setup unverified.

```bash
dura verify                    # the same checks, any time
dura monitor                   # fleet TUI (q quit, r refresh, a add agent)
dura logs -f                  # JSON lines: lifecycle, connection, conversations, errors
```

## CLI

| Command | Purpose |
| --- | --- |
| `dura init` | Five-step setup wizard, including the chat-surface choice |
| `dura chat show \| use <telegram\|discord> \| status` | Show or switch the one active surface |
| `dura start` / `stop` / `restart` | Daemon lifecycle (foreground on a TTY, background otherwise) |
| `dura status` | Daemon, bots, agents, runs, memory, verification time |
| `dura verify` | Connection test against a running daemon (or `--start` one) |
| `dura logs` | Read or follow the daemon log |
| `dura agent list \| show \| create \| set \| enable \| disable \| delete \| docs \| edit-doc \| restore-doc \| suggest` | Agent records and personas |
| `dura orchestrator show \| set \| create \| replace` | The orchestrator pointer |
| `dura provider list \| add \| models \| test \| remove \| default \| status` | Providers and API keys |
| `dura bot list \| add \| connect \| disconnect \| normalize \| remove \| default \| enable \| disable \| test` | Active-platform bot registry |
| `dura discord whoami \| test \| invite \| threads \| mod \| commands \| list` | Discord-specific diagnostics and moderation |
| `dura user list \| add \| remove \| owner \| pending \| approve \| deny \| invite` | Allowlist for the active platform |
| `dura group list \| create \| show \| mode` | Durable groups (bind one in Telegram with /bind) |
| `dura thread list \| prune \| delete \| restore \| purge \| purge-deleted` | Thread hygiene: prune by age, purge with export, vacuum |
| `dura mcp list \| add \| remove \| reload \| tools` | Global MCP servers (stdio) available to every agent |
| `dura monitor [--json] [--read-only]` | Fleet TUI |
| `dura usage` / `memory` / `schedule` / `storage` / `vault` | Reports and data |
| `dura config get \| set \| edit \| validate` | config.json |
| `dura service install \| uninstall \| status` | systemd user unit |
| `dura sudo install \| uninstall \| status` | Privileged maintenance: exact sudoers rules for the detected OS |
| `dura tune status \| apply --yes` | zram/sysctl report; applies only values still at kernel defaults |
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
`/menu`, `/new` (thread), `/threads`, `/plan [goal]` (plan without executing), `/model` (show, or choose a model
from buttons for the current thread), `/thinking`, `/usage`, `/reload` (owner: tools and thread rebind), `/restart`
(owner: service restart, with confirmation), `/agents`, `/memory`, `/schedules`, `/group`, `/bind`, `/status`,
`/whoami`, `/compact`, `/stop`, `/abort`, `/grant`, `/connect`, `/orchestrator`, `/bots`, `/settings`, `/mcp`,
`/prune`, `/help`.
Each message gets a brief `Think · planning the next step` placeholder, edited into short progress lines such as
`bash: git status` and `read: core/src/live.ts` (the last three calls). A message sent while the run is live is
**steered** into it (`Steer · added to the current run`). Final answers use Telegram **Rich Messages** (GFM
headings, tables, task lists, long code, up to 30k characters) when the API supports them, with HTML as fallback;
generated files follow.
`/stop` aborts the active run and withdraws queued messages. The `question` tool renders inline buttons.

The allowlist is global across bots. Unknown users are refused, queued as pending, and the owner gets
Approve/Block buttons. A bot cannot add members to a group itself; `dura user invite --chat <id>` prints a
single-use invite link, and `dura user add <id>` authorises them.

## Discord

Discord is the other choice at step 3 (`dura chat use discord` switches later). A Discord **bot** is a
fleet connection, not a private bot per agent: DMs go to the bot's default agent, and a **thread is one durable
session**. Use `/new` in a server channel to create a thread and bind it, `/threads` to list and link sessions,
`/agent <id>` to move one, `/rename` and `/archive` to manage the Discord side, `/unbind` to remove a binding,
and `/bind agent:<id>` to make a whole channel route to one agent. A mention in an unbound channel starts a
thread so the channel stays clean.

Enable **Message Content Intent** in the Discord Developer Portal before inviting. The setup step prints an
invite URL with the `bot applications.commands` scopes and the permissions needed for threads, files and
moderation. Native slash commands are registered on every start, with `!help`, `!new`, `!stop` and the other
core commands as a text fallback while Discord propagates them.

Answers stream through one edited placeholder (coalesced to respect Discord's edit limits), split at 2,000
characters with code fences preserved; longer answers become a Markdown file. Generated artifacts are uploaded
as attachments. The `question` tool becomes buttons or a select menu.

Moderation is owner-only from Discord: `/mod timeout|kick|ban|unban|warn|warnings|audit`. Kick and ban ask for a
confirmation button; every action writes an audit line, checks the bot's role against the target, and refuses
the guild owner or the bot itself. Agent-callable moderation is off by default; enable
`discord.moderation.agentTools` to let the agent-facing `discord` tool use it. `dura discord whoami`, `test`,
`invite`, `threads`, `mod` and `commands sync` are the host-side equivalents.

Only one surface is started: switching to Discord stops the Telegram pollers, and the Telegram credentials stay
in `secrets/telegram.json` for an easy switch back. `dura status` prints the running platform; `dura doctor`
reports configured-but-inactive credentials.

### Orchestrator

The config stores one pointer. The orchestrator receives administrative tools that other agents never get:

- `agent_admin_list`, `agent_read`, `agent_create`, `agent_update`, `agent_set_enabled`, `agent_delete`,
  `agent_suggest`
- `agent_write_doc`: change another agent's AGENT.md/SOUL.md with a sha256 guard, replace/append/patch modes,
  a 64 KiB cap, five versions of history and an immediate rebind of every existing thread.
- The existing mesh tools: `agents_list`, `agents_message`, `agents_delegate`.

On Telegram, when several bots exist, `agent_create` without a bot returns an instruction to ask the owner with
the question tool, then retries with the chosen label. The orchestrator can never edit MEMORY.md, read vault
values, drop the pointer or delete itself.

Any agent can ask to take the role with `orchestrator_claim`. If no orchestrator exists the claim takes effect at
once and the owner is notified; if one exists the owner gets Approve/Deny buttons in the active chat. An approved
claim rebinds the conversations so the administrative tools move immediately.

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

## Privileged maintenance (sudo)

An agent can ask to clean system caches, drop memory caches, or update the host's packages. Nothing runs until
the owner presses a button in chat, and the capability itself is installed once, explicitly:

~~~bash
dura sudo install            # fixed actions: cleanup, memory, update
dura sudo install --root     # also allows the run action (arbitrary root commands)
dura sudo status
dura sudo uninstall
~~~

The installer detects the OS from /etc/os-release and the binaries on PATH: Fedora/RHEL (dnf/dnf5), Debian/Ubuntu
(apt-get), Arch/Omarchy (pacman), openSUSE (zypper), Alpine (apk). It prints the exact commands and the
/etc/sudoers.d/dura-agents content, asks, writes the rule with sudo, validates it with visudo, and probes it
before recording ~/.dura-file/sudo.json. Re-run after an OS upgrade if status reports drift.

The fixed actions are:

| Action | What it does |
| --- | --- |
| cleanup | package cache (paccache/pacman, dnf clean, apt-get clean, and so on), journal data beyond 200 MB, system temp files per systemd-tmpfiles |
| memory | sync, then vm.drop_caches=3 (page cache, dentries, inodes) |
| update | the detected package manager's full system upgrade |

They do not delete project folders or user files, clear swap, kill processes, or update the durable-agents
checkout (that is system_apply). Fedora atomic (rpm-ostree) reports update as unsupported; unknown package
managers can still use memory or --root.

Every use is a chat question showing the detected OS, the exact commands and a size or free-memory preview. The
answer is owner-only, one-shot and expires after 15 minutes. Approved commands run in a transient systemd user
unit - a sibling of dura.service - so the daemon keeps NoNewPrivileges and ProtectSystem while sudo and package
managers work; the host's sudoers file remains the authority. No password is ever sent through chat: a command
without a NOPASSWD rule fails with an instruction instead of hanging. --root writes NOPASSWD: ALL and enables
the run action; that is passwordless root for the account, and the chat approval is a policy gate, not a
containment boundary.

## MCP (global)

MCP servers are installed once and belong to every agent. The daemon speaks the stdio transport: a command, its
arguments and optional environment. Installing or removing a server connects/disconnects it, re-registers its tools
as `mcp__<server>__<tool>` and rebinds every conversation, so existing threads gain or lose the tools immediately.

~~~bash
dura mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/mariobgsp
dura mcp list
dura mcp remove filesystem
~~~

From chat the owner can use `/mcp` (`add <name> <command> [args…]`, `remove`, `reload` on Telegram; the same
actions with `name:` and `command:` options on Discord), or simply ask the orchestrator to install one (it has
`mcp_add`, `mcp_list` and `mcp_remove`). MCP tool calls run in the server
process with the daemon's OS permissions, so the server command is trusted code; only the owner may install.

## Thread storage

New threads are one row in `sessions.json` plus a conversation in SQLite; the index is written atomically. Stale
threads are handled without loading conversations in bulk:

~~~bash
dura thread prune --days 3 --dry-run               # preview
dura thread prune --days 3 --yes                   # soft delete (recoverable)
dura thread prune --days 3 --purge --vacuum --yes  # export, delete rows/artifacts, vacuum
~~~

Retention is **automatic** by default: at boot and every six hours (`DURA_RETENTION_HOURS` overrides), threads
older than **3 days** are soft-deleted, and tombstones older than another 3 days are purged (transcripts exported
first) and vacuumed. The rules live in `config.json` under `storage` (`auto`, `pruneAfterDays`, `purgeAfterDays`).
Before a batch disappears, a **single summary per agent** is appended to that agent's MEMORY.md — titles, last
request and last answer, capped at 12 detailed threads plus a count — so the gist survives without one note per
thread.

A prune reads the index once and writes it once, whether it deletes one thread or a thousand. Purge processes one
thread at a time (transcript to `~/.dura-file/exports`, rows, artifacts) so peak memory is one transcript, then
vacuum reclaims the file. Purpose threads (inbox/delegate/schedule) are kept unless `--include-purpose`. From
Telegram, `/prune [days]` offers Delete or Purge with confirmation. The Telegram binding self-heals when its thread
was pruned.

## Data layout

```text
~/.dura-file/                  (DURA_HOME overrides; PI_DATA_DIR is a one-release alias)
  config.json                  0600
  sudo.json                    0600 privileged-maintenance record (dura sudo install)
  credentials.json             provider keys, 0600
  mcp.json                     0600 global MCP server definitions
  secrets/telegram.json        Telegram bot tokens, 0600 (inactive when Discord is active)
  secrets/discord.json         Discord bot tokens, 0600 (inactive when Telegram is active)
  app.sqlite                   durable conversations, tasks, entries
  sessions.json                thread index (also mesh.json, schedules.json, usage.jsonl, system.json)
  agents/<id>/                 agent.json, AGENT.md, SOUL.md, MEMORY.md, .history/
  artifacts/<conversation>/    generated files
  vault/                       AES-256-GCM secrets and key
  telegram/                    users.json, state.json (offsets, bindings)
  discord/                     users.json, state.json (gateway session, bindings), warnings.json
  browser/                     Chromium profile and screenshots
  exports/                     transcripts written before a purge
  cache/                       Node compile cache
  tmp/                         per-agent scratch space
  logs/daemon.log[.1..3]       JSON lines, rotated
  run/daemon.sock              0600 control socket (plus pid, lock, ready.json)
  work is wherever an agent's cwd points (default $HOME)
```

Agents default to permission tier **full**, cwd **$HOME**, and every tool. Tiers, blocked tools and per-thread grants
remain available. The tier is a policy, not a sandbox: the operating-system account is the boundary. Approved
privileged maintenance is the deliberate exception: it runs in a transient unit outside that sandbox, as
described above.

## Providers

The wizard and `dura provider` read pi-ai's full catalog of 42 built-in providers. Key-only providers (opencode-go,
openai, anthropic, google, deepseek, openrouter, groq, mistral, xai, nvidia, together, fireworks and others) are
configured with an API key. Providers that need an endpoint, region or OAuth (azure, bedrock, vertex, cloudflare,
github-copilot) are listed with that requirement instead of a half-working form. A key can come from a hidden
prompt, `--key`, stdin (`--key-stdin`) or the provider's environment variable; it is never sent through a chat
surface.

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
file write and read, and a memory note, over eight tool rounds each — with the faux provider. It samples PSS for
the daemon and every descendant every 100 ms.

| Run | Completed | Wall | Peak PSS | p95 | p50 | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| `npm run bench` | **5/5** | 4.6 s | **242 MB** | 192 MB | 102 MB | < 2048 MB |

*This run used the offline faux provider; see the caveat at the end of this README.*

Levers: a five-slot run semaphore with a bounded queue; harness retention (progress 80 ms / output 120 ms, context
60 s); the code-mode sandbox capped at 256 MB; one Chromium that closes after 15 idle minutes; watchers only for
conversations with an active chat; one provider module per configured provider (the catalog is imported only by the
CLI). The systemd unit sets `MemoryHigh=1700M`, `MemoryMax=2G`, `MemorySwapMax=1G`.

`dura tune` checks zram and the VM settings before changing anything, writes only values still at their kernel
defaults with a sudo operation, and never overwrites a custom value. This host already had zram0 (zstd) and
swappiness 150.

## Testing

```bash
npm run check     # tsc + language lint
npm run e2e       # forty-two scenarios, offline
npm run bench     # the five-agent memory gate
```

The E2E harness starts a real daemon in a temporary home with the faux provider and a fake Bot API **or** a fake
Discord REST + Gateway server; it injects platform events and inspects the resulting messages, edits, callbacks,
files and SQLite state. Scenarios: `bot-pairing`, `bot-token-connect`, `chat-exclusive`, `command-scopes`,
`discord-chat`, `discord-init`, `discord-moderation`, `discord-question`, `discord-sudo`, `discord-thread`,
`discord-tool`, `discord-verify`, `init-wizard`, `mcp-global`, `memory-tool`, `orchestrator-claim`,
`orchestrator-claim-approval`, `orchestrator-docs`, `orchestrator-repo`, `provider-catalog`, `retention`,
`sudo-cleanup`, `sudo-deny`, `sudo-detect`, `sudo-not-installed`, `sudo-run-fixed`, `telegram-admin-commands`,
`telegram-chat`, `telegram-delivery-recovery`, `telegram-orchestrator`, `telegram-plan`, `telegram-progress`,
`telegram-question`, `telegram-question-followup`, `telegram-restart-notice`, `telegram-restart-notice-crash`,
`telegram-steer`, `telegram-stop`, `telegram-typing`, `thread-prune`, `tui-json`, `verify`.
`verify` is also tested against the real Telegram API on this machine: bot @samriobot,
opencode-go, a live agent answer in ~2.8 s.

## Migrating from the web version

`dura migrate` (offered by the wizard when the repository has an old `data/` directory) checkpoints the source
SQLite WAL, copies the database, agents, artifacts, vault, schedules and credentials into `~/.dura-file`, verifies
the copy with `PRAGMA integrity_check` and never deletes the source. Agent records are copied unchanged; when the
wizard chooses Telegram, step 3 assigns a home bot to any agent that lacks one. After a standalone `dura migrate`,
use `dura agent set <id> bot=<label>` or `/bots`.

Retired with the web UI: the Fleet bubbles screen (replaced by the TUI), display customization, PWA/service worker,
the boot screen, completion sounds/toasts, the hash router, the composer toolbar, the mermaid drawer (diagrams are
code blocks now), the memory graph (use `dura memory`) and the screenshot gate.

## Known limits

- Exactly one chat surface is active. Telegram and Discord cannot run together; switching is `dura chat use`.
- Telegram direct chats are strictly one bot per agent. A Discord bot is a fleet connection instead: DMs go to its
  default agent, and threads choose their agent. Discord group/room bindings and forum-channel parity are not in the
  first cut.
- Discord manual moderation is implemented; auto-moderation, welcome flows, role menus and tickets are phase 2 and
  off by default.
- The nyahut flow has no E2E scenario yet; only the room code path exists.
- MCP supports the stdio transport only (no HTTP/streamable transport yet).
- The benchmark uses the faux provider, so it measures the daemon's memory under tool load, not a real model's
  network buffers.
- Voice and video are not implemented. Per-agent hooks and a skills curator are not started.
- `dura tune` does not install packages; when no zram device exists it prints the zram-generator configuration to
  apply.
- Privileged maintenance covers system package caches, journal data beyond 200 MB, system temp files and the
  detected package manager's full upgrade. It does not remove project folders or user files, clear swap or kill
  processes. Fedora atomic (rpm-ostree) reports update unsupported; other unsupported managers need --root or
  manual rules.
- `dura sudo install` needs a terminal for the sudo password (or a valid sudo timestamp). Approvals expire after
  15 minutes and are lost on a daemon restart. Root mode is passwordless root for the account, so any local
  process can use the installed rule; the chat approval is a policy gate, not containment. Approved commands run
  outside the service sandbox and MemoryMax in transient units; a long upgrade can outlive the tool call and
  continues in the unit named in the result.
- On SELinux-enforcing Fedora, the transient unit runs in the user manager's domain; a policy that confines it can
  deny a maintenance command, and the command output reports the denial.

## License

MIT. See [LICENSE](LICENSE).
