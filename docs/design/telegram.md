# Telegram transport

## Pollers

One `getUpdates` loop per enabled bot, with its own offset, backoff and health record in `telegram/state.json`.
429 honours `retry_after`; 5xx backs off; 401/409 stops that bot only. Shutdown aborts the in-flight poll instead
of waiting out the 50-second long poll.

## Routing

- **DM**: the bot's paired agent and its active thread; a reply routes to the message's session. One bot is one
  agent. An unpaired bot offers the owner a pairing prompt and refuses non-owners; it never falls back to another
  agent. The orchestrator can pair/release bots with `bot_assign` / `bot_release`.
- **Topic**: one durable thread per topic.
- **Group**: bound to a durable group thread; only the recorded speaker bot posts room messages, and a
  chatId+messageId seen-map suppresses duplicates when several bots are in the room. `/group mode` keeps the
  nyahut/moderator/silent behaviour.
- Commands bypass the binding. Busy conversations take follow-ups (configurable steer) and say "queued".

## Streaming

Submit → a single `thinking…` placeholder (no periodic edits) → wait for the durable submission → read the
transcript and replace the placeholder with the final answer, footer, question buttons and generated files.
`/stop` aborts the run and withdraws queued messages; grouped runs still stream room entries.

## Command menu

The bot owns four command scopes (default, private, groups, group administrators). On every start, and after
`/reload`, it deletes the scopes and their `en`/`id` variants before writing the catalog, so a previous
integration's commands cannot survive. The menu button is set to the command list.

| Command | Purpose |
| --- | --- |
| /new, /threads | Thread lifecycle |
| /plan [goal] | Submit a plan-only prompt; the agent plans and does not execute |
| /model | Show the thread/default model; owner gets buttons for the provider's models |
| /usage | Usage report |
| /reload | Owner: reload tools, rebind every agent, resync commands |
| /restart | Owner: confirmation, then a service restart |
| /agents, /memory, /schedules, /group, /bind | Data and groups |
| /status, /whoami, /compact, /abort, /grant | Thread and identity |
| /connect <agent> <token> | Owner: add a bot from a token, pair it and delete the token message |
| /stop | Abort the active run and withdraw every queued message in this chat |
| /orchestrator, /bots, /settings | Owner administration |
| /mcp | Owner: list/add/remove/reload global MCP servers; tools go to every agent |
| /prune [days] | Owner: stale thread preview; delete or purge with confirmation |

## Media and auth

Photos/documents are downloaded to an AttachmentDraft (12 MiB/file, 16 MiB/message, ten files); artifacts are sent
back with sendDocument (≤ 50 MiB). The allowlist is global; unknown users are queued as pending and the owner gets
Approve/Block buttons. A bot cannot add group members, so the CLI creates an invite link and authorises the id.
