import { readdir, unlink } from "node:fs/promises";
import { type Parsed, has } from "../args.ts";
import { print, paint, json } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { readyPath, runDir } from "../../../core/src/paths.ts";

export async function runStop(parsed: Parsed): Promise<void> {
  let client: DaemonClient | undefined;
  try {
    client = await DaemonClient.connect();
  } catch (error) {
    if (!(error instanceof DaemonUnavailable)) throw error;
    if (has(parsed, "json")) json({ stopped: false, reason: "not running" });
    else print("daemon is not running");
    await unlink(readyPath).catch(() => undefined);
    return;
  }
  try {
    await client.request("shutdown");
    const deadline = Date.now() + 15_000;
    let stopped = false;
    while (Date.now() < deadline) {
      try {
        await DaemonClient.connect(undefined, 400);
      } catch {
        stopped = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 150));
    }
    if (!stopped) {
      print(paint("yellow", "the daemon did not stop within 15s"));
      process.exit(1);
    }
    await unlink(readyPath).catch(() => undefined);
    if (has(parsed, "json")) json({ stopped: true });
    else print(paint("green", "daemon stopped"));
  } finally {
    client.close();
  }
}
