import { type Parsed, has } from "../args.ts";
import { json, paint, print, table, fail } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { startDetached } from "./start.ts";
import { runStop } from "./stop.ts";

type Check = { name: string; ok: boolean; detail: string; required: boolean; ms?: number };
type Result = { ok: boolean; checks: Check[]; verifiedAt: number | null };

/** The connection test: the same checks the wizard's final step runs. */
export async function runVerify(parsed: Parsed): Promise<void> {
  const agentPing = !has(parsed, "no-agent-ping");
  let client: DaemonClient;
  let startedHere = false;
  try {
    client = await DaemonClient.connect();
  } catch (error) {
    if (!(error instanceof DaemonUnavailable)) throw error;
    if (!has(parsed, "start")) {
      fail("the daemon is not running; start it with dura start, or pass --start", 3);
    }
    await startDetached(parsed);
    startedHere = true;
    client = await DaemonClient.connect();
  }

  let result: Result;
  try {
    result = await client.request<Result>("verify.run", { agentPing }, 180_000);
  } finally {
    client.close();
  }

  if (has(parsed, "json")) {
    json(result);
  } else {
    table(
      ["check", "result", "detail"],
      result.checks.map((check) => [
        check.name,
        check.ok ? paint("green", "ok") : check.required ? paint("red", "FAIL") : paint("yellow", "warn"),
        check.detail,
      ]),
    );
    print("");
    print(result.ok ? paint("green", "connection test passed") : paint("red", "connection test failed"));
  }

  if (startedHere && !has(parsed, "keep-running")) {
    await runStop({ ...parsed, booleans: new Set(), flags: new Map(), positional: [] });
  }
  if (!result.ok) process.exit(1);
}
