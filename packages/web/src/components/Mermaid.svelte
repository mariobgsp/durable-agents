<script module lang="ts">
  let instances = 0;

  type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, text: string) => Promise<{ svg: string }>;
  };

  let library: Promise<MermaidApi> | undefined;

  /**
   * One import and one initialize for the whole page.
   *
   * A thread can hold several diagrams; importing the library once and reusing its renderer keeps the work
   * proportional to the visible diagram, not to the count of diagrams in the transcript.
   */
  function mermaidApi(): Promise<MermaidApi> {
    library ??= import("mermaid").then((module) => {
      const api = module.default as unknown as MermaidApi;
      api.initialize({
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
      return api;
    });
    return library;
  }

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
  import { onMount } from "svelte";

  /**
   * A mermaid diagram with pan and zoom.
   *
   * The library is imported only when the diagram is actually about to render. Inline diagrams wait until
   * they are near the viewport; the Diagram drawer renders exactly one selected diagram at a time.
   */
  let {
    source,
    title = "Diagram",
    lazy = true,
    showActions = false,
  }: {
    source: string;
    title?: string;
    lazy?: boolean;
    showActions?: boolean;
  } = $props();

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 6;

  let root = $state<HTMLElement | undefined>(undefined);
  let visible = $state(false);
  let svg = $state("");
  let failure = $state<string | null>(null);
  let renderSeq = 0;
  let copied = $state(false);

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let scale = $state(1);
  let offsetX = $state(0);
  let offsetY = $state(0);
  let free = $state(false);
  let drag = $state<{ pointerId: number; x: number; y: number } | null>(null);

  $effect(() => {
    if (!lazy) visible = true;
  });

  onMount(() => {
    if (typeof IntersectionObserver === "undefined") {
      visible = true;
      return;
    }
    const element = root;
    if (!element) {
      visible = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        visible = true;
        observer.disconnect();
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!visible) return;
    const text = source;
    const token = ++renderSeq;
    let dead = false;

    void (async () => {
      try {
        const api = await mermaidApi();
        const result = await api.render(nextDiagramId(), text);
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
      event.preventDefault();
      free = true;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      zoomAt(scale * Math.exp(-event.deltaY * unit * 0.0015), event.clientX, event.clientY);
    };
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

  async function copySource(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      copied = true;
      window.setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function downloadSvg(): void {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (title || "diagram").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") + ".svg";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<figure class="diagram" bind:this={root} data-testid="mermaid-diagram">
  <div class="diagram__bar">
    <span class="diagram__label">{title}</span>
    <div class="diagram__tools">
      {#if showActions}
        <button class="btn btn--small btn--ghost" title="Copy Mermaid source" onclick={copySource}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button class="btn btn--small btn--ghost" title="Download as SVG" disabled={!svg} onclick={downloadSvg}>
          SVG
        </button>
      {/if}
      <button class="btn btn--small" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
      <span class="diagram__zoom" data-testid="diagram-zoom">{Math.round(scale * 100)}%</span>
      <button class="btn btn--small" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>+</button>
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