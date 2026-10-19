# Screenshot review rubric

Used every time screenshots are taken. Each finding must be written as **what is missing** plus a
**concrete fix** — never "looks good".

## How to take them
```
npm run shots            # 8 routes x 5 viewports -> docs/ui-review/<date>/
npm run shots:replying   # the "replying" indicator, on a throwaway E2E server
```

The viewports are 1440x900, 1280x800, 1024x700, 768x900 and 390x844. The last two are the ones that
actually prove the responsive layout — without them a broken mobile drawer looks identical to a working one.

## What is judged
1. **Hierarchy and type scale** — titles 15–28 px, body 14 px, meta 12–13 px; nothing crammed.
2. **Spacing** — only 4/8/12/16/24 px; consistent panel padding; nothing glued to an edge.
3. **Label contrast** — muted text stays readable on panels; role badges do not sink into the background.
4. **Empty states** — "no threads yet", "empty", "reconnecting" exist and suggest the next step, and the
   hero empty state uses the double-bezel (outer shell + inner core).
5. **Error states** — errors appear where they can be seen and never cover the composer.
6. **Language** — every label is English (the app is English-only); no leftover template text, no
   Indonesian in system UI. `npm run lint:lang` must stay clean.
7. **1024×700** — no horizontal overflow, the sidebar keeps its width, the composer stays visible.
8. **768×900** — the agent editor collapses to one column; nothing overflows horizontally.
9. **390×844 (mobile)** — the ☰ appears, the sidebar is off-canvas, the drawer opens on tap, nothing
   overflows horizontally, tap targets ≥40 px.
10. **Animation** — per the **Animation** rule in `docs/roadmap.md` (one source of truth; the state-change
    limits and the live-indicator rules both live there). Continuous motion: at most one sweep per
    indicator, at most one animated element per tool row, no idle motion, fully static under reduced
    motion. Nothing else moves.
11. **Consistency** — radii come from the scale (`--r-sm` 10 px, `--r-md` 14 px, `--r-lg` 20 px), never a
    hardcoded 8 px; separation is a hairline ring (`var(--line)`) or an inset highlight, never a 1 px solid
    grey border; colours come from the `app.css` variables; no new hardcoded colours; the mono stack is
    `var(--font-mono)` (Geist Mono).
12. **Replying indicator** — at most one per frame: dots on every sidebar row for a thread generating
    elsewhere, and in the chat either the phase bubble or the round strip, never both.

## Output files
- `docs/ui-review/<date>/<nn>-<name>-<viewport>.png` — one file per route per viewport
- `docs/ui-review/<date>/09-replying-*.png` — the replying indicator, from `npm run shots:replying`
- `docs/ui-review/<date>/manifest.json`
- `docs/ui-review/<date>/findings.md` — findings plus fix status (at most 2 polish rounds)
