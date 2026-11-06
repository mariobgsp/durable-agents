import { type Parsed, has, numberFlag } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { withDaemon } from "../client.ts";

type Session = { id: string; title: string; updatedAt: number; deletedAt?: number };
type SweepResult = {
  threads: number;
  distilled: number;
  preferences: number;
  memory: number;
  lessons: number;
  consolidated: string[];
};
type LearnResult = {
  conversationId: string;
  agentId: string | null;
  preferences: string[];
  memory: string[];
  lessons: string[];
  skipped?: string;
  error?: string;
};

/**
 * `dura learn` — run the learning layer by hand.
 *
 * It goes through the daemon like `dura thread` does, not through the core modules directly: distilling a
 * thread needs the open harness and the providers that only a running daemon has.
 *
 * The layer also runs on its own after a thread goes quiet, so this command exists for the two cases the
 * timer cannot serve: a thread the owner wants distilled now, and a bulk pass over recent threads. It always
 * forces a pass, because an explicit command that reports "unchanged" and writes nothing is a bad answer.
 */
export async function runLearn(parsed: Parsed): Promise<void> {
  const [target] = parsed.positional;

  if (target === "sweep") {
    const swept = await withDaemon((client) => client.request<SweepResult>("learning.sweep"));
    if (has(parsed, "json")) json(swept);
    else {
      print(
        swept.threads + " thread(s) examined, " + swept.distilled + " distilled: " +
          swept.preferences + " preference(s), " + swept.memory + " memory, " + swept.lessons + " lesson(s)",
      );
      if (swept.consolidated.length > 0) print(paint("dim", "consolidated: " + swept.consolidated.join(", ")));
    }
    return;
  }

  if (target === "prefs" || target === "preferences") {
    const preferences = await withDaemon((client) => client.request<string[]>("preferences.list", {}));
    if (has(parsed, "json")) json({ preferences });
    else print(preferences.length > 0 ? preferences.join("\n") : paint("dim", "(no owner preferences yet)"));
    return;
  }

  const results = await withDaemon(async (client) => {
    const sessions = (await client.request<Session[]>("sessions.list", {})).filter((session) => !session.deletedAt);
    if (sessions.length === 0) fail("no threads to learn from", 4);
    let ids: string[] = [];
    if (target) {
      if (!sessions.some((session) => session.id === target)) fail("unknown thread: " + target, 4);
      ids = [target];
    } else {
      const limit = has(parsed, "all") ? sessions.length : Math.max(1, numberFlag(parsed, "recent") ?? 5);
      ids = sessions.slice(0, limit).map((session) => session.id);
    }
    const out: { session: Session; result: LearnResult }[] = [];
    for (const id of ids) {
      const session = sessions.find((entry) => entry.id === id)!;
      out.push({ session, result: await client.request<LearnResult>("learning.distill", { id, forced: true }) });
    }
    return out;
  });

  if (has(parsed, "json")) {
    json(results);
    return;
  }
  for (const { session, result } of results) {
    const label = session.title || session.id;
    const total = result.preferences.length + result.memory.length + result.lessons.length;
    print(
      (result.skipped ? paint("dim", "skipped " + result.skipped) : total + " new note(s)") +
        "  " + paint("dim", label + " (" + session.id + ")"),
    );
    for (const note of result.preferences) print("  prefer: " + note);
    for (const note of result.memory) print("  memory: " + note);
    for (const note of result.lessons) print("  lesson: " + note);
  }
}
