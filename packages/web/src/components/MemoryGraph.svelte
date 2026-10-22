<script lang="ts">
  /**
   * Memory, as a graph.
   *
   * MEMORY.md is a plain list of durable notes. This view turns each note into a numbered node around the
   * agent, draws a line from the agent to every note, and adds soft links between notes that share a tag or
   * enough significant words. The points are laid out once, so the view costs no animation loop and stays
   * smooth with the 40-note render limit the server already uses.
   */
  let { agentName, memoryMd }: { agentName: string; memoryMd: string } = $props();

  type Note = {
    id: number;
    text: string;
    tags: string[];
    words: Set<string>;
    x: number;
    y: number;
    ring: number;
  };

  type Edge = { a: number; b: number; kind: "root" | "link"; score: number };

  const STOP = new Set(
    "about above after again against agent also although always another answer around because been before being below between both could does doing done down each even every first from further have having here into just know like make many more most much must need never only other over same should some still such than that their them then there these they thing this those through under until very want were what when where which while will with without would your".split(
      " ",
    ),
  );

  function notesOf(markdown: string): string[] {
    const lines = markdown.split(/\r?\n/);
    const bullets = lines
      .map((line) => line.trim())
      .filter((line) => /^[-*+]\s+/.test(line))
      .map((line) => line.replace(/^[-*+]\s+/, "").trim())
      .filter(Boolean);
    if (bullets.length > 0) return bullets;
    return lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .slice(0, 60);
  }

  function wordsOf(text: string): Set<string> {
    const words = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [];
    return new Set(words.filter((word) => !STOP.has(word)));
  }

  function tagsOf(text: string): string[] {
    return [...text.matchAll(/(^|\s)#([a-z0-9_-]{2,})/gi)]
      .map((match) => match[2]?.toLowerCase())
      .filter((tag): tag is string => Boolean(tag));
  }

  function short(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
  }

  const model = $derived.by(() => {
    const width = 820;
    const height = 560;
    const cx = width / 2;
    const cy = height / 2;
    const raw = notesOf(memoryMd).slice(0, 60);
    const notes: Note[] = raw.map((text, index) => {
      const inner = raw.length <= 12 || index < 10;
      const radius = raw.length <= 12 ? 190 : inner ? 158 : 238;
      const count = raw.length <= 12 ? Math.max(1, raw.length) : inner ? Math.min(10, raw.length) : raw.length - 10;
      const offset = raw.length <= 12 ? 0 : inner ? 0 : 10;
      const angle = -Math.PI / 2 + ((index - offset + 0.5) / Math.max(1, count)) * Math.PI * 2;
      return {
        id: index,
        text,
        tags: tagsOf(text),
        words: wordsOf(text),
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        ring: inner ? 0 : 1,
      };
    });

    const edges: Edge[] = notes.map((note) => ({ a: -1, b: note.id, kind: "root", score: 1 }));
    const candidates: Edge[] = [];
    for (let a = 0; a < notes.length; a += 1) {
      for (let b = a + 1; b < notes.length; b += 1) {
        const one = notes[a];
        const two = notes[b];
        if (!one || !two) continue;
        const sharedTags = one.tags.filter((tag) => two.tags.includes(tag)).length;
        let sharedWords = 0;
        for (const word of one.words) if (two.words.has(word)) sharedWords += 1;
        if (sharedTags === 0 && sharedWords < 2) continue;
        candidates.push({ a, b, kind: "link", score: sharedTags * 3 + sharedWords });
      }
    }
    candidates.sort((one, two) => two.score - one.score);
    const degree = new Map<number, number>();
    for (const candidate of candidates) {
      const da = degree.get(candidate.a) ?? 0;
      const db = degree.get(candidate.b) ?? 0;
      if (da >= 2 || db >= 2) continue;
      degree.set(candidate.a, da + 1);
      degree.set(candidate.b, db + 1);
      edges.push(candidate);
    }
    return { width, height, cx, cy, notes, edges };
  });

  let hovered = $state<number | null>(null);
  let selected = $state<number | null>(null);
  let mode = $state<"graph" | "list">("graph");

  const activeId = $derived(hovered ?? selected);
  const selectedNote = $derived(model.notes.find((note) => note.id === selected) ?? null);

  function connected(edge: Edge): boolean {
    return activeId === null || edge.a === activeId || edge.b === activeId;
  }

  function relatedCount(note: Note): number {
    return model.edges.filter((edge) => edge.kind === "link" && (edge.a === note.id || edge.b === note.id)).length;
  }

  function choose(id: number): void {
    selected = selected === id ? null : id;
  }
</script>

<div class="memory" data-testid="memory-graph">
  <div class="memory__head">
    <div class="memory__tabs" role="tablist" aria-label="Memory view">
      <button
        class="memory__tab"
        class:memory__tab--active={mode === "graph"}
        role="tab"
        aria-selected={mode === "graph"}
        onclick={() => (mode = "graph")}
      >Graph</button>
      <button
        class="memory__tab"
        class:memory__tab--active={mode === "list"}
        role="tab"
        aria-selected={mode === "list"}
        onclick={() => (mode = "list")}
      >List</button>
    </div>
    <span class="hint">{model.notes.length} notes · {model.edges.filter((edge) => edge.kind === "link").length} links</span>
  </div>

  {#if model.notes.length === 0}
    <p class="empty">No memory yet. Ask the agent to remember something, or let it decide a fact is durable.</p>
  {:else if mode === "graph"}
    <div class="memory__canvas" data-testid="memory-canvas">
      <svg viewBox="0 0 {model.width} {model.height}" role="img" aria-label={"Memory graph for " + agentName}>
        <g class="memory__edges">
          {#each model.edges as edge (edge.kind + ":" + edge.a + ":" + edge.b)}
            <line
              class:memory__edge--active={activeId !== null && (edge.a === activeId || edge.b === activeId)}
              class:memory__edge--link={edge.kind === "link"}
              class:memory__edge--dim={activeId !== null && !connected(edge)}
              x1={edge.a === -1 ? model.cx : model.notes[edge.a]?.x ?? model.cx}
              y1={edge.a === -1 ? model.cy : model.notes[edge.a]?.y ?? model.cy}
              x2={model.notes[edge.b]?.x ?? model.cx}
              y2={model.notes[edge.b]?.y ?? model.cy}
            />
          {/each}
        </g>

        <g class="memory__center">
          <circle cx={model.cx} cy={model.cy} r="38"></circle>
          <text x={model.cx} y={model.cy + 4} text-anchor="middle">{agentName.trim().slice(0, 2).toUpperCase() || "A"}</text>
          <text class="memory__center-label" x={model.cx} y={model.cy + 57} text-anchor="middle">{short(agentName, 24)}</text>
        </g>

        {#each model.notes as note, index (note.id)}
          <g
            class="memory__node"
            class:memory__node--active={activeId === note.id}
            class:memory__node--selected={selected === note.id}
            class:memory__node--dim={activeId !== null && activeId !== note.id && !model.edges.some((edge) => edge.kind === "link" && ((edge.a === activeId && edge.b === note.id) || (edge.b === activeId && edge.a === note.id)))}
            role="button"
            tabindex="0"
            aria-label={"Memory " + (index + 1) + ": " + note.text}
            onmouseenter={() => (hovered = note.id)}
            onmouseleave={() => (hovered = null)}
            onfocus={() => (hovered = note.id)}
            onblur={() => (hovered = null)}
            onclick={() => choose(note.id)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                choose(note.id);
              }
            }}
          >
            <circle cx={note.x} cy={note.y} r={note.ring === 0 ? 14 : 12}></circle>
            <text class="memory__number" x={note.x} y={note.y + 3.5} text-anchor="middle">{index + 1}</text>
            <text class="memory__label" x={note.x + (note.x >= model.cx ? 18 : -18)} y={note.y + 4} text-anchor={note.x >= model.cx ? "start" : "end"}>
              {short(note.text, 26)}
            </text>
          </g>
        {/each}
      </svg>
    </div>
    <p class="memory__hint">
      {#if selectedNote}
        Selected note {selectedNote.id + 1} · {relatedCount(selectedNote)} related link{relatedCount(selectedNote) === 1 ? "" : "s"}
      {:else}
        Hover a node to light its lines; tap a node to read the full note.
      {/if}
    </p>

    {#if selectedNote}
      <div class="memory__detail" data-testid="memory-detail">
        <div class="memory__detail-head">
          <b>Note {selectedNote.id + 1}</b>
          {#if selectedNote.tags.length > 0}
            <span class="memory__tags">{#each selectedNote.tags as tag}<span>#{tag}</span>{/each}</span>
          {/if}
        </div>
        <p>{selectedNote.text}</p>
      </div>
    {/if}
  {:else}
    <ol class="memory__list">
      {#each model.notes as note, index (note.id)}
        <li>
          <button class="memory__list-item" onclick={() => { selected = note.id; mode = "graph"; }}>
            <span class="memory__list-index">{index + 1}</span>
            <span>{note.text}</span>
            {#if note.tags.length > 0}<span class="memory__tags">{#each note.tags as tag}<span>#{tag}</span>{/each}</span>{/if}
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</div>