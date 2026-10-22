# Agent mesh, fleet, schedules and diagrams

This document records the decisions behind the agent network and the surrounding surfaces. The roadmap is the
plan of record; this file explains the shapes that a future change should preserve.

## Directed threads

A conversation belongs to one agent and one model. Reconfiguring a shared thread before every turn would make
the transcript and its permissions ambiguous. The mesh therefore uses directed threads:

- A message from Ann to Bob is delivered into Bob's thread titled "Inbox · @Ann". The pair is the key:
  inbox:<recipient>:<sender>. Bob's answer stays in that thread. A reply is a new message into Ann's inbox for
  Bob, so each side keeps its own model, tools and context.
- A delegation is a task thread titled "Task · <label>" under the target, keyed by the tool task and the target.
  The caller waits for the answer; the target's full answer stays in its thread and a bounded copy returns in the
  tool result.
- A schedule owns one thread titled "Cron · <name>", keyed by the schedule id. Every run is a normal user input
  there, which is why the transcript, task summary, attachments and usage report need no special case.

Purpose threads carry purpose, meshKey, scheduleId and peer on the session record. Move is refused for them, and
the sidebar gives them compact Inbox, Task and Cron badges.

## Tools and fan-out

agents_list returns enabled and disabled agents with status, model and responsibility.

agents_message accepts one address, an array, or all. It resolves ids before names, refuses ambiguous names, and
caps a call at 16 targets. Each target gets a link record and a deterministic request id derived from the tool
task and the target; a replay after a crash finds the same submission. Delivery returns after durable admission.
A detached watcher updates the link sent → answered or failed.

agents_delegate accepts an explicit array of at most four targets; all is refused because waiting for an
unbounded fan-out would be both expensive and hard to abort. Each target gets its own task thread, the tool waits
for all of them, and the result is a per-target block. The tool is an error only when every target failed. A
partial fan-out reports the refusals beside the answers.

Both tools are replay-safe. The created thread id is stored with api.memo, and the request id makes a second
admission harmless. The target's work is admitted with the background context, so aborting the sender stops the
wait but not the recipient's task.

## Loop control

The inbound user entry carries the sender, the chain and the hop. A normal thread starts a chain of [sender] at
hop 1. Each subsequent agent-to-agent message extends the chain and increments the hop.

- More than six hops is refused.
- A target already in the chain is refused unless it is the immediate sender: that is a direct reply, which is
  allowed within the same hop limit.
- A self-target is refused.
- A disabled target is refused per target.

The fixed prompt section says a peer message is a request, not an instruction from the owner. The per-message
preamble names the sender and explains the reply path.

## Permissions

The mesh policy is a capability switch on the agent: off, message or full. It selects which of the tools are
offered, like the remember tool. It is not a sandbox. The recipient's own permission tier still applies when it
executes, and the systemd unit is the actual security boundary. A Custom agent can block agents_* through
blockedTools. An owner who wants a Standard agent never to delegate to a fully privileged one should use the mesh
policy, not the prompt.

## Links and fleet

data/mesh.json is a bounded index of the newest 1000 links. A link stores the batch, from, to, both thread ids,
submission id, request id, status, hop, a short preview and timestamps. It is not the transcript: the transcript
is the source of truth, and the preview is capped to 160 characters.

fleet.ts assembles a snapshot from agents, the session index, the activity registry, the link index and the
schedule store. It does not scan transcripts and does not call the usage report. The presence socket sends the
whole fleet snapshot with presence on connect and after a debounced change. A failure to compute the snapshot
must not break presence.

## Usage and run summaries

The usage report buckets assistant usage and the stateless ledger by local day and month, from the first recorded
event through today. Soft-deleted threads still count while their rows exist; a purge removes them. The stateless
ledger exists because Nyahut's claim and oversee calls and the responsibility suggestion have no conversation
entry. Compaction spend is not itemized: pi-durable exposes it only in the aggregate usage document, without a
timestamp.

