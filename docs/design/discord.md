# Discord transport

Discord is active only when `chat.active = "discord"`. The daemon imports one transport; it never polls
Telegram while Discord is selected.

## Shape

- One outbound Gateway WebSocket per enabled bot. No inbound HTTP listener.
- The bot is a fleet connection, not a per-agent bot. DMs use the bot's `defaultAgent`; a guild thread is one
  durable session; `/agent` moves a session and `/bind agent:<id>` binds a channel.
- The registry lives in `secrets/discord.json` (0600); users, gateway state and warnings live under
  `discord/` (0600). Tokens are masked in every public read.

## Gateway

- URL: `wss://gateway.discord.gg/?v=10&encoding=json` (configurable for tests).
- Intents: `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT` (37377). MESSAGE_CONTENT is
  privileged; the user must enable **Message Content Intent** in the Developer Portal.
- HELLO starts jittered heartbeats; IDENTIFY sends the token and intents; READY stores the session id,
  sequence and resume URL; RESUME reconnects without replaying the whole session.
- Transient closes reconnect with jittered exponential backoff (1s to 60s). `4004` (bad token) and
  `4014` (disallowed intents) are fatal for that bot only; the daemon stays up and verify/status report the
  actionable message. A zombie heartbeat closes the socket and resumes.

## REST

- Base `https://discord.com/api/v10`; `Authorization: Bot <token>`; every snowflake stays a string.
- 429 responses wait `retry_after` with jitter; `X-RateLimit-*` pauses the route/global limiter; 5xx retries;
  401 is fatal for that bot; 403 is reported as a permission problem.
- Methods cover identity/application, guilds, roles, members, DMs, messages, threads, moderation, roles,
  application-command registration, interaction callbacks and webhook follow-ups.
- Outbound files use multipart; inbound attachments are downloaded immediately from the Discord CDN only
  (`cdn.discordapp.com`, `media.discordapp.net`), 25 MiB per file and 50 MiB per message.

## Routing

| Context | Behavior |
| --- | --- |
| DM | One session per (bot, user). Agent = bot.defaultAgent, else orchestrator, else first enabled agent. |
| Unbound guild channel | Slash commands and `!commands` work. A plain @mention creates a thread from the message and continues there; other messages are ignored. |
| Bound channel | `/bind agent:<id>` routes every message to that agent. `/unbind` clears it. |
| Thread | Created by `/new` or a mention; 1:1 with a durable session. Rename mirrors the thread name; archive closes it. |
| Multiple bots | A binding records the speaker bot; only it answers. Duplicate message ids are suppressed. |

A pruned session self-heals: the next message creates a fresh session and rebinds it. Archived threads are
unarchived before the reply.

## Commands

Native application commands are registered on every READY and after `/reload`, overwriting stale sets.
Text fallbacks (`!help`, `!new`, `!stop`, `!threads`, `!status`, `!model`, `!agent`, `!plan`) cover the
period before global commands propagate.

- Threads: `/new`, `/threads`, `/rename`, `/archive`, `/agent`, `/agents`, `/bind`, `/unbind`.
- Run: `/stop`, `/abort`, `/compact`, `/plan`, `/model`, `/thinking`, `/usage`.
- Data: `/memory`, `/schedules`, `/status`, `/whoami`.
- Owner: `/bots`, `/orchestrator`, `/settings`, `/mcp`, `/prune`, `/reload`, `/restart`, `/connect`,
  `/approve`, `/mod`, `/server`.
- `/invite`, `/ping`, `/help`, `/menu`.

Owner-only commands are registered with `default_member_permissions: "0"` and additionally check the owner id.
Fast commands answer ephemerally. Commands that start an agent reply immediately and stream the answer into a
normal channel message; this avoids relying on the 15-minute interaction webhook window.

## Streaming and formatting

One placeholder is edited in place at `discord.editIntervalMs` (2.5s by default). The existing core activity
stream supplies phase and tool lines. Final answers are converted to Discord Markdown (tables become fenced
code, HTML is stripped) and split at 2,000 characters with open code fences reopened and closed. More than eight
chunks becomes an `answer.md` attachment. `allowed_mentions` is empty by default so an answer cannot ping
`@everyone`, roles or users.

## Questions and approvals

The `question` tool's options become up to five buttons, or a string select for more. Custom ids are
`q:<nonce>:<index>` and expire after 15 minutes; the answer is sent as the next user message. Pending users,
orchestrator claims and kick/ban confirmations use the same component path and check the owner id.

## Moderation

Owner-only `/mod`:

- `timeout` (max 28 days; 0 clears), `kick` and `ban` (confirmation button), `unban`, `warn`, `warnings`, and
  `audit #channel`.
- Every action checks the bot's role position against the target, refuses the guild owner and the bot itself,
  requires a reason and writes an audit line. Warnings persist in `discord/warnings.json`.
- The agent-facing `discord` tool can moderate only when `discord.moderation.agentTools` is enabled; the call
  requires a reason and is audited.

Phase 2 adds config-gated auto-moderation (spam, mass mentions, blocked words, link allowlist, raid gate) and
community flows (welcome, roles, tickets, forum-channel parity). These are off by default and are derived from
the `claude-office-skills/skills` `discord-bot` checklist; that skill is guidance, not runtime code.

## Agent tool

The `discord` tool (installed only while Discord is active and `discord.agentTools` is true) supports:

- `send`, `create_thread`, `archive_thread`, `list_threads`, `server_info`, and `moderate`.
- Channel/thread/guild/user ids are strings; the tool never exposes a token.
- New agents get the tool from the default tool list; `dura chat use discord` appends it to existing agents.

## Setup

`dura init` step 3 chooses the surface. Discord setup:

1. Hidden token prompt (or `DURA_DISCORD_BOTS` / `DURA_DISCORD_TOKEN` / `--discord-token`).
2. `GET /users/@me` and `GET /oauth2/applications/@me`; token and application id stored 0600.
3. Print the invite URL (bot + applications.commands; View Channels, Send Messages, Send Messages in Threads,
   Create Public Threads, Manage Threads, Read Message History, Attach Files, Embed Links, Add Reactions,
   Manage Messages, Moderate Members, Kick Members, Ban Members, View Audit Log).
4. Validate `--owner-id` and save it; try a DM, fall back to invite instructions.
5. Write staged agents, set the bot's default agent, register commands on first READY.

`dura chat use discord` is the explicit switch: it stops the running daemon, checks the target credentials,
changes `chat.active`, adds the `discord` tool to existing agents, restarts, and runs `dura verify`. On failure it
restores the previous surface and restarts it.

## Testing

`scripts/e2e/fake-discord.mjs` serves the REST routes and a real `ws` Gateway (HELLO/IDENTIFY/READY/heartbeat/
RESUME), injects message and interaction events, and records every message, edit, thread, moderation call and
command registration. Scenarios: `discord-init`, `discord-chat`, `discord-thread`, `discord-question`,
`discord-moderation`, `discord-tool`, `discord-verify`, and `chat-exclusive` (proves the inactive surface never
connects).

## Security

- Tokens are never logged, returned to the model, or included in errors; public registry reads mask them.
- Destructive moderation is owner-only with confirmation and role-hierarchy checks; the agent path is opt-in.
- Inbound CDN hosts are allowlisted; files are size-capped; snowflakes are never coerced to Numbers.
- The Gateway is outbound only, so the daemon still has no listening port.
