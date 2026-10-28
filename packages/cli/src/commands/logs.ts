import { open, stat } from "node:fs/promises";
import { type Parsed, flag, has, numberFlag } from "../args.ts";
import { paint, print } from "../output.ts";
import { logPath } from "../../../core/src/paths.ts";

type Line = { at?: string; level?: string; event?: string; [key: string]: unknown };

function format(entry: Line): string {
  const level = String(entry.level ?? "info");
  const colour = level === "error" ? "red" : level === "warn" ? "yellow" : level === "debug" ? "dim" : "cyan";
  const rest = Object.entries(entry)
    .filter(([key]) => key !== "at" && key !== "level" && key !== "event")
    .map(([key, value]) => key + "=" + (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  return paint(colour, level.padEnd(5)) + " " + String(entry.event ?? "") + (rest ? " " + rest : "");
}

function parse(raw: string): Line | undefined {
  try {
    return JSON.parse(raw) as Line;
  } catch {
    return undefined;
  }
}

export async function runLogs(parsed: Parsed): Promise<void> {
  const level = flag(parsed, "level");
  const rank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minimum = rank[level ?? "debug"] ?? 10;
  const since = numberFlag(parsed, "since");
  const sinceAt = since === undefined ? 0 : Date.now() - since * 60_000;
  const lines = numberFlag(parsed, "lines") ?? 200;

  let text = "";
  try {
    text = await open(logPath).then(async (handle) => {
      const raw = await handle.readFile("utf8");
      await handle.close();
      return raw;
    });
  } catch {
    print("no log yet at " + logPath);
    return;
  }
  const selected = text
    .split("\n")
    .filter(Boolean)
    .map(parse)
    .filter((entry): entry is Line => Boolean(entry))
    .filter((entry) => (rank[String(entry.level)] ?? 20) >= minimum)
    .filter((entry) => {
      if (!sinceAt) return true;
      const at = Date.parse(String(entry.at ?? ""));
      return Number.isFinite(at) && at >= sinceAt;
    })
    .slice(-lines);

  for (const entry of selected) print(String(entry.at ?? "") + " " + format(entry));
  if (!has(parsed, "follow")) return;

  let offset = (await stat(logPath)).size;
  let polling = true;
  process.once("SIGINT", () => {
    polling = false;
  });
  while (polling) {
    await new Promise((done) => setTimeout(done, 500));
    const size = await stat(logPath).then((entry) => entry.size).catch(() => offset);
    if (size <= offset) continue;
    const handle = await open(logPath);
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      for (const raw of buffer.toString("utf8").split("\n")) {
        if (!raw) continue;
        const entry = parse(raw);
        if (!entry) continue;
        if ((rank[String(entry.level)] ?? 20) < minimum) continue;
        print(String(entry.at ?? "") + " " + format(entry));
      }
    } finally {
      await handle.close();
    }
  }
}
