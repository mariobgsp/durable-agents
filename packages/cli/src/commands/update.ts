import { type Parsed, has } from "../args.ts";
import { duration, json, paint, print } from "../output.ts";
import { withDaemon } from "../client.ts";

type Snapshot = {
  current: { kind: string; state: { name: string; step?: string; outcome?: unknown; reason?: string }; startedAt: number } | null;
  last: { kind: string; state: { name: string; step?: string; outcome?: unknown; reason?: string }; startedAt: number; endedAt: number | null } | null;
};

export async function runUpdate(parsed: Parsed): Promise<void> {
  const started = await withDaemon((client) => client.request<Record<string, unknown>>("system.update"));
  if (has(parsed, "json")) print(JSON.stringify(started));
  const startedAt = Date.now();
  for (;;) {
    await new Promise((done) => setTimeout(done, 500));
    const snapshot = await withDaemon((client) => client.request<Snapshot>("system.snapshot"));
    const operation = snapshot.current ?? snapshot.last;
    if (!operation) break;
    if (operation.state.name === "running") {
      if (!has(parsed, "json")) print(paint("dim", operation.state.step ?? "working") + " · " + duration(Date.now() - startedAt));
      if (Date.now() - startedAt > 20 * 60_000) {
        print(paint("red", "update did not finish within 20 minutes"));
        process.exit(1);
      }
      continue;
    }
    if (has(parsed, "json")) {
      json(snapshot);
    } else if (operation.state.name === "done") {
      print(paint("green", "update done") + " · " + operation.kind);
      if (operation.state.outcome) print(JSON.stringify(operation.state.outcome, null, 2));
    } else {
      print(paint("red", "update " + operation.state.name) + " · " + (operation.state.reason ?? ""));
      process.exit(1);
    }
    return;
  }
}
