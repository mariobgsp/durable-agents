import { type Parsed, has } from "../args.ts";
import { runStop } from "./stop.ts";
import { runStart } from "./start.ts";

export async function runRestart(parsed: Parsed): Promise<void> {
  await runStop(parsed);
  await new Promise((done) => setTimeout(done, 300));
  // A restart from a script or a service should return to the background form.
  if (has(parsed, "foreground") || has(parsed, "detach")) {
    await runStart(parsed);
    return;
  }
  await runStart({ ...parsed, booleans: new Set([...parsed.booleans, "detach"]) });
}
