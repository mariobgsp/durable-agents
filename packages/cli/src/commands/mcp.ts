import { type Parsed, flag, flagAll, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { loadMcpConfig, saveMcpConfig } from "../../../core/src/mcp.ts";

type Status = { name: string; enabled: boolean; connected: boolean; tools: string[]; error?: string };
type ToolInfo = { server: string; name: string; registeredName: string; description: string };

async function daemonOrUndefined(): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(undefined, 700);
  } catch (error) {
    if (error instanceof DaemonUnavailable) return undefined;
    throw error;
  }
}

function parseEnv(values: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf("=");
    if (index <= 0) fail("--env expects KEY=VALUE", 2);
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

function parseCommand(parsed: Parsed, name: string): { command: string; args: string[] } {
  const positional = parsed.positional.slice(2);
  const explicit = flag(parsed, "command");
  if (explicit) return { command: explicit, args: [...flagAll(parsed, "arg"), ...positional] };
  if (positional.length === 0) fail("usage: dura mcp add <name> --command <cmd> [--arg x]… or: dura mcp add <name> -- <cmd> [args…]", 2);
  return { command: positional[0] ?? "", args: [...flagAll(parsed, "arg"), ...positional.slice(1)] };
}

export async function runMcp(parsed: Parsed): Promise<void> {
  const [action = "list", name] = parsed.positional;

  if (action === "list" || action === "status" || action === "tools") {
    const daemon = await daemonOrUndefined();
    if (daemon) {
      try {
        const result = await daemon.request<{ servers: Status[]; tools: ToolInfo[] }>("mcp.list");
        if (has(parsed, "json")) {
          json(result);
          return;
        }
        if (result.servers.length === 0) print("no MCP servers; add one with: dura mcp add <name> -- <command>");
        else table(["server", "state", "tools"], result.servers.map((server) => [server.name, server.connected ? paint("green", "connected") : server.error ? paint("red", "error") : "stopped", String(server.tools.length)]));
        for (const tool of result.tools) print("  " + tool.registeredName + "  (" + tool.server + "/" + tool.name + ")");
        return;
      } finally {
        daemon.close();
      }
    }
    const config = await loadMcpConfig();
    if (has(parsed, "json")) json(config);
    else if (config.servers.length === 0) print("no MCP servers configured");
    else table(["server", "command", "enabled"], config.servers.map((server) => [server.name, server.command + " " + (server.args ?? []).join(" "), server.enabled === false ? "no" : "yes"]));
    return;
  }

  if (action === "add") {
    if (!name) fail("usage: dura mcp add <name> --command <cmd> [--arg x]…", 2);
    const { command, args } = parseCommand(parsed, name);
    const env = parseEnv(flagAll(parsed, "env"));
    const daemon = await daemonOrUndefined();
    if (daemon) {
      try {
        const result = await daemon.request<{ server: Status; tools: string[]; rebound: number }>("mcp.add", {
          name,
          command,
          args,
          env,
        });
        if (has(parsed, "json")) json(result);
        else {
          print(paint("green", "connected") + " " + name + " · " + result.tools.length + " tool(s) · " + result.rebound + " agents rebound");
          for (const tool of result.tools) print("  " + tool);
        }
        return;
      } finally {
        daemon.close();
      }
    }
    const config = await loadMcpConfig();
    if (config.servers.some((server) => server.name === name)) fail("an MCP server called " + name + " already exists", 4);
    config.servers.push({
      name,
      enabled: true,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
    await saveMcpConfig(config);
    print("saved; start or restart the daemon to connect " + name);
    return;
  }

  if (action === "remove") {
    if (!name) fail("usage: dura mcp remove <name>", 2);
    const daemon = await daemonOrUndefined();
    if (daemon) {
      try {
        const result = await daemon.request<{ removed: boolean; rebound: number }>("mcp.remove", { name });
        if (has(parsed, "json")) json(result);
        else print(result.removed ? "removed " + name + " · " + result.rebound + " agents rebound" : "no MCP server " + name);
        return;
      } finally {
        daemon.close();
      }
    }
    const config = await loadMcpConfig();
    config.servers = config.servers.filter((server) => server.name !== name);
    await saveMcpConfig(config);
    print("removed from config; restart the daemon to apply");
    return;
  }

  if (action === "reload") {
    const daemon = await daemonOrUndefined();
    if (!daemon) fail("the daemon is not running; start it with dura start", 3);
    try {
      const result = await daemon.request<{ servers: Status[]; tools: string[] }>("mcp.reload");
      if (has(parsed, "json")) json(result);
      else print("reloaded · " + result.servers.length + " servers · " + result.tools.length + " tools");
      return;
    } finally {
      daemon.close();
    }
  }

  fail("usage: dura mcp <list|add|remove|reload|tools>", 2);
}
