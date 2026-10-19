import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
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

export async function openHarness(): Promise<Harness> {
  if (instance) return instance;
  await mkdir(dataDir, { recursive: true });

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

  // Web search: keyless, because pi-ai has no provider-native search and this machine has no search credential.
  registry.install(defineExtension({ name: "search", tools: [webSearchTool] }));

  // Code mode: the model writes JavaScript that calls the conversation's tools in a QuickJS sandbox. The
  // extension is registered by installCodemode() — at boot only if an agent on disk selects it, otherwise by
  // toolsByName() when an agent change asks for it.
  if (await anAgentWantsCodemode()) installCodemode();

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
  return registry
    .snapshot()
    .tools()
    .filter((entry) => wanted.has(entry.tool.name))
    .map((entry) => entry.tool);
}
