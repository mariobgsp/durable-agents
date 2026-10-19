import { mkdir } from "node:fs/promises";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { models } from "./models.ts";
import { permissionsExtension } from "./permissions.ts";
import { rememberTool } from "./remember.ts";
import { dataDir, dbPath } from "./paths.ts";

/** Extension registry shared by every session. */
export const registry: Registry = createRegistry();

// read/write/edit/bash and codemode are installed inside openHarness(): the coding tools want an
// image processor, which is loaded asynchronously (Photon, in a worker thread).

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

let realSandbox: CodemodeSandbox | undefined;

const lazySandbox = new Proxy({} as CodemodeSandbox, {
  get: (_target, property) => {
    realSandbox ??= new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
    const value = Reflect.get(realSandbox as object, property);
    return typeof value === "function" ? value.bind(realSandbox) : value;
  },
});

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

  // Code mode: the model writes JavaScript that calls the conversation's tools in a QuickJS sandbox.
  //
  // The sandbox is behind a proxy so the WebAssembly runtime loads on the first script that actually runs:
  // constructing it at boot costs about 35 MB measured, for a tool most agents never call. The extension gets
  // the same interface, so it cannot tell.
  registry.install(createCodemodeExtension({ sandbox: lazySandbox }));

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
  return registry
    .snapshot()
    .tools()
    .filter((entry) => wanted.has(entry.tool.name))
    .map((entry) => entry.tool);
}
