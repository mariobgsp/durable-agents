import { type Parsed, flag, flagAll, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { connectOrUndefined } from "../client.ts";
import { loadMcpConfig, saveMcpConfig } from "../../../core/src/mcp.ts";

type Status = { name: string; enabled: boolean; connected: boolean; state?: string; lazy?: boolean; tools: string[]; lastUsedAt?: string; error?: string };
type ToolInfo = { server: string; name: string; registeredName: string; description: string };

/** One word the owner can read: running, idle (sleeping until the next call), disabled or error. */
function paintState(server: Status): string {
  const state = server.state ?? (server.connected ? "connected" : server.error ? "error" : "idle");
  if (state === "connected") return paint("green", "connected");
  if (state === "error") return paint("red", "error");
  if (state === "disabled") return paint("yellow", "disabled");
  return paint("cyan", "idle");
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
    const daemon = await connectOrUndefined();
    if (daemon) {
      try {
        const result = await daemon.request<{ servers: Status[]; tools: ToolInfo[] }>("mcp.list");
        if (has(parsed, "json")) {
          json(result);
          return;
        }
        if (result.servers.length === 0) print("no MCP servers; add one with: dura mcp add <name> -- <command>");
        else
          table(
            ["server", "state", "tools", "last used"],
            result.servers.map((server) => [
              server.name,
              paintState(server),
              String(server.tools.length),
              server.lastUsedAt ? server.lastUsedAt.replace("T", " ").slice(0, 19) : "—",
            ]),
          );
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

  if (action === "enable" || action === "disable") {
    if (!name) fail("usage: dura mcp " + action + " <name>", 2);
    const daemon = await connectOrUndefined();
    if (daemon) {
      try {
        const result = await daemon.request<{ server: Status; tools: string[]; rebound: number }>("mcp." + action, { name });
        if (has(parsed, "json")) json(result);
        else print(name + " " + action + "d · " + result.tools.length + " tool(s) · " + result.rebound + " agents rebound");
        return;
      } finally {
        daemon.close();
      }
    }
    const config = await loadMcpConfig();
    const server = config.servers.find((entry) => entry.name === name);
    if (!server) fail("no MCP server " + name, 4);
    server.enabled = action === "enable";
    await saveMcpConfig(config);
    print("saved; restart the daemon to apply");
    return;
  }

  if (action === "stop") {
    const daemon = await connectOrUndefined();
    if (!daemon) fail("the daemon is not running; nothing to stop", 3);
    try {
      const result = await daemon.request<{ stopped: string[] }>("mcp.stop", name ? { name } : {});
      if (has(parsed, "json")) json(result);
      else print(result.stopped.length === 0 ? "nothing was running" : "stopped " + result.stopped.join(", ") + " · tools stay registered and respawn on demand");
      return;
    } finally {
      daemon.close();
    }
  }

  if (action === "add") {
    if (!name) fail("usage: dura mcp add <name> --command <cmd> [--arg x]…", 2);
    const { command, args } = parseCommand(parsed, name);
    const env = parseEnv(flagAll(parsed, "env"));
    const daemon = await connectOrUndefined();
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
          print(paint("green", "ready") + " " + name + " · " + result.tools.length + " tool(s) · " + result.rebound + " agents rebound · starts on first call, sleeps when idle");
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
    const daemon = await connectOrUndefined();
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
    const daemon = await connectOrUndefined();
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

  fail("usage: dura mcp <list|add|remove|reload|tools|enable|disable|stop>", 2);
}
