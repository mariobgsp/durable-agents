import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { listAgents } from "./agents.ts";
import { errorFields, log } from "./logger.ts";
import { mcpPath } from "./paths.ts";

/**
 * MCP servers are global. One connection per server, every tool is injected into every agent's
 * conversation, and installing a server rebinds existing threads so "install this MCP" means "all
 * agents have it". Stdio transport only: command + args, JSON-RPC over newline-delimited pipes.
 */

export type McpServerConfig = {
  name: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export type McpConfig = { version: 1; servers: McpServerConfig[] };

export type McpToolInfo = {
  server: string;
  name: string;
  registeredName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  connected: boolean;
  tools: string[];
  error?: string;
};

type ServerEntry = {
  config: McpServerConfig;
  client?: StdioClient;
  tools: McpToolInfo[];
  error?: string;
};

const entries = new Map<string, ServerEntry>();
let toolList: ToolRegistration[] = [];
let toolInfos: McpToolInfo[] = [];

export function mcpTools(): ToolRegistration[] {
  return toolList;
}

export function mcpToolInfos(): McpToolInfo[] {
  return [...toolInfos];
}

export function mcpStatus(): McpServerStatus[] {
  return [...entries.values()].map((entry) => ({
    name: entry.config.name,
    enabled: entry.config.enabled !== false,
    connected: Boolean(entry.client),
    tools: entry.tools.map((tool) => tool.registeredName),
    ...(entry.error ? { error: entry.error } : {}),
  }));
}

/* ----------------------------- config ----------------------------- */

export async function loadMcpConfig(): Promise<McpConfig> {
  try {
    const parsed = JSON.parse(await readFile(mcpPath, "utf8")) as Partial<McpConfig>;
    return {
      version: 1,
      servers: Array.isArray(parsed.servers)
        ? parsed.servers.filter(
            (server): server is McpServerConfig =>
              Boolean(server) && typeof server.name === "string" && typeof server.command === "string",
          )
        : [],
    };
  } catch {
    return { version: 1, servers: [] };
  }
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  await mkdir(dirname(mcpPath), { recursive: true, mode: 0o700 });
  const tmp = mcpPath + ".tmp";
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, mcpPath);
}

function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
}

/* ----------------------------- stdio client ----------------------------- */

type RpcResponse = { jsonrpc: "2.0"; id?: number | string; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string };

class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  readonly config: McpServerConfig;
  stderr = "";

  constructor(config: McpServerConfig) {
    this.config = config;
    this.child = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env ?? {}) },
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(new Error("MCP server " + config.name + " exited (" + (signal ?? code) + ")"));
      this.closed = true;
    });
  }

  private fail(error: unknown): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let message: RpcResponse;
      try {
        message = JSON.parse(raw) as RpcResponse;
      } catch {
        log.debug("mcp.non_json_stdout", { server: this.config.name, text: raw.slice(0, 200) });
        continue;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      // Server-initiated requests/notifications are ignored: this client only calls tools.
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw new Error("MCP server " + this.config.name + " is not running");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP server " + this.config.name + " is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.write({ method, params });
    } catch {
      /* a notification after close is harmless */
    }
  }

  async initialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dura-agents", version: "0.1.0" },
      },
      this.config.timeoutMs ?? 20_000,
    );
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolInfo["inputSchema"] extends never ? never : { name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
    const tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, this.config.timeoutMs ?? 20_000)) as {
        tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
        nextCursor?: unknown;
      };
      for (const tool of result.tools ?? []) {
        if (typeof tool.name !== "string") continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, this.config.timeoutMs ?? 120_000);
  }

  stop(): void {
    this.closed = true;
    this.fail(new Error("MCP client stopped"));
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1000).unref?.();
  }
}

/* ----------------------------- registry ----------------------------- */

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const typed = block as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return JSON.stringify(structured, null, 2);
  return JSON.stringify(result, null, 2);
}

