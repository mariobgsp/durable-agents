import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendLesson, appendMemory, readLessons, readMemory, writeLessons } from "./agents.ts";
import { readConfig } from "./config.ts";
import { log } from "./logger.ts";
import { models, resolveDefaultModel } from "./models.ts";
import { learningsPath } from "./paths.ts";
import { appendPreference, preferenceLines, readPreferences } from "./preferences.ts";
import { recordStatelessUsage } from "./usage-ledger.ts";
import { redactSecrets } from "./vault-store.ts";

/**
 * The learning layer: one thread becomes notes after it goes quiet.
 *
 * It exists because `remember` only fires when the model thinks of it. The owner's corrections are the most
 * valuable thing in a thread and the easiest to lose, so the layer reads the transcript itself, asks a cheap
 * model what was durable, and writes the answer where the next thread will see it: the fleet preferences
 * file for "how the owner wants work done", the agent's MEMORY.md for facts.
 *
 * Three things keep it from becoming noise. It never runs during a run (idle only, debounced), it never
 * writes a note that is already there (both stores dedupe), and it never re-reads a thread it has already
 * distilled unless the entry count changed.
 */
const MAX_MESSAGES = 40;
/** Lessons kept after consolidation: method should stay short enough to read on every request. */
const LESSON_KEEP = 12;
/** Threads examined per sweep; the newest first, so a busy fleet still learns from today. */
const SWEEP_THREADS = 25;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_ITEMS = 3;
const MAX_ITEM_CHARS = 240;

export type LearnResult = {
  conversationId: string;
  agentId: string | null;
  preferences: string[];
  memory: string[];
  lessons: string[];
  skipped?: "disabled" | "busy" | "too-short" | "unchanged" | "no-answer";
  error?: string;
};

type LearnState = Record<string, { at: string; entries: number }>;

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

async function readState(): Promise<LearnState> {
  const raw = await readText(learningsPath);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as LearnState) : {};
  } catch {
    return {};
  }
}

async function writeState(state: LearnState): Promise<void> {
  await writeText(learningsPath, JSON.stringify(state, null, 2) + "\n");
}

/** Notes that are already stored, lowercased, for a cheap "is this new" test before appending. */
function knownNotes(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const body = trimmed
      .slice(2)
      .replace(/^\d{4}-\d{2}-\d{2}\s*\u00b7\s*/, "")
      .toLowerCase();
    if (body) out.add(body);
  }
  return out;
}

function isNew(note: string, known: Set<string>): boolean {
  const lower = note.toLowerCase();
  for (const entry of known) {
    if (entry === lower || entry.endsWith(lower) || lower.endsWith(entry)) return false;
  }
  return true;
}

/** Pull JSON out of a model answer that may be wrapped in a fence or prose. */
function parseAnswer(text: string): { preferences: string[]; memory: string[]; lessons: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pick = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => redactSecrets(item.replace(/\s+/g, " ").trim()).slice(0, MAX_ITEM_CHARS).trim())
          .filter((item) => item.length > 8)
          .slice(0, MAX_ITEMS)
      : [];
  const record = parsed as Record<string, unknown>;
  return { preferences: pick(record.preferences), memory: pick(record.memory), lessons: pick(record.lessons) };
}

const SYSTEM_PROMPT = [
  "You turn one finished chat thread into durable notes for an agent fleet.",
  "Answer with JSON only, no prose and no code fence:",
  '{"preferences": ["..."], "memory": ["..."], "lessons": ["..."]}',
  "",
  "preferences: standing instructions from the owner about HOW work should be done — language and tone,",
  "tools or executors to use, things to check first, things never to ask again, formatting they expect.",
  "Write each as a self-contained sentence that still makes sense months later; no dates, no thread context.",
  "memory: durable facts worth keeping — who the owner is, what the machine or network looks like, decisions",
  "already made, hard-won conclusions (for example an endpoint or command that finally worked).",
  "lessons: how the agent should work better next time — a check that would have saved a round trip, a tool",
  "that failed and why, the order of steps that finally solved it. Write it as an instruction to your future",
  "self, general enough to apply to a different task of the same shape. This list is what improves",
  "judgement, so prefer one real lesson over three obvious ones.",
  "",
  "Rules: at most 3 items per list, each under 240 characters. Skip anything that is only about the task at",
  "hand. Skip anything already listed as known. Never include passwords, tokens, keys or other credentials.",
  "An empty list is the correct answer when the thread taught nothing durable. When in doubt, leave it out.",
].join("\n");

