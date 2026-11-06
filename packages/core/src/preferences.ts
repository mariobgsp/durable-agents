import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { preferencesPath } from "./paths.ts";
import { redactSecrets } from "./vault-store.ts";

/**
 * Owner preferences: the one memory that is not per agent.
 *
 * MEMORY.md answers "what did this agent learn". This file answers "what does the owner want", and it is
 * rendered into every agent's prompt, so five agents do not each have to be told the same thing twice. The
 * write path is a single append with a duplicate check and the same per-file serialisation memory uses:
 * two agents can learn the same preference at the same moment from two threads.
 */
const PREFERENCE_RENDER_LIMIT = 30;
/** A preference is a sentence, not a paragraph: it is copied into every prompt of the fleet. */
const PREFERENCE_MAX_CHARS = 300;

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function readPreferences(): Promise<string> {
  return readText(preferencesPath);
}

/**
 * The last preferences body read from disk.
 *
 * The prompt is assembled synchronously in several places (a new thread, a rebind, a room), so the disk read
 * cannot happen there. `refreshPreferences()` fills this cache at boot and before any prompt is built, and a
 * write updates it, so a preference saved in a thread is in the next prompt without a restart.
 */
let cached = "";

export function cachedPreferences(): string {
  return cached;
}

export async function refreshPreferences(): Promise<string> {
  cached = await readPreferences();
  return cached;
}

/** The notes in the file, in file order. Anything that is not a note (headings, blanks) is ignored. */
export function preferenceLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.length > 2);
}

/**
 * Append one standing preference.
 *
 * Secrets are redacted before the line is stored, not after: this file is rendered into prompts of other
 * agents and surfaces in `/memory`-style listings, so a credential that slips in here leaks five times over.
 */
export async function appendPreference(note: string): Promise<{ saved: boolean; line: string }> {
  const clean = redactSecrets(note.replace(/\s+/g, " ").trim()).slice(0, PREFERENCE_MAX_CHARS).trim();
  if (!clean) throw new Error("a preference cannot be empty");

  return serialize(async () => {
    const existing = await readPreferences();
    const line = "- " + clean;
    const lower = clean.toLowerCase();
    const duplicate = existing
      .split("\n")
      .some((entry) => entry.trim().toLowerCase().endsWith(lower));
    if (duplicate) return { saved: false, line };

    const body =
      existing.trim().length > 0
        ? existing.trimEnd() + "\n" + line + "\n"
        : "# Owner preferences\n\n" + line + "\n";
    await writeText(preferencesPath, body);
    cached = body;
    return { saved: true, line };
  });
}

/**
 * The preferences block of the system prompt.
 *
 * It is placed before the agent's own memory because it is the more binding of the two: a preference is an
 * instruction from the owner, while a memory note is something the agent observed.
 */
export function preferencesSection(markdown: string): string {
  const lines = preferenceLines(markdown);
  if (lines.length === 0) return "";
  const kept = lines.slice(-PREFERENCE_RENDER_LIMIT);
  const omitted = lines.length - kept.length;
  return [
    "## Owner preferences",
    "",
    "Standing instructions from the owner, learned across every thread and shared by every agent. Follow them by" +
      " default; only a direct instruction in this thread outranks them.",
    "",
    ...(omitted > 0 ? ["(" + omitted + " older preferences are on disk but omitted here)", ""] : []),
    ...kept,
  ].join("\n");
}
