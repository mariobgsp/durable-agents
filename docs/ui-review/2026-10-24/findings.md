# UI review findings

Rubric: docs/ui-review/checklist.md

Step: mobile responsiveness + animation polish (drawer gestures, view transitions, chat micro-motion).

| # | Screenshot | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | 12-notify-390 | The fixed drawer button covered the brand text in the drawer's own header ("DURA-AGENTS" clipped to "…T-AGENTS"); pre-existing, but the button is now the close control so it sits over the drawer permanently. | Clear the header: `.app--drawer .sidebar__head { padding-left: 46px }` at the 720px tier. | Fixed |
| 2 | 03-chat-filled-390 | Scrolling up left no way back to the newest message on a phone; the keyboard-side gap made it worse. | Sticky scroll-to-newest affordance at the end of the timeline (appears past 320px from the bottom, tap pins to the real bottom). | Fixed |
| 3 | all 390 shots | 24px horizontal chrome ate a third of a 390px screen; composer/contextbar/errors carried desktop margins. | 14px chrome padding at the 720px tier for timeline, page, composer, contextbar, error, notice. | Fixed |
| 4 | 05-agent-editor-390, 08-provider-390 | `.cards` minmax(320px) collapsed to cramped single cards below 640px. | 280px floor (same as the fleet grid). | Fixed |
| 5 | (landscape, not in matrix) | Short landscape phones push the composer out of reach once the keyboard opens. | `(max-height: 520px) and (orientation: landscape)`: composer sheds its formatting row, panes trim padding. | Fixed |
| 6 | 12-notify-390 (interaction pass) | Drawer had no gesture: open/close only via button/scrim tap. | Edge-swipe open, drag-the-panel close, pointer-following transform with the settle ease; velocity + 35% thresholds; moved drags swallow the trailing click. | Fixed |
| 7 | 04-agent-list-390 | The drawer button was a text glyph ☰ with no state. | Three hairline bars that fold into an ✕ (transform/opacity only); the button now toggles and carries aria-expanded. | Fixed |
| 8 | (animation pass) | Route changes cut hard; no entrance on the view pane; toasts/chips/notices/system lines popped in without motion; thread lists appeared at once. | Keyed view wrapper with a single 180ms rise per navigation; rise entrances on chip--file, notice, error, sys, toast, notify popover, side drawers (fade backdrop + 24px slide); 30–90ms stagger on thread rows; directional user-bubble entrance; 150ms send-button settle. All opacity+transform, all static under reduced motion (verified by emulation). | Fixed |

## Verified behaviour (headless Chromium, 390×844 touch emulation)

- Edge swipe from the left 28px opens the drawer; the panel follows the finger; release past 35% width or a fast flick commits, anything else settles back.
- Dragging the open panel (or the scrim) leftwards closes it; tap on the scrim closes; the ✕ button toggles both ways.
- A moved drag swallows the click that would otherwise land under the released finger (no accidental thread opens).
- Thread tap navigates, closes the drawer, and the pane plays its entrance; the timeline pins to the newest message (content-visibility estimates chased to convergence).
- `prefers-reduced-motion: reduce`: every entrance/stagger/morph computes to `none`; information stays in text.
- No horizontal overflow at 390px on any shot; `.timeline`/`.page` keep native vertical scroll (`touch-action: pan-y`), tables keep their horizontal wrapper scroll.

## Gates

- `npm run check` — tsc + svelte-check (0 errors, 0 warnings) + language lint clean.
- `npm run e2e` — 21 passed, 0 failed.
- `npm run build` — clean production build.