/**
 * Read one thread, ask a cheap model what was durable, and store it.
 *
 * The caller decides when; `forced` skips the "already distilled at this size" guard so an explicit
 * `/learn` always does something visible.
 */
export async function distillSession(
  conversationId: string,
  options: { forced?: boolean } = {},
): Promise<LearnResult> {
  const sessions = await import("./sessions.ts");
  const config = await readConfig({ fresh: true });
  const result: LearnResult = { conversationId, agentId: null, preferences: [], memory: [], lessons: [] };

  const messages = (await sessions.transcript(conversationId))
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text?.trim())
    .slice(-MAX_MESSAGES);
  if (messages.length < config.learning.minMessages) {
    return { ...result, skipped: "too-short" };
  }

  const state = await readState();
  const previous = state[conversationId];
  if (!options.forced && previous && previous.entries === messages.length) {
    return { ...result, skipped: "unchanged" };
  }

  const agentId = (await sessions.agentForConversation(conversationId)) ?? null;
  result.agentId = agentId;
  const [preferencesText, memoryText, lessonsText] = await Promise.all([
    readPreferences(),
    agentId ? readMemory(agentId) : Promise.resolve(""),
    agentId ? readLessons(agentId) : Promise.resolve(""),
  ]);

  let budget = MAX_TRANSCRIPT_CHARS;
  const lines: string[] = [];
  for (let index = messages.length - 1; index >= 0 && budget > 0; index -= 1) {
    const message = messages[index]!;
    const body = (message.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
    const line = (message.role === "user" ? "owner: " : "agent: ") + body;
    lines.unshift(line.slice(0, Math.max(200, budget)));
    budget -= line.length;
  }

  const existing = [
    ...preferenceLines(preferencesText),
    ...(memoryText ? [...knownNotes(memoryText)] : []),
    ...(lessonsText ? [...knownNotes(lessonsText)] : []),
  ];
  const ref = await resolveDefaultModel();
  const model = await models.getModel(ref.provider, ref.modelId);
  if (!model) return { ...result, skipped: "no-answer", error: "model unavailable: " + ref.provider + "/" + ref.modelId };

  const answer = await models
    .completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              "Known owner preferences:",
              preferenceLines(preferencesText).join("\n") || "(none yet)",
              "",
              "Known memory notes of this agent:",
              memoryText ? [...knownNotes(memoryText)].slice(-20).join("\n") || "(none yet)" : "(this thread has no agent)",
              "",
              "Lessons this agent already learned:",
              lessonsText ? [...knownNotes(lessonsText)].join("\n") || "(none yet)" : "(this thread has no agent)",
              "",
              "Thread transcript, oldest first:",
              lines.join("\n"),
            ].join("\n"),
            timestamp: Date.now(),
          },
        ],
      },
      { sessionId: "learning-" + conversationId },
    )
    .catch(() => undefined);
  if (answer?.usage) {
    await recordStatelessUsage({
      source: "learning-distill",
      provider: ref.provider,
      modelId: ref.modelId,
      usage: answer.usage,
      at: answer.timestamp,
    }).catch(() => undefined);
  }
  const parsed = answer ? parseAnswer(textOfAnswer(answer)) : null;
  if (!parsed) return { ...result, skipped: "no-answer" };

  const known = new Set(existing.map((entry) => entry.replace(/^- /, "").toLowerCase()));
  for (const note of parsed.preferences) {
    if (!isNew(note, known)) continue;
    const saved = await appendPreference(note).catch(() => null);
    if (saved?.saved) {
      result.preferences.push(note);
      known.add(note.toLowerCase());
    }
  }
  if (agentId) {
    for (const note of parsed.lessons) {
      if (!isNew(note, known)) continue;
      const saved = await appendLesson(agentId, note).catch(() => null);
      if (saved?.saved) {
        result.lessons.push(note);
        known.add(note.toLowerCase());
      }
    }
  }
  if (agentId) {
    for (const note of parsed.memory) {
      if (!isNew(note, known)) continue;
      const saved = await appendMemory(agentId, note).catch(() => null);
      if (saved?.saved) {
        result.memory.push(note);
        known.add(note.toLowerCase());
      }
    }
  }

  state[conversationId] = { at: new Date().toISOString(), entries: messages.length };
  await writeState(state).catch(() => undefined);
  return result;
}

