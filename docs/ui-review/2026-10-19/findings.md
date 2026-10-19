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

## Storage panel in `#/usage` (added later the same day)

`#/usage` is not one of the eight routes in `npm run shots`, so this panel was reviewed with a throwaway
DevTools-protocol script: a throwaway E2E server seeded with an agent and two answered threads, the **built**
UI, then the rendered rows and the cleanup line read out of the live DOM before the shutter. Files:

| File | State it proves |
| --- | --- |
| `14-usage-storage-1440x900.png` | the 6 rows, the Cleanup button, the note about the purge; scrolled to the panel |
| `14-usage-storage-390x844.png` | the phone tier: name + bar + share on one line, size + note beneath, and the honest `0 B reclaimed` after a second cleanup |

Measured at both tiers, in the DOM rather than by eye: 6 rows, all rows the same height (no wrapped value),
no clipped note, no `scrollWidth > clientWidth` on the value or the note, and no horizontal overflow. The
Cleanup click reported its measured result (`536 kB reclaimed (818 kB → 282 kB)` in the final run), and a
second click reported `0 B reclaimed — the log was already folded in and there was nothing free to give
back.`

Findings and fixes (two, both the panel's own):

1. **Every part read `undefined B` with a `NaN%` bar.** `GET /api/storage` answers `{ storage: {…} }`, and the
   panel read the response as the report itself. `svelte-check` was clean — the bundled type was a local
   alias, so nothing checked it against the route. Fix: unwrap `body.storage`.
2. **The size column wrapped and the note column ellipsized.** `764.5 kB` broke onto two lines in the 44 px
   value cell at 1440 (and `124 kB` did the same in the 36 px cell at 390), and the longer notes were cut
   with an ellipsis. Fix: the narrow value cell now carries the bar's own number (the share of the total,
   `<0.1%` instead of a printed `0%` when rounding would lie) and the size moved to the wider note cell,
   with byte values rounded from 100 up so the widest string stays short. Re-shot clean at both tiers.

Rubric notes: the rows reuse the page's existing `.usage__row` grid and `.btn` atom, so no new colour, radius
or size entered the system. The plain `.btn` is 39.7 px tall at the phone tier — the same as every other
utility button in the app (`app.css:636`); the ≥44 px target belongs to the phase 10 responsive pass, not to
this panel.

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
