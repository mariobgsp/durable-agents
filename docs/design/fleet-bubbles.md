# Fleet bubbles

The Agents tab draws the fleet snapshot twice: **List** is the compact roster with the agent-to-agent link feed,
and **Bubbles** gives every agent one card whose shape and light carry the state. Bubbles are the default; the
switch and the saved preference keep List one click away.

There is no kanban. The previous board grouped agents into Working / Idle / Disabled lanes and let the owner drag
a card between two of them. That interaction was always a polite fiction: Working is reported by a run, never
chosen, and a drag could only write the agent's enabled flag anyway. A lane implies a place a card belongs; a
bubble implies a state, which is what the server actually knows.

## What a bubble says

- **Identity**: avatar, name, @id, and the agent's own colour around the avatar.
- **State**: working, idle or disabled, with the run's elapsed time while it is generating.
- **What it is doing**: a link to the current thread (Finishing instead of Working when a disabled agent still
  has a run in flight), the count of other active threads, or the last-active time when idle.
- **Facts**: threads owned, active links over total links, enabled cron schedules over total, and today's tokens
  when the usage report has loaded.
- **Model line**: provider/model, permission tier and mesh mode, as small chips.
- **Next cron**: the next scheduled run and its name, or the reason there is none.
- **Actions**: Open or Start thread, Disable or Enable, Edit. All are buttons; nothing requires a pointer gesture.

The legend above the field repeats the counts and the longest-running work, so the page answers "is anything
stuck?" without reading every bubble.

## Where the data comes from

Everything is derived from **GET /api/fleet** and the presence socket's fleet frames, exactly as List is. A
bubble never invents state: the server's activity registry decides working, the agent's enabled flag decides
disabled, and disabled wins while a run finishes. Ordering is derived too: working longest-first, idle by most
recent activity, disabled by name. No order is stored anywhere.

## Motion and cost

The breathing ring exists only on a working bubble, and the one-second clock that drives elapsed labels exists
only while at least one thread is active. An idle fleet is completely still. Under **prefers-reduced-motion** the
ring and the hover lift are removed, and the state remains legible from the word, the dot and the elapsed text.

## Layout

The field is a responsive grid: four or more bubbles beside the 216 px sidebar on a wide screen, three at
1024 px, two at 768 px and one at 390 px. The four facts share a dashed rule and keep tabular numbers, so a
bubble's height does not jump as counts change. Tap targets are 40 px on coarse pointers.

## Availability

Disabling writes the agent's enabled flag through the existing **POST /api/agents/:id/enabled** route. A run
already in flight continues and the bubble says Finishing; the response is a fresh fleet snapshot on the
presence socket, so every open view updates without a refresh. Re-enabling is the same call with the opposite
value, and the bubble returns to Idle.

## Tests

The deterministic **bubbles** scenario creates an enabled and a disabled agent, asserts the three states, moves
Disabled to Idle, disables an agent mid-run and checks that the run survives and is reported as disabled, waits
for it to finish, then re-enables it. The screenshot gate captures the field at 1440, 1280, 1024, 768 and 390
px as **04-fleet-bubbles**.