function makeTool(entry: ServerEntry, info: McpToolInfo): ToolRegistration {
  return defineTool({
    name: info.registeredName,
    description:
      (info.description ? info.description + "\n\n" : "") +
      "MCP tool " + info.name + " from server " + entry.config.name + ". Available to every agent.",
    parameters: Type.Unsafe(JSON.parse(JSON.stringify(info.inputSchema))) as never,
    async execute(args: Record<string, unknown>) {
      try {
        const result = await entry.client?.callTool(info.name, args ?? {});
        const isError = Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
        return {
          output: [{ type: "text" as const, text: textOf(result) }],
          isError,
          details: result as never,
        };
      } catch (error) {
        return {
          output: [{ type: "text" as const, text: "MCP " + entry.config.name + "/" + info.name + " failed: " + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    },
  });
}

async function installExtension(): Promise<void> {
  const { registry } = await import("./harness.ts");
  registry.install(defineExtension({ name: "mcp", tools: toolList }));
}

async function rebindAll(): Promise<number> {
  const { rebindAgent } = await import("./sessions.ts");
  let rebound = 0;
  for (const agent of await listAgents()) rebound += await rebindAgent(agent.id).catch(() => 0);
  return rebound;
}

async function connectServer(config: McpServerConfig): Promise<ServerEntry> {
  const entry: ServerEntry = { config, tools: [] };
  const client = new StdioClient(config);
  try {
    await client.initialize();
    const tools = await client.listTools();
    const seen = new Set<string>();
    for (const tool of tools) {
      let registeredName = "mcp__" + sanitize(config.name) + "__" + sanitize(tool.name);
      let suffix = 2;
      while (seen.has(registeredName)) registeredName = "mcp__" + sanitize(config.name) + "__" + sanitize(tool.name) + "_" + suffix++;
      seen.add(registeredName);
      entry.tools.push({
        server: config.name,
        name: tool.name,
        registeredName,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
      });
    }
    entry.client = client;
    return entry;
  } catch (error) {
    client.stop();
    entry.error = error instanceof Error ? error.message : String(error);
    log.warn("mcp.connect_failed", { server: config.name, ...errorFields(error), stderr: client.stderr.slice(-400) });
    return entry;
  }
}

function rebuildTools(): void {
  toolInfos = [...entries.values()].flatMap((entry) => entry.tools);
  toolList = [...entries.values()].flatMap((entry) => entry.tools.map((info) => makeTool(entry, info)));
}

/** Connect every enabled server and install their tools globally. Called at boot and on reload. */
export async function startMcp(): Promise<McpServerStatus[]> {
  await stopMcp();
  const config = await loadMcpConfig();
  for (const server of config.servers) {
    if (server.enabled === false) {
      entries.set(server.name, { config: server, tools: [] });
      continue;
    }
    entries.set(server.name, await connectServer(server));
  }
  rebuildTools();
  await installExtension();
  log.info("mcp.started", { servers: mcpStatus().map((status) => status.name), tools: toolInfos.length });
  return mcpStatus();
}

export async function stopMcp(): Promise<void> {
  for (const entry of entries.values()) entry.client?.stop();
  entries.clear();
  toolInfos = [];
  toolList = [];
}

export async function reloadMcp(): Promise<{ servers: McpServerStatus[]; tools: string[] }> {
  await startMcp();
  return { servers: mcpStatus(), tools: toolInfos.map((info) => info.registeredName) };
}

export type AddMcpServerInput = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export async function addMcpServer(input: AddMcpServerInput): Promise<{ server: McpServerStatus; tools: string[]; rebound: number }> {
  if (!validName(input.name)) throw new Error("MCP server name must be lower-case letters, digits and dashes (max 32)");
  if (!input.command.trim()) throw new Error("an MCP server needs a command");
  const config = await loadMcpConfig();
  if (config.servers.some((server) => server.name === input.name)) {
    throw new Error("an MCP server called " + input.name + " already exists");
  }
  const server: McpServerConfig = {
    name: input.name,
    enabled: true,
    command: input.command,
    ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
    ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
  config.servers.push(server);
  await saveMcpConfig(config);
  await startMcp();
  const rebound = await rebindAll();
  const status = mcpStatus().find((entry) => entry.name === input.name);
  if (!status) throw new Error("MCP server did not register");
  if (status.error) throw new Error(status.error);
  return { server: status, tools: status.tools, rebound };
}

export async function removeMcpServer(name: string): Promise<{ removed: boolean; rebound: number }> {
  const config = await loadMcpConfig();
  const before = config.servers.length;
  config.servers = config.servers.filter((server) => server.name !== name);
  if (config.servers.length === before) return { removed: false, rebound: 0 };
  await saveMcpConfig(config);
  await startMcp();
  const rebound = await rebindAll();
  return { removed: true, rebound };
}

export function mcpToolNames(): string[] {
  return toolInfos.map((info) => info.registeredName);
}
