# Chat surface: composer, tables and memory

Three related surface improvements share one rule: the durable transcript stays the source of truth. Nothing here
adds a second store or a second renderer path.

## Interactive composer

The composer auto-grows from one line to 200px, then scrolls. A small formatting toolbar inserts bold, italic,
inline code, a bullet or a Markdown table at the caret; it restores the selection after Svelte has applied the
text update. Enter sends, Shift+Enter starts a new line, and Cmd/Ctrl+Enter also sends. The toolbar is ordinary
buttons, so it works with a mouse, a keyboard and a phone.

## Tables

Marked tables are wrapped in a scroll container by the renderer. On desktop the table fills the message width,
keeps a sticky header and alternates row surfaces. On a phone the wrapper scrolls horizontally instead of widening
the whole transcript; the message bubble itself never moves sideways. The wrapper is sanitized with the rest of
the Markdown HTML.

## Memory graph

MEMORY.md remains the only memory store. The Memory button in the agent editor reads the latest file and opens a
drawer with two views:

- Graph: one node per note around the agent, a line from the agent to each note, and dashed links between notes
  that share a tag or several significant words. Nodes are numbered; hover or focus lights the connected lines;
  clicking a node opens the full note below. On a phone labels are hidden because the numbered nodes remain
  tappable and the detail panel holds the text.
- List: the same notes as a readable list; selecting one opens it in the graph.

Layout is deterministic and computed once, so there is no animation loop. The graph reads at most 60 notes; the
server already renders the newest 40 into a system prompt.

## Limits

- The graph is derived heuristics, not an agent-authored ontology. Shared tags and words are useful connections,
  not a claim that two facts are logically equivalent.
- The composer toolbar inserts Markdown syntax, not rich text; the transcript stores exactly what was sent.
- Wide tables scroll inside their card by design. There is no column picker or sorting yet.
