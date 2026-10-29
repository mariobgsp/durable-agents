# Telegram transport

## Pollers

One `getUpdates` loop per enabled bot, with its own offset, backoff and health record in `telegram/state.json`.
Each poll is a single 20-second long-poll attempt; 429 honours `retry_after`; failures back off from 1s to 15s;
401/409 stops that bot only. A successful poll clears the health error even when it returns no updates. Shutdown
aborts the in-flight poll instead of waiting out the long poll.

## Routing

- **DM**: the bot's paired agent and its active thread; a reply routes to the message's session. One bot is one
  agent. An unpaired bot offers the owner a pairing prompt and refuses non-owners; it never falls back to another
  agent. The orchestrator can pair/release bots with `bot_assign` / `bot_release`.
- **Topic**: one durable thread per topic.
- **Group**: bound to a durable group thread; only the recorded speaker bot posts room messages, and a
  chatId+messageId seen-map suppresses duplicates when several bots are in the room. `/group mode` keeps the
  nyahut/moderator/silent behaviour.
- Commands bypass the binding. A message during a live run is steered into it and the bot replies
  `Steer · added to the current run`; `/stop` aborts the run and withdraws queued inputs.

## Streaming

Submit → a `Think · …` placeholder, then one short progress line per distinct tool call (up to 20) → wait for the
durable submission → read the transcript. Final answers go through `sendRichMessage` with GFM Markdown
(headings, tables, task lists, code), falling back to HTML `sendMessage` when the API rejects rich messages;
questions keep inline buttons and generated files follow. A message sent while the run is live uses
`whenBusy: "steer"` and answers `Steer · added to the current run`. `/stop` aborts the run and withdraws queued
messages; grouped runs still stream room entries.

The poller uses a 20-second long poll with a single attempt. A successful poll clears the health error even when
it returns no updates, so `dura status` flips back to ok on reconnection; failures back off exponentially to 15s
and retry forever, preserving the update offset.

## Rich formatting

Agent answers are Markdown. When the Bot API supports Rich Messages, they are sent as `rich_message: { markdown }`
so GFM tables, headings, task lists, details and 32k-character messages render structurally; ordinary HTML
`sendMessage` remains the fallback. Formatting rules follow the `telegram-formatting` skill (`nordz0r/skills`),
adapted to this sender: never pre-escape MarkdownV2, keep media as files, and do not force rich markup for plain
prose.

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
