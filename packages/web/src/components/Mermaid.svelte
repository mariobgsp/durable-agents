<script module lang="ts">
  let instances = 0;

  /**
   * `mermaid.render` measures the diagram through a temporary element in the document, so the id has to be
   * unique per call. A module counter does that without Math.random in the DOM.
   */
  function nextDiagramId(): string {
    instances += 1;
    return "diagram-" + instances;
  }
</script>

<script lang="ts">
  /**
   * A mermaid diagram with pan and zoom.
   *
   * The library is imported inside the render effect: a thread with no diagram must not pull hundreds of
   * kilobytes into the initial bundle. `securityLevel: "strict"` is not optional here — the source comes from
   * a model, and strict mode keeps its labels as text instead of letting it inject HTML or click handlers.
   *
   * Scaling and panning are plain transform math on a wrapper; the existing global reduced-motion rule in
   * app.css removes the transition, so a zoom snaps instead of gliding for anyone who asked for that.
   */
  let { source }: { source: string } = $props();

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 6;

  let svg = $state("");
  let failure = $state<string | null>(null);
  let renderSeq = 0;

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let scale = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  /** True while a gesture owns the transform, so the CSS transition cannot lag behind the pointer. */
  let free = $state(false);
  let drag = $state<{ pointerId: number; x: number; y: number } | null>(null);

  $effect(() => {
    const text = source;
    const token = ++renderSeq;
    let dead = false;

    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "dark",
          fontFamily: "Geist Variable, system-ui, sans-serif",
          themeVariables: {
            background: "#0a0b0d",
            primaryColor: "#131519",
            primaryTextColor: "#ecedef",
            primaryBorderColor: "#e0a35c",
            lineColor: "#8b9096",
            secondaryColor: "#131519",
            tertiaryColor: "#0a0b0d",
          },
        });
        const result = await mermaid.render(nextDiagramId(), text);
        if (!dead && token === renderSeq) {
          svg = result.svg;
          failure = null;
        }
      } catch (error) {
        if (!dead && token === renderSeq) {
          svg = "";
          failure = error instanceof Error ? error.message : String(error);
        }
      }
    })();

    return () => {
      dead = true;
    };
  });

  function clampScale(value: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  /** Zoom about a point: the diagram pixel under the cursor stays under the cursor. */
  function zoomAt(nextScale: number, clientX: number, clientY: number): void {
    const element = viewport;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = clampScale(nextScale);
    const ratio = next / scale;
    offsetX = px - (px - offsetX) * ratio;
    offsetY = py - (py - offsetY) * ratio;
    scale = next;
  }

  $effect(() => {
    const element = viewport;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      // The timeline scrolls vertically; a wheel over the diagram is a zoom, never a page scroll.
      event.preventDefault();
      free = true;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      zoomAt(scale * Math.exp(-event.deltaY * unit * 0.0015), event.clientX, event.clientY);
    };
    // Non-passive, because the browser's default wheel listener cannot prevent the page from scrolling.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    free = true;
    drag = { pointerId: event.pointerId, x: event.clientX - offsetX, y: event.clientY - offsetY };
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    offsetX = event.clientX - drag.x;
    offsetY = event.clientY - drag.y;
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    const element = event.currentTarget as HTMLElement;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  }

  function zoomBy(factor: number): void {
    const element = viewport;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    free = false;
    zoomAt(scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function resetView(): void {
    free = false;
    scale = 1;
    offsetX = 0;
    offsetY = 0;
  }
</script>

<figure class="diagram" data-testid="mermaid-diagram">
  <div class="diagram__bar">
    <span class="diagram__label">Diagram</span>
    <div class="diagram__tools">
      <button class="btn btn--small" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>
        −
      </button>
      <span class="diagram__zoom" data-testid="diagram-zoom">{Math.round(scale * 100)}%</span>
      <button class="btn btn--small" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>
        +
      </button>
      <button class="btn btn--small btn--ghost" title="Reset the view" onclick={resetView}>Reset</button>
    </div>
  </div>

  <div
    class="diagram__viewport"
    class:diagram__viewport--dragging={drag !== null}
    class:diagram__viewport--pinned={scale > 1}
    bind:this={viewport}
    role="group"
    aria-label="Diagram viewport, drag to pan"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerEnd}
    onpointercancel={onPointerEnd}
    data-testid="diagram-viewport"
  >
    {#if svg}
      <div
        class="diagram__canvas"
        class:diagram__canvas--free={free}
        style="transform: translate({offsetX}px, {offsetY}px) scale({scale})"
      >
        {@html svg}
      </div>
    {:else if failure}
      <p class="diagram__error" role="alert">This diagram could not be rendered: {failure}</p>
      <pre class="diagram__source"><code>{source}</code></pre>
    {:else}
      <p class="diagram__loading">Rendering diagram…</p>
    {/if}
  </div>
</figure>
