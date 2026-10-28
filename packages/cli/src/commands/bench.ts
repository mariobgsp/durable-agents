import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { type Parsed, flag, has } from "../args.ts";
import { json, print } from "../output.ts";

/** The benchmark is maintained as a script so it can run without the CLI's own imports. */
export async function runBench(parsed: Parsed): Promise<void> {
  const script = resolve(import.meta.dirname, "../../../../scripts/bench/five-agents.mjs");
  const args = [script, ...(has(parsed, "json") ? ["--json"] : []), ...(flag(parsed, "out") ? ["--out", flag(parsed, "out") ?? ""] : [])];
  if (has(parsed, "json")) json({ script, args: args.slice(1) });
  else print("running five-agent benchmark…");
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const code = await new Promise<number>((done) => child.on("exit", (value) => done(value ?? 1)));
  process.exit(code);
}
