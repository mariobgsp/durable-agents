import { mkdir } from "node:fs/promises";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { models } from "./models.ts";
import { rememberTool } from "./remember.ts";
import { dataDir, dbPath } from "./paths.ts";

/** Extension registry shared by every session. */
export const registry: Registry = createRegistry();

// read/write/edit/bash and codemode are installed inside openHarness(): the coding tools want an
// image processor, which is loaded asynchronously (Photon, in a worker thread).

/** Root server context: lives as long as the process, never cancelled. */
export const context = BACKGROUND_CONTEXT;

let instance: Harness | undefined;

export async function openHarness(): Promise<Harness> {
  if (instance) return instance;
  await mkdir(dataDir, { recursive: true });

  // Tools that need async setup live here. The image processor lets `read` handle photos the way pi
  // does: decode, honour EXIF orientation, resize to the model's limits.
  const images = await createNodePhotonImages();
  registry.install(createCodingTools({ images }));

  // Memory: one line per agent, written by the agent itself. Installed for the registry, then selected by
  // every agent in agentChangeOf() — a tool that is offered but not registered answers "not available".
  registry.install(defineExtension({ name: "memory", tools: [rememberTool] }));

  // Code mode: the model writes JavaScript that calls the conversation's tools in a QuickJS sandbox.
  registry.install(
    createCodemodeExtension({
      sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
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
  return registry
    .snapshot()
    .tools()
    .filter((entry) => wanted.has(entry.tool.name))
    .map((entry) => entry.tool);
}
