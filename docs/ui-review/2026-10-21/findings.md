# UI review findings

Rubric: [docs/ui-review/checklist.md](../checklist.md)

Gate: **70 screenshots** — 14 routes × 5 viewports (1440×900, 1280×800, 1024×700, 768×900, 390×844).
Supplementary E2E evidence: twelve screenshots from a throwaway faux-provider server, so the link batch,
run footer, generated files and stateless usage are real data rather than a hand-written mock.

| # | Screenshot | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | [03b-run-summary-1440x900.png](03b-run-summary-1440x900.png) | A faux tool run first showed "Worked 0ms" because the provider did not report a response duration; the tool itself had a measured 599ms. | The run summary now uses the longest tool duration as a floor, and shows "Duration unavailable" instead of 0 when there is no evidence. The seeded thread reads "Worked 8.2s". | Fixed |
| 2 | [05b-agent-automation-1440x900.png](05b-agent-automation-1440x900.png) | The schedule list/form was cramped in the editor's 300px side column and sat far below the fold. | Automation is a full-width disclosure directly under the editor header; the normal editor shows a single collapsed line. | Fixed |
| 3 | [11-usage-1440x900.png](11-usage-1440x900.png) | The per-agent note ("today … cached … $…") was ellipsized at 1440px. | The usage row's last column widened to 180–240px at desktop; the phone tier still wraps the note under the number. | Fixed |
| 4 | [12-notify-390x844.png](12-notify-390x844.png) | The phone popover was clipped when photographed with the off-canvas drawer closed; a fixed child inside a transformed ancestor is positioned against that ancestor. | The phone deep link opens the drawer (a real user opens it before tapping the bell), and under 720px the popover is a viewport-fixed panel. The desktop popover opens to the right of the bell. | Fixed |
| 5 | [04-agent-list-390x844.png](04-agent-list-390x844.png) | The fleet title, summary, Refresh and New agent button competed for one row at 390px; a newly created agent could also remain invisible because the page reloaded agents only when the store was empty. | The fleet header wraps: title, then Refresh plus New agent, then the status line. The page reloads agents and fleet on every mount; the Fleet Refresh button reloads both; the editor reloads them after create/update/delete. | Fixed |
| 6 | [10-diagram-1440x900.png](10-diagram-1440x900.png) | The drawer list used the Mermaid declaration ("flowchart LR") as a title. | Only an explicit %% title is used; otherwise the item is "Diagram 1", "Diagram 2", and so on. | Fixed |
| 7 | [00-boot-1440x900.png](00-boot-1440x900.png) | No finding: the boot screen paints before the bundle, is centred at every tier and disappears after the initial lists load. | — | Verified |
| 8 | [e2e-fleet-links.png](e2e-fleet-links.png) | No finding: a real Ann → Bob/Chef delegation batch is visible, both targets show their link count and the batch reads "delegate ANSWERED". The 390px variant keeps all three cards and the link section. | — | Verified |
| 9 | [e2e-chat-run-summary.png](e2e-chat-run-summary.png) | No finding: the tool line, inline diagram, "Worked 1.9s · 2,788 tokens · 855 cached" footer and the session total agree. | — | Verified |
| 10 | [e2e-usage-stateless.png](e2e-usage-stateless.png) | No finding: per-agent rows, the agents_delegate tool row and the cached/stateless totals are visible and legible. | — | Verified |
| 11 | [e2e-generated-files.png](e2e-generated-files.png) | No finding: create_file and create_pdf produce standalone download cards for Markdown and PDF; the tool trace remains as the audit line. | — | Verified |
| 12 | [e2e-generated-files-390.png](e2e-generated-files-390.png) | No finding: both file cards fit at 390px and the download arrows remain tappable. | — | Verified |
| 13 | [mobile-composer-390x500.png](mobile-composer-390x500.png) | A shorter phone layout could hide the composer below the keyboard or fold; a 390×500 viewport is a hard case. | The shell follows visualViewport, the viewport meta requests keyboard content resizing, the composer is sticky above the safe area, and focus scrolls it into the remaining visible area. | Verified |
| 14 | [e2e-chat-table.png](e2e-chat-table.png) | No finding: the desktop table fills the message, keeps a sticky header and zebra rows. | — | Verified |
| 15 | [e2e-chat-table-390.png](e2e-chat-table-390.png) | A four-column table could widen the phone transcript or squash every cell. | Marked tables are wrapped in a scroll container; the message card stays fixed and the table scrolls inside it. | Fixed |
| 16 | [e2e-memory-graph.png](e2e-memory-graph.png) | No finding: seven memory notes form a connected graph around the agent, with three dashed related-note links and full detail on selection. | — | Verified |
| 17 | [e2e-memory-graph-390.png](e2e-memory-graph-390.png) | No finding: the phone graph keeps numbered nodes and hides labels; tapping opens the full note below. | — | Verified |
| 18 | [e2e-memory-header-390.png](e2e-memory-header-390.png) | The new Memory button pushed Save off the right edge at 390px. | The editor header wraps the title onto its own line and lets Back, Memory, Delete and Save share the next row. | Fixed |

Review notes:

- Four polish rounds were used: automation placement, run duration and the phone fleet header; then the
  notification popover, usage note column and diagram titles; then the Refresh path, generated-file cards and
  the 390×500 composer; then table scrolling, the composer toolbar, the memory graph and the mobile editor header.
- The phone tier has no horizontal overflow in the reviewed routes; the long agent names and task titles
  truncate with an ellipsis and the row action menus remain reachable.
- The diagram drawer renders one Mermaid diagram at a time. Inline diagrams still render in the thread, but only
  after an IntersectionObserver says they are near the viewport.
