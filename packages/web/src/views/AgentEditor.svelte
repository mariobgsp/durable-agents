<script lang="ts">
  import { api } from "../api.ts";
  import { EMOJI_CHOICES, PALETTE, initialsOf, type Identity } from "../lib/identity.ts";
  import { go } from "../router.svelte.ts";
  import type { ModelInfo, ProviderRow, ThinkingLevel } from "../types.ts";
  import AgentAvatar from "../components/AgentAvatar.svelte";

  let { id }: { id: string } = $props();
  const isNew = $derived(id === "new");

  let name = $state("");
  let agentMd = $state("");
  let soulMd = $state("");
  let responsibility = $state("");
  let tools = $state<string[]>([]);
  let thinkingLevel = $state<ThinkingLevel>("medium");
  let cwd = $state("");
  /**
   * What this agent may do. `standard` refuses the escape hatches (bash, codemode) and keeps file tools
   * inside the agent's root; `full` refuses nothing. A policy boundary, not a sandbox.
   */
  let permissions = $state<"standard" | "custom" | "full">("standard");
  let blockedTools = $state("");
  let allowedPaths = $state("");
  /** Whether the server is inside the hardened unit. The tiers are policy; that unit is the boundary. */
  let sandboxed = $state(true);

  $effect(() => {
    void api
      .health()
      .then((health) => (sandboxed = health.sandboxed))
      .catch(() => undefined);
  });
  let color = $state<string>(PALETTE[0]!);
  let avatar = $state("");
  let provider = $state("");
  let modelId = $state("");
  let providers = $state<ProviderRow[]>([]);
  let models = $state<ModelInfo[]>([]);
  let testResult = $state<string | null>(null);
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const TOOL_CHOICES = [
    { name: "read", label: "read — read files" },
    { name: "write", label: "write — create files" },
    { name: "edit", label: "edit — change files" },
    { name: "bash", label: "bash — run commands" },
    { name: "codemode", label: "codemode — JavaScript that calls the tools" },
  ];

  const selectedModel = $derived(models.find((model) => model.id === modelId) ?? null);
  /** Only the levels this model actually supports: a null entry in its map means unsupported. */
  const levels = $derived(selectedModel?.thinkingLevels ?? ["off", "low", "medium", "high"]);
  const preview = $derived<Identity>({
    id: isNew ? "preview" : id,
    label: name || "Agent",
    color,
    emoji: avatar || undefined,
    kind: "agent",
  });

  $effect(() => {
    void load(id);
  });

  /** Models depend on the provider, so they reload whenever it changes. */
  $effect(() => {
    const wanted = provider;
    if (wanted.length === 0) return;
    void loadModels(wanted);
  });

  async function load(target: string): Promise<void> {
    error = null;
    status = null;
    try {
      const providerList = await api.providers();
      providers = providerList.providers;
      if (target === "new") {
        const { template } = await api.agents();
        agentMd = template.agentMd;
        soulMd = template.soulMd;
        provider = providerList.default.provider;
        modelId = providerList.default.modelId;
        return;
      }
      const files = await api.agent(target);
      name = files.record.name;
      agentMd = files.agentMd;
      soulMd = files.soulMd;
      responsibility = files.record.responsibility ?? "";
      tools = [...files.record.tools];
      thinkingLevel = files.record.thinkingLevel;
      cwd = files.record.cwd ?? "";
      // The effective tier, not the stored one: a record written before tiers existed has none, and the
      // server infers it (an agent that already had bash runs as full until you choose otherwise).
      permissions = files.policy?.tier ?? "standard";
      blockedTools = (files.record.blockedTools ?? []).join(", ");
      allowedPaths = (files.record.allowedPaths ?? []).join(", ");
      color = files.record.color ?? PALETTE[0]!;
      avatar = files.record.avatar ?? "";
      provider = files.record.provider;
      modelId = files.record.modelId;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function loadModels(providerId: string): Promise<void> {
    try {
      const { models: list } = await api.models(providerId);
      models = list;
    } catch {
      models = [];
    }
  }

  function toggleTool(tool: string): void {
    tools = tools.includes(tool) ? tools.filter((item) => item !== tool) : [...tools, tool];
  }

  function shuffleColor(): void {
    const index = PALETTE.indexOf(color);
    color = PALETTE[(index + 1) % PALETTE.length] ?? PALETTE[0]!;
  }

  async function testModel(): Promise<void> {
    busy = true;
    testResult = null;
    error = null;
    try {
      const result = await api.testModel(provider, modelId);
      testResult = result.ok ? "OK · " + result.ms + " ms" : "failed: " + (result.error ?? "unknown");
    } catch (err) {
      testResult = "failed: " + (err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    if (!name.trim()) {
      error = "Agent name is required";
      return;
    }
    busy = true;
    error = null;
    status = null;
    const input = {
      name,
      agentMd,
      soulMd,
      responsibility,
      tools,
      thinkingLevel,
      cwd,
      color,
      avatar,
      permissions,
      blockedTools: blockedTools
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      allowedPaths: allowedPaths
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      provider,
      modelId,
    };
    try {
      if (isNew) {
        const files = await api.createAgent(input);
        go("#/agents/" + files.record.id);
      } else {
        const files = await api.updateAgent(id, input);
        status = "Saved · " + files.rebound + " threads now use the latest files";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function suggest(): Promise<void> {
    busy = true;
    error = null;
    try {
      const { responsibility: suggestion } = await api.suggestResponsibility(soulMd);
      responsibility = suggestion;
      status = "Responsibility suggestion filled from SOUL.md";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (isNew || !window.confirm("Delete this agent?")) return;
    await api.deleteAgent(id);
    go("#/agents");
  }
</script>

<section class="page">
  <header class="page__head">
    <h2 class="page__title">{isNew ? "New agent" : name || id}</h2>
    <div class="page__actions">
      <button class="btn btn--ghost" onclick={() => go("#/agents")}>Back</button>
      {#if !isNew}
        <button class="btn btn--ghost" onclick={remove}>Delete</button>
      {/if}
      <button class="btn btn--primary" disabled={busy} onclick={save} data-testid="save-agent">Save</button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert" data-testid="error">{error}</p>
  {/if}
  {#if status}
    <p class="ok" data-testid="status">{status}</p>
  {/if}

  <div class="editor">
    <div class="editor__docs">
      <label class="field">
        <span>SOUL.md — who it is, its temperament, what it owns</span>
        <textarea bind:value={soulMd} rows="12" data-testid="soul-md"></textarea>
      </label>
      <label class="field">
        <span>AGENT.md — working rules</span>
        <textarea bind:value={agentMd} rows="10" data-testid="agent-md"></textarea>
      </label>
    </div>

    <aside class="editor__side">
      <div class="bezel">
        <div class="bezel__core identity-card">
          <AgentAvatar identity={preview} size="lg" />
          <div class="identity-card__text">
            <b>{name || "Unnamed agent"}</b>
            <span>{avatar || initialsOf(name || "agent")} · {color}</span>
          </div>
        </div>
      </div>

      <label class="field">
        <span>Name</span>
        <input bind:value={name} placeholder="Pirate" data-testid="agent-name" />
      </label>

      <div class="field">
        <span>Colour</span>
        <div class="swatches" data-testid="color-swatches">
          {#each PALETTE as swatch (swatch)}
            <button
              class="swatch"
              class:swatch--active={swatch === color}
              style="--author: {swatch}"
              title={swatch}
              onclick={() => (color = swatch)}
            ></button>
          {/each}
        </div>
        <div class="row">
          <input class="hex" bind:value={color} data-testid="color-hex" />
          <button class="btn btn--small" onclick={shuffleColor}>Shuffle</button>
        </div>
      </div>

      <div class="field">
        <span>Face (emoji)</span>
        <div class="emoji-grid" data-testid="emoji-grid">
          {#each EMOJI_CHOICES as choice (choice)}
            <button
              class="emoji"
              class:emoji--active={choice === avatar}
              onclick={() => (avatar = avatar === choice ? "" : choice)}
            >{choice}</button>
          {/each}
        </div>
        <input bind:value={avatar} placeholder="or type one" data-testid="emoji-input" />
      </div>

      <div class="field">
        <span>Model</span>
        <select bind:value={provider} data-testid="provider-select">
          {#each providers as row (row.id)}
            <option value={row.id}>{row.id}{row.configured ? "" : " (no credentials)"}</option>
          {/each}
        </select>
        <select bind:value={modelId} data-testid="model-select">
          {#if models.length === 0}
            <option value={modelId}>{modelId || "no models available"}</option>
          {/if}
          {#each models as model (model.id)}
            <option value={model.id}>
              {model.id}{model.canSeeImages ? " · images" : " · text only"} · {Math.round(
                (model.contextWindow ?? 0) / 1000,
              )}k
            </option>
          {/each}
        </select>
        {#if selectedModel}
          <p class="hint" data-testid="model-badges">
            {selectedModel.canSeeImages ? "can see images" : "text only"} · context {selectedModel.contextWindow ?? "?"}
            · cost {selectedModel.cost?.input ?? "?"}/{selectedModel.cost?.output ?? "?"} per Mtok
            {#if selectedModel.reasoning}· reasoning{/if}
          </p>
        {/if}
        <div class="row">
          <button class="btn btn--small" disabled={busy || !modelId} onclick={testModel} data-testid="test-model">
            Test model
          </button>
          {#if testResult}
            <span class="hint" data-testid="test-result">{testResult}</span>
          {/if}
        </div>
      </div>

      <label class="field">
        <span>Thinking level</span>
        <select bind:value={thinkingLevel}>
          {#each levels as level (level)}
            <option value={level}>{level}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span>Responsibility (one line, used by Nyahut mode)</span>
        <textarea bind:value={responsibility} rows="2" data-testid="agent-responsibility"></textarea>
      </label>
      <button class="btn" disabled={busy} onclick={suggest} data-testid="suggest-responsibility">
        Suggest from SOUL.md
      </button>

      <fieldset class="tools">
        <legend>Tools</legend>
        {#each TOOL_CHOICES as choice (choice.name)}
          <label class="check">
            <input
              type="checkbox"
              checked={tools.includes(choice.name)}
              onchange={() => toggleTool(choice.name)}
            />
            <span>{choice.label}</span>
          </label>
        {/each}
        {#if tools.includes("bash")}
          <p class="warn">bash runs real commands on this machine.</p>
        {/if}
      </fieldset>

      <label class="field">
        <span>cwd (optional, tool working directory)</span>
        <input bind:value={cwd} placeholder="/home/artut/Projects/…" />
      </label>

      <fieldset class="tools">
        <legend>Permissions</legend>
        <label class="check">
          <input type="radio" value="standard" bind:group={permissions} />
          <span>Standard — no shell or code mode, and files stay inside this agent's root</span>
        </label>
        <label class="check">
          <input type="radio" value="custom" bind:group={permissions} />
          <span>Custom — this agent's tools, minus the ones you block below</span>
        </label>
        <label class="check">
          <input type="radio" value="full" bind:group={permissions} />
          <span>Full Access — no policy at all</span>
        </label>
        {#if permissions === "custom"}
          <label class="field">
            <span>Blocked tools (comma separated, <code>*</code> allowed)</span>
            <input bind:value={blockedTools} placeholder="bash, mcp__*" />
          </label>
          <label class="field">
            <span>Extra allowed paths (comma separated)</span>
            <input bind:value={allowedPaths} placeholder="/home/you/scratch" />
          </label>
        {/if}
        {#if permissions === "full"}
          <p class="warn">
            Full Access refuses nothing. This agent runs as <strong>you</strong>, so it can read your SSH keys,
            your browser profile, and every file you can. {sandboxed
              ? "The systemd unit is still enforcing its own limits."
              : "This server is not inside the sandboxed unit, so nothing is enforcing a limit."}
          </p>
        {:else if !sandboxed}
          <p class="warn">
            Policy only: this server is not inside the sandboxed unit, so a permitted tool still runs with your
            permissions. The tiers decide which tools exist, not what they can reach.
          </p>
        {/if}
      </fieldset>

      <details class="preview">
        <summary>System prompt preview</summary>
        <pre>{[soulMd.trim() ? "## SOUL.md\n\n" + soulMd.trim() : "", agentMd.trim() ? "## AGENT.md\n\n" + agentMd.trim() : ""].filter((part) => part.length > 0).join("\n\n") || "(SOUL.md and AGENT.md are still empty)"}</pre>
      </details>
    </aside>
  </div>
</section>