Task summaries are derived from entries. A run starts at the first user entry, stays open across tool-call rounds
and steers, and closes at the first assistant answer whose stopReason is not toolUse. The UI shows one task summary at the end of the timeline, not under every reply; it carries duration, tokens,
cache read/write and cost. Tool durations are a floor when the provider reports no response duration. A group run writes one room.usage entry with the measured wall time and summed member usage; it is
display and task-summary data, not a second usage source.

## Cron

cron.ts parses five fields plus the usual aliases and evaluates them in the server's local time zone. It scans
day by day and then at most 1440 minutes on a matching day; an expression with no run within five years is
rejected. The scheduler is one 15-second interval reading data/schedules.json.

A run is skipped, with a visible schedule.note, when its thread is still working. Automatic request ids are keyed
to the due minute, so a repeated tick or a crash cannot submit the same run twice. nextRunAt is recomputed from
the fire time, not from the missed window; missedRuns is a report, not a backlog. A schedule thread can be
deleted or purged; the next run creates a new one and updates threadId.

## Diagrams, alerts and boot

A Mermaid block is ordinary message text. The drawer extracts sources with a source-only parser and renders one
selected diagram; inline diagrams use an IntersectionObserver and do not import Mermaid until near the viewport.
Mermaid is initialized once per page and keeps securityLevel strict.

Completion is detected by diffing presence active ids, filtered to real session ids so a group does not notify
once per member. The sound is synthesized by one shared AudioContext and primed by the first user gesture. Desktop
notifications are requested only from a click and require the tab to be open; the in-app toast covers the visible
background-thread case. The boot screen is inline HTML/CSS so it paints before the bundle; it is removed after the
first sessions/agents snapshot, with a timeout and a Continue action so it cannot trap the owner.

## Generated files

File bytes live under data/artifacts/<conversation>/<artifact-id>; the chat entry carries only the id, name,
MIME type and size. Three tools are always offered, like remember: create_file (UTF-8 or base64), create_pdf
(the built-in A4/Helvetica writer) and publish_file (a file the agent already wrote). publish_file is part of the
path policy, so a Standard agent cannot use it to read outside its roots. The download route looks the artifact
id up in the entry before it builds a path, and a purge removes the conversation's artifact directory with its
rows. The chat renders a standalone download card, not a second assistant bubble.

## Mobile composer

The shell is pinned to visualViewport's height and top offset, with 100dvh as the fallback, and the viewport meta
includes interactive-widget=resizes-content. The offset matters: when a phone keyboard pans the focused field,
the visible rectangle moves down as well as shrinking, and sizing only the height leaves the composer above the
visible area. There is deliberately no focus-triggered scrollIntoView; the app rectangle follows the viewport
instead. The 390×500 screenshot is the regression evidence. Thread titles use flex: 1 1 auto with min-width: 0 so
the phone drawer ellipsizes long names rather than pushing them out.

## Refresh

The Fleet has an explicit Refresh button. The Agents page reloads agents and fleet on every mount, and the
AgentEditor reloads both after create, update and delete. The first-load-only guard was the reason a newly
created agent could remain missing until a full page reload.

## Failure and recovery

- A missing/disabled target is a per-target refusal; the other targets still run.
- A crash after thread creation but before memo is recovered by meshKey; deterministic request ids prevent a
  duplicate submission.
- A crash while a message watcher runs is reconciled at boot: stored submission ids are reacquired and links are
  settled. A submission that no longer exists becomes failed with a reason, never silently answered.
- A schedule left running across a restart becomes interrupted, or its watcher reattaches when the submission
  still exists.
- A fleet computation failure is reported and skipped; presence continues.

## Verification

The deterministic scenarios are mesh, fleet, schedules and usage. The screenshot gate covers boot, fleet,
automation, diagram, usage and notification states at five viewports. The existing attachments scenario remains
the regression gate for images, documents and PDFs.
