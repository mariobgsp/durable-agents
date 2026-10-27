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

---

## Agent board pass (Phase 16)

> Superseded 2026-10-28: the kanban was replaced by the fleet bubble field (see
> `docs/design/fleet-bubbles.md`). The findings below are kept as the record of that pass; the current
> screenshot gate writes `04-fleet-bubbles` instead of `04-agent-board`.

Step: the Board/List fleet view at `#/agents`. The board screenshots were captured locally at
1440×900, 1280×800, 1024×700, 768×900 and 390×844 and are not checked in because the gate used live owner
agents; the images in this folder are from the earlier pass. Findings from that board review:

| # | Screenshot | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | 04-agent-board-768 | Three columns left roughly 150px per card at 768px, so names, model meta and the action row wrapped or clipped. | Stack the lanes below 1000px; 1024px keeps three columns, 768px gets full-width cards. | Fixed |
| 2 | 04-agent-board-1440 | Empty Working/Disabled lanes collapsed to a short box beside a tall Idle lane, so the board read as three unrelated cards. | Stretch the grid items to the row height; the lanes now share one board surface. | Fixed |
| 3 | 04-agent-board-768, 04-agent-board-1024 | The header summary squeezed between Refresh and New agent and wrapped awkwardly. | Below 900px the header wraps and the summary takes a full line; the primary action stays at the end of the control row. | Fixed |
| 4 | 04-agent-board-390 | The board was stacked correctly, but the card action row mixed the thread count, links and cron without counting singular values. | Use thread/link singular and plural labels; the same pass kept the filter and actions inside the 14px mobile chrome. | Fixed |
| 5 | live working/finishing capture | A pointer drag that disabled an agent left a visible focus ring on the moved card's Enable button. | Restore focus only after a button-driven change; pointer drags move the card without taking focus. | Fixed |
| 6 | 04-agent-board-1024 | The model/policy meta ellipsized at the narrowest three-column width. | Keep it one line with ellipsis; the List view carries the full string, so nothing is lost. | Fixed |

Verified in the same pass: 75/75 screenshots succeeded; the board was readable at all five tiers with no
horizontal page overflow; the Working card showed the observed elapsed time, Working → Disabled produced the
Finishing card while the run continued, completion left a disabled card with no current thread, Enable returned
it to Idle, and an invalid drop into Working produced the refusal notice. `npm run check` was clean,
`npm run e2e` passed 22 scenarios including `board`, and the production build stayed under budget.