/** The assistant text of a pi-ai answer, read structurally so a content shape change cannot break it. */
function textOfAnswer(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

/* ------------------------------ consolidation ------------------------------ */

const CONSOLIDATE_PROMPT = [
  "You tidy the lessons file of one agent: a list of things it learned about how to work.",
  "Answer with JSON only, no prose and no code fence:",
  '{"lessons": ["..."]}',
  "",
  "Merge duplicates, drop anything obsolete, contradictory or tied to one past task, and keep the method that",
  "would still help months from now. Judge, do not summarise: an agent with twelve sharp lessons outperforms",
  "one with forty vague ones. Keep at most " + LESSON_KEEP + " items, each under 240 characters, no dates.",
  "Never add credentials, and never invent a lesson that is not in the input.",
].join("\n");

/**
 * Compress one agent's lessons into a short list that still means something.
 *
 * Appending is how an agent learns; this is how it forgets. Without it the file becomes a changelog of every
 * thread and the rendered block crowds out the conversation, so consolidation runs only when the file has
 * outgrown the render limit, and it rewrites the file rather than adding to it.
 */
export async function consolidateLessons(agentId: string, options: { forced?: boolean } = {}): Promise<string[] | null> {
  const current = await readLessons(agentId);
  const notes = [...knownNotes(current)];
  if (notes.length === 0) return null;
  if (!options.forced && notes.length <= LESSON_KEEP) return null;

  const ref = await resolveDefaultModel();
  const model = await models.getModel(ref.provider, ref.modelId);
  if (!model) return null;
  const answer = await models
    .completeSimple(
      model,
      {
        systemPrompt: CONSOLIDATE_PROMPT,
        messages: [{ role: "user", content: notes.map((note, index) => index + 1 + ". " + note).join("\n"), timestamp: Date.now() }],
      },
      { sessionId: "learning-consolidate-" + agentId },
    )
    .catch(() => undefined);
  if (answer?.usage) {
    await recordStatelessUsage({
      source: "learning-consolidate",
      provider: ref.provider,
      modelId: ref.modelId,
      usage: answer.usage,
      at: answer.timestamp,
    }).catch(() => undefined);
  }
  const parsed = answer ? parseAnswer(textOfAnswer(answer)) : null;
  const kept = parsed?.lessons.slice(0, LESSON_KEEP) ?? [];
  // A model that answers nothing useful must not empty the file: silence is not permission to forget.
  if (kept.length === 0) return null;
  await writeLessons(agentId, kept);
  return kept;
}

/* --------------------------------- sweep loop --------------------------------- */

export type SweepResult = {
  threads: number;
  distilled: number;
  preferences: number;
  memory: number;
  lessons: number;
  consolidated: string[];
};

let sweepTimer: NodeJS.Timeout | undefined;

/**
 * One pass over every live thread, newest first, distilling the ones that changed since the last pass.
 *
 * This is what makes the layer autonomous per agent rather than dependent on one thread's idle timer: a
 * timer lives in memory, so a restart, a crash or a thread that was never quiet would otherwise lose the
 * lessons inside it. The state file decides what is new, so a pass costs one model call per changed thread
 * and nothing for the rest.
 */
export async function sweepLearning(): Promise<SweepResult> {
  const result: SweepResult = { threads: 0, distilled: 0, preferences: 0, memory: 0, lessons: 0, consolidated: [] };
  const config = await readConfig({ fresh: true });
  if (!config.learning.auto) return result;

  const sessions = await import("./sessions.ts");
  const testTitles = new Set(["Connection test", "Install tool check"]);
  const live = (await sessions.listSessions())
    .filter((session) => !session.deletedAt && !testTitles.has(session.title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SWEEP_THREADS);

  const touched = new Set<string>();
  for (const session of live) {
    result.threads += 1;
    // `distillSession` itself skips a thread whose entry count has not moved since the last pass, so this
    // loop only decides which threads are worth asking about.
    if (await sessions.sessionBusy(session.id).catch(() => true)) continue;
    const learned = await distillSession(session.id).catch(() => undefined);
    if (!learned || learned.skipped) continue;
    result.distilled += 1;
    result.preferences += learned.preferences.length;
    result.memory += learned.memory.length;
    result.lessons += learned.lessons.length;
    if (learned.agentId && learned.lessons.length > 0) touched.add(learned.agentId);
  }

  for (const agentId of touched) {
    const kept = await consolidateLessons(agentId).catch(() => null);
    if (kept) result.consolidated.push(agentId);
  }
  if (result.distilled > 0) log.info("learning.sweep", result);
  return result;
}

/**
 * The background loop: one sweep shortly after boot, then every `learning.sweepMinutes`.
 *
 * The boot pass is the important one — it is what catches up on everything learned before the last restart,
 * which the in-memory idle timers could not.
 */
export function startLearningLoop(): void {
  if (sweepTimer) return;
  const run = (): void => {
    void sweepLearning().catch(() => undefined);
  };
  // Boot is busy (harness resume, bots, MCP); let it settle before spending a model call.
  const kickoff = setTimeout(run, 45_000);
  kickoff.unref?.();
  const minutes = Math.max(1, Number(process.env.DURA_LEARNING_SWEEP_MINUTES) || 0);
  const schedule = (): void => {
    void readConfig({ fresh: true })
      .then((config) => {
        const every = minutes || Math.max(1, Number(config.learning.sweepMinutes) || 30);
        sweepTimer = setInterval(run, every * 60_000);
        sweepTimer.unref?.();
      })
      .catch(() => undefined);
  };
  schedule();
}

export function stopLearningLoop(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/* --------------------------------- idle scheduling --------------------------------- */

const idleTimers = new Map<string, NodeJS.Timeout>();

async function runIdle(conversationId: string): Promise<void> {
  const sessions = await import("./sessions.ts");
  const config = await readConfig({ fresh: true });
  if (!config.learning.auto) return;
  if (await sessions.sessionBusy(conversationId).catch(() => true)) return;
  await distillSession(conversationId).catch(() => undefined);
}

/**
 * Called whenever a thread settles. Each call restarts the countdown, so a burst of turns costs one call
 * after the conversation actually stops rather than one call per turn.
 */
export function scheduleLearning(conversationId: string): void {
  void (async () => {
    const config = await readConfig({ fresh: true });
    if (!config.learning.auto) return;
    const delay = Math.max(1, Number(config.learning.idleMinutes) || 10) * 60_000;
    const running = idleTimers.get(conversationId);
    if (running) clearTimeout(running);
    const timer = setTimeout(() => {
      idleTimers.delete(conversationId);
      void runIdle(conversationId);
    }, delay);
    // The daemon must be able to exit while a countdown is pending.
    timer.unref?.();
    idleTimers.set(conversationId, timer);
  })().catch(() => undefined);
}

/** Drop a pending countdown, for a thread that was deleted or moved. */
export function cancelLearning(conversationId: string): void {
  const running = idleTimers.get(conversationId);
  if (!running) return;
  clearTimeout(running);
  idleTimers.delete(conversationId);
}
