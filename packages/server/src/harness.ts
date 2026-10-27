import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { Harness, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { listAgents } from "./agents.ts";
import type { CodemodeSandbox, CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { models } from "./models.ts";
import { permissionsExtension } from "./permissions.ts";
import { questionTool } from "./questions.ts";
import { meshToolsExtension } from "./mesh-tools.ts";
import { fileToolsExtension } from "./file-tools.ts";
import { displayToolsExtension } from "./customize-ui.ts";
import { rememberTool } from "./remember.ts";
import { webSearchTool } from "./search.ts";
import { dataDir, dbPath } from "./paths.ts";

/** Extension registry shared by every session. */
export const registry: Registry = createRegistry();

// read/write/edit/bash are installed inside openHarness(): the coding tools want an image processor, which is
// loaded asynchronously (Photon, in a worker thread). Code mode is installed by installCodemode() instead.

/** Root server context: lives as long as the process, never cancelled. */
export const context = BACKGROUND_CONTEXT;

let instance: Harness | undefined;
/**
 * The one image processor this process uses: `read` needs it, and so does an attachment upload. Sharing it
 * means one worker thread and one set of rules (decode, honour EXIF, resize to the model's own limits).
 */
/**
 * The image processor, built the first time an image actually needs one.
 *
 * Photon loads a WebAssembly module and starts a worker thread; doing that at boot costs about 6.5 MB measured,
 * in a process that may never read or receive an image. The wrapper is the same interface, so the `read` tool
 * and the upload path cannot tell the difference — and neither of them has to care whether it exists yet.
 */
let realImages: ImageProcessor | undefined;
async function photon(): Promise<ImageProcessor> {
  realImages ??= await createNodePhotonImages();
  return realImages;
}

const lazyImages: ImageProcessor = {
  prepare: async (bytes, mimeType, limits) => (await photon()).prepare(bytes, mimeType, limits),
};

export function imageProcessor(): ImageProcessor {
  return lazyImages;
}

/**
 * The QuickJS sandbox module, loaded by the first script that runs.
 *
 * Importing `@earendil-works/pi-codemode` pulls in the worker launcher, the inline sandbox and `quickjs-wasi`, none
 * of which is needed until a script runs. `start()` hands back a run synchronously, so the sandbox itself cannot
 * await an `import()`: the `codemode-loader` wrapper below loads the module before it delegates, and `start()` then
 * finds the class ready.
 *
 * The type is the real `CodemodeSandboxBase`, so the forwarding proxy below is checked against the package's own
 * interface instead of a hand-written guess.
 */
let SandboxClass: typeof CodemodeSandbox | undefined;
let realSandbox: CodemodeSandboxBase | undefined;

async function loadCodemodeSandbox(): Promise<void> {
  if (SandboxClass) return;
  const imported = await import("@earendil-works/pi-codemode");
  SandboxClass = imported.CodemodeSandbox;
}

function codemodeSandbox(): CodemodeSandboxBase {
  if (!SandboxClass) throw new Error("the codemode sandbox was used before its module was loaded");
  realSandbox ??= new SandboxClass({ memoryLimitBytes: 256 * 1024 * 1024 });
  return realSandbox;
}

const lazySandbox: CodemodeSandboxBase = new Proxy({} as CodemodeSandboxBase, {
  get: (_target, property) => {
    const sandbox = codemodeSandbox();
    const value: unknown = Reflect.get(sandbox, property);
    return typeof value === "function" ? value.bind(sandbox) : value;
  },
});

/**
 * Code mode, installed only for an agent that lists `codemode`.
 *
 * The extension itself drags in the whole sandbox graph — `pi-durable/codemode` → `pi-codemode/portable` →
 * `inline` → `vm` → `quickjs-wasi` — for a tool most agents never call. Registering it lazily keeps that graph
 * out of boot; the measured saving is ~1.5 MB, inside this machine's run-to-run noise, so this is a behaviour
 * decision (an ownerless thread no longer gets code mode) rather than a memory one.
 *
 * The load is a synchronous `require()`: `toolsByName()` is synchronous, and Node resolves an ESM package
 * through `require()` synchronously, so the tool list an agent change asks for is complete when it is built. An
 * `import()` could not be awaited there.
 */
let codemodeInstalled = false;
const nodeRequire = createRequire(import.meta.url);
type CodemodeModule = typeof import("@earendil-works/pi-durable/codemode");

function installCodemode(): void {
  if (codemodeInstalled) return;
  const { createCodemodeExtension } = nodeRequire("@earendil-works/pi-durable/codemode") as CodemodeModule;
  registry.install(createCodemodeExtension({ sandbox: lazySandbox }));
  codemodeInstalled = true;
}

/** Does an agent on disk select code mode? Read at boot so a restart keeps agent-bound threads working. */
async function anAgentWantsCodemode(): Promise<boolean> {
  return (await listAgents()).some((agent) => agent.tools.includes("codemode"));
}

/**
 * The tools that cost something to load, installed on first use rather than at boot.
 *
 * A shell tool, a CLI hand-off, a vault and a browser are four different graphs: child_process, the pi-durable
 * tool schema, node:crypto, and ws plus the CDP client. A thread that only chats must not pay for any of them.
 * `require()` is synchronous, and toolsByName() is synchronous, so the list an agent asks for is complete by
 * the time it is built. The measured effect is the point: boot stays at the pre-feature resident size and no
 * child process exists until an action actually runs.
 */
const lazyInstalled = new Set<string>();
const lazyLoaders: Record<string, () => void> = {
  terminal: () => {
    const module = nodeRequire("./terminal.ts") as typeof import("./terminal.ts");
    registry.install(defineExtension({ name: "terminal", tools: [module.terminalTool] }));
  },
  coding: () => {
    const module = nodeRequire("./coding.ts") as typeof import("./coding.ts");
    registry.install(defineExtension({ name: "coding", tools: [module.codingTool] }));
  },
  vault: () => {
    const module = nodeRequire("./vault-tool.ts") as typeof import("./vault-tool.ts");
    registry.install(defineExtension({ name: "vault", tools: [module.vaultTool] }));
  },
  browser: () => {
    const module = nodeRequire("./browser.ts") as typeof import("./browser.ts");
    registry.install(defineExtension({ name: "browser", tools: [module.browserTool] }));
  },
};

function installLazyTool(name: string): void {
  if (lazyInstalled.has(name)) return;
  const loader = lazyLoaders[name];
  if (!loader) return;
  loader();
  lazyInstalled.add(name);
}

/**
 * The extensions this app owns, installed at boot and again by a sandboxed Update.
 *
 * `registry.install` replaces an extension with its name in place, so re-running this refreshes the live
 * registry without loading new code. Code mode is deliberately not installed here: `installCodemode()` owns
 * that decision, so a reload cannot force its module graph into a process that never needed it.
 */
function installCoreExtensions(): void {
  // The image processor lets `read` handle photos the way pi does: decode, honour EXIF orientation, resize to
  // the model's limits. An attachment upload reuses the same one. It is the lazy wrapper above, so nothing
  // loads until an image does.
  registry.install(createCodingTools({ images: lazyImages }));

  // Memory: one line per agent, written by the agent itself. Installed for the registry, then selected by
  // every agent in agentChangeOf() — a tool that is offered but not registered answers "not available".
  registry.install(defineExtension({ name: "memory", tools: [rememberTool] }));

  // Permissions: a policy, not a sandbox. It refuses the escape hatches for a Standard agent and keeps a
  // scoped agent inside its roots; the systemd unit is what actually contains an allowed tool.
  registry.install(permissionsExtension());

  // Asking the user a question: one durable `chat.question` entry with the option buttons, then the turn ends.
  registry.install(defineExtension({ name: "question", tools: [questionTool] }));

  // The agent network. The extension is installed once; the agent's own mesh policy decides which tools are
  // offered, so a shared registry cannot leak delegate to an agent that only asked for messages.
  registry.install(meshToolsExtension);

  // File output: create_file, create_pdf and publish_file. Every agent gets these, because producing a
  // deliverable is part of the job; permissions still decide which paths publish_file may read.
  registry.install(fileToolsExtension);

  // Global display customization: a saved, closed token set and a bounded CSS layer, applied live. This is
  // deliberately not source editing; the owner can reset it without a build.
  registry.install(displayToolsExtension);

  // Diagrams are just markdown, but the model has to know they are supported. Keep the instruction short: it
  // is present on every request, and the diagram itself costs nothing until one is rendered.
  registry.install(
    defineExtension({
      name: "diagrams",
      sections: [
        section(
          "diagrams",
          () =>
            "Answers may include a fenced mermaid block when a flow, architecture, or relationship is clearer visually. " +
            "Keep labels short and the diagram focused; the UI renders it lazily.",
        ),
      ],
    }),
  );

  // Web search: keyless, because pi-ai has no provider-native search and this machine has no search credential.
  registry.install(defineExtension({ name: "search", tools: [webSearchTool] }));



  // The sandbox is behind a proxy so its module loads on the first script that actually runs. `start()` is
  // synchronous, so the tool's wrapper is what awaits the import before the original `execute()` can call it; the
  // extension gets the same interface, so it cannot tell. The wrap has no target when code mode is not installed,
  // and pi-durable then does nothing.
  registry.install(
    defineExtension({
      name: "codemode-loader",
      wraps: [
        {
          tool: "codemode",
          wrap: (tool: ToolRegistration) => ({
            ...tool,
            execute: async (...args: Parameters<ToolRegistration["execute"]>) => {
              await loadCodemodeSandbox();
              return tool.execute(...args);
            },
          }),
        },
      ],
    }),
  );
}

/** Re-register the core extensions from the modules already in memory; return their names. */
export function reloadTools(): string[] {
  installCoreExtensions();
  // A reload must not change the code-mode policy: if it was installed, re-register it; if not, leave it out.
  if (codemodeInstalled) installCodemode();
  // A lazily installed module is already in memory; re-run its loader so an Update refreshes it in place.
  for (const name of lazyInstalled) lazyLoaders[name]?.();
  return registry.snapshot().installed().map((extension) => extension.name);
}

export async function openHarness(): Promise<Harness> {
  if (instance) return instance;
  await mkdir(dataDir, { recursive: true });

  installCoreExtensions();
  if (await anAgentWantsCodemode()) installCodemode();

  const storage = await openNodeSqliteStorage(dbPath);
  instance = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        toolExecution: "parallel",
        progress: { partialIntervalMs: 80, outputIntervalMs: 120 },
        contextRetentionMs: 60_000,
      },
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }),
    },
    context,
  );
  // Required: without resume(), interrupted work is never rescheduled.
  instance.resume();
  return instance;
}

export function harnessInstance(): Harness {
  if (!instance) throw new Error("harness not open: call openHarness() first");
  return instance;
}

export function installExtensions(extensions: readonly Extension[]): void {
  for (const extension of extensions) registry.install(extension);
}

/** Turn tool names (from agent.json) into the tool objects installed in the registry. */
export function toolsByName(names: readonly string[]): ToolRegistration[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  // An agent created or rebound after boot asks for code mode here, synchronously, before its tool list is built.
  if (wanted.has("codemode")) installCodemode();
  // Same rule for the four optional modules: the first agent that names one loads it, and only that one.
  for (const name of wanted) installLazyTool(name);
  return registry
    .snapshot()
    .tools()
    .filter((entry) => wanted.has(entry.tool.name))
    .map((entry) => entry.tool);
}