# UI review — 2026-10-19

Scope: image and document attachments, the live activity indicator, and the tool-call motion. Screenshots
from `npm run shots:replying` (the throwaway E2E server, the only way to hold a real phase open). Each phase
shot waits for the matching `activity` frame on its own socket, so the shutter sees what the server reported
rather than what a stopwatch guessed.

| File | State it proves |
| --- | --- |
| `09-replying-{sidebar,chat}-1440x900.png`, `09-replying-chat-390x844.png` | the presence dots, unchanged |
| `11-attachments-chat-1440x900.png`, `11-attachments-chat-390x844.png` | an image, a document card, a truncated card and an omitted card |
| `10-activity-thinking-1440x900.png` | the phase bubble: "Thinking" + sweep + elapsed |
| `10-activity-tool-{1440x900,390x844}.png` | the round strip: "Using a tool · 1 running · 5.5s" over the `bash` row |
| `12-static-thinking-1440x900.png` | the same phase with `--force-prefers-reduced-motion`: words only |

## Findings and fixes

Round 1 (four findings, all fixed in the same session):

1. **The truncated document card said the same thing twice** — "40,000 characters· truncated" (with the
   separator glued to the count) above "only the first 40,000 of 120,000 characters were sent".
   Fix: the reason line carries the numbers, so the meta suffix is gone for `truncated` and `omitted`
   (only `pending` keeps "· sending", which has no reason line).
2. **A loaded image pushed the newest message under the composer.** An attachment's height is only known
   once its bytes arrive, so the scroll position set when the entries rendered was stale.
   Fix: the timeline re-pins on `load` in the capture phase (`Chat.svelte:onTimelineLoad`), because a `load`
   event does not bubble.
3. **The bubble form showed no elapsed time.** The strip had it, the bubble did not, so the reduced-motion
   state lost the one number that says how long this has been going on.
   Fix: `ActivityIndicator` takes an `elapsed` string; the bubble and the live bubble both pass it from the
   run's own start.
4. **Under reduced motion the sweep froze into a bar in an arbitrary position** — a shape that can be read
   as progress, which the roadmap's rule forbids outright.
   Fix: `prefers-reduced-motion` now hides `.activity__sweep` and `.toolcall__sweep` entirely; the phase
   word, the counts and the elapsed time say everything they were saying.

Round 2 (verified by re-shooting, not asserted): `12-static-thinking-1440x900.png` shows "Thinking 8.4s"
with no motion; `11-attachments-chat-390x844.png` shows the last card fully above the composer and the
separator fix. No further findings.

## Rubric notes

- **Item 10 (animation)**: only `opacity` + `transform` are animated, inside fixed-size clipped boxes; the
  sweep is indeterminate by construction and there is no percentage anywhere. At most one animated element
  per tool row while three or fewer calls are in flight, and one round-level sweep instead past that.
- **Item 11 (consistency)**: no new hardcoded colour or radius; the sweep uses `currentColor` and
  `--accent`, the strip uses `--muted`, cards use `--panel` and `--line`.
- **Item 12 (one indicator)**: `activityRender()` is the single decision point; the strip wins when there
  are calls to list, the bubble otherwise, and the sidebar only ever shows the dots.
- **Not photographed**: the `starting` phase (the window between accepting a message and the first block is
  under a publish interval, so a deterministic shot is not available), and the `queued` label (it needs a
  second message posted mid-round, which the E2E scenario asserts instead of a screenshot).
