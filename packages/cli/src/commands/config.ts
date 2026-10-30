import { spawn } from "node:child_process";
import { type Parsed, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { readConfig, validateConfig, writeConfig, type DuraConfig } from "../../../core/src/config.ts";
import { configPath } from "../../../core/src/paths.ts";

function getPath(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(value: unknown, keys: string[], next: unknown): void {
  let current = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const child = current[key];
    if (typeof child !== "object" || child === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  const last = keys.at(-1);
  if (last) current[last] = next;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function runConfig(parsed: Parsed): Promise<void> {
  const [action = "get", ...rest] = parsed.positional;
  if (action === "validate") {
    const config = await readConfig({ fresh: true });
    const problems = validateConfig(config);
    json({ ok: problems.length === 0, path: configPath, version: config.version, active: config.chat.active, problems });
    if (problems.length > 0) {
      print(paint("red", "invalid config:"));
      for (const problem of problems) print("· " + problem);
      process.exit(1);
    }
    return;
  }
  if (action === "edit") {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const child = spawn(editor, [configPath], { stdio: "inherit" });
    await new Promise<void>((done, failed) => {
      child.on("exit", (code) => (code === 0 ? done() : failed(new Error("editor exited " + code))));
      child.on("error", failed);
    });
    await readConfig({ fresh: true });
    return;
  }
  if (action === "get") {
    const config = await readConfig({ fresh: true });
    const keys = rest.flatMap((part) => part.split(".")).filter(Boolean);
    const value = keys.length > 0 ? getPath(config, keys) : config;
    if (has(parsed, "json")) json(value ?? null);
    else if (typeof value === "string") print(value);
    else print(JSON.stringify(value, null, 2));
    return;
  }
  if (action === "set") {
    const assignment = rest[0];
    if (!assignment || !assignment.includes("=")) fail("usage: dura config set key.path=value", 2);
    const [rawKey, rawValue] = assignment.split("=", 2);
    const keys = (rawKey ?? "").split(".").filter(Boolean);
    if (keys.length === 0) fail("invalid key", 2);
    const config = await readConfig({ fresh: true });
    setPath(config, keys, parseValue(rawValue ?? ""));
    const problems = validateConfig(config as DuraConfig);
    if (problems.length > 0) fail("invalid config: " + problems.join("; "), 2);
    await writeConfig(config as DuraConfig);
    json({ ok: true, key: keys.join("."), value: getPath(config, keys) });
    return;
  }
  fail("usage: dura config <get|set|edit|validate>", 2);
}
