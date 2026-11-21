/**
 * Fast keyword/recency recall over an agent's MEMORY.md notes.
 *
 * The full memory already renders into the system prompt at session setup; this covers the per-turn gap:
 * given the owner's latest message, pick the few saved notes worth re-reading. Scoring is keyword overlap
 * with a recency tilt, so it runs in microseconds with no model call and no dependency. Output is bounded
 * (few notes, capped characters) and empty when nothing matches, so unrelated turns cost nothing.
 */

/** Notes riding along with one turn; the system prompt keeps carrying the full set. */
const MAX_RECALL_NOTES = 5;

/** Hard cap on recalled characters, so one turn cannot blow the context budget. */
const MAX_RECALL_CHARS = 1500;

/** The saved-note lines of a MEMORY.md file, oldest first. Shared with the prompt render. */
export function memoryNotes(memoryMd: string): string[] {
  return memoryMd
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

/** Function words carry no signal; without this, "the" matches every note. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "what", "when", "where", "which", "who", "how",
  "why", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "at", "for",
  "with", "as", "by", "from", "it", "its", "this", "that", "these", "those", "you", "your",
  "they", "them", "their", "we", "our", "he", "she", "him", "her", "his", "do", "does",
  "did", "not", "no", "yes", "so", "if", "then", "than", "too", "very", "can", "will",
  "just", "me", "my", "over", "under", "into", "out", "about",
]);

/** Lowercase alphanumeric tokens; short fragments add noise, not signal. */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/**
 * The notes most relevant to the query, best first. Dedupe keeps the newest copy; the position bonus
 * breaks overlap ties toward newer notes. Returns [] when there is nothing worth recalling.
 */
export function recallMemories(memoryMd: string, query: string, limit = MAX_RECALL_NOTES): string[] {
  const notes = memoryNotes(memoryMd);
  const queryKeys = keywords(query);
  if (notes.length === 0 || queryKeys.size === 0) return [];

  const seen = new Set<string>();
  const unique: { note: string; index: number }[] = [];
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index] as string;
    const key = note.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ note, index });
  }

  const scored: { note: string; score: number }[] = [];
  for (const { note, index } of unique) {
    const noteKeys = keywords(note);
    let overlap = 0;
    for (const key of queryKeys) {
      if (noteKeys.has(key)) overlap += 1;
    }
    if (overlap === 0) continue;
    scored.push({ note, score: overlap + index / notes.length });
  }
  scored.sort((a, b) => b.score - a.score);

  const picked: string[] = [];
  let chars = 0;
  for (const { note } of scored.slice(0, Math.max(0, limit))) {
    if (chars + note.length > MAX_RECALL_CHARS) break;
    picked.push(note);
    chars += note.length;
  }
  return picked;
}

/**
 * Model-only context block for one turn, or "" when nothing matches. Empty means the caller sends
 * the message exactly as before: no behavior change, no extra tokens.
 */
export function recallBlock(memoryMd: string, query: string): string {
  const notes = recallMemories(memoryMd, query);
  if (notes.length === 0) return "";
  return ["Relevant notes you saved earlier:", "", ...notes].join("\n");
}
