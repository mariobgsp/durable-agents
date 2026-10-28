import { readAgent } from "./agents.ts";
import { models, resolveDefaultModel } from "./models.ts";
import { recordStatelessUsage } from "./usage-ledger.ts";

export type Claim = { member: string; claim: boolean; confidence: number; reason: string };
export type Oversight = { member: string; add: boolean; text: string };

function textOf(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      const value: unknown = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text.trim();
}

/**
 * Stateless model call (no conversation). `sessionId` is required: the opencode provider
 * rejects requests without a session header.
 */
async function shortCall(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  attribution: { agentId?: string; source: string },
): Promise<string> {
  const ref = await resolveDefaultModel();
  const model = await models.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error("model unavailable: " + ref.provider + "/" + ref.modelId);
  const answer = await models.completeSimple(
    model,
    { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
    { sessionId: "nyahut", maxTokens },
  );
  // This call has no conversation entry of its own, so its spend goes to the stateless ledger.
  const usage = (answer as { usage?: unknown } | undefined)?.usage;
  if (usage) {
    await recordStatelessUsage({
      source: attribution.source,
      ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
      provider: ref.provider,
      modelId: ref.modelId,
      usage: usage as Parameters<typeof recordStatelessUsage>[0]["usage"],
      at: (answer as { timestamp?: unknown }).timestamp as number | undefined,
    });
  }
  return textOf(answer);
}

function firstJson(raw: string): Record<string, unknown> | null {
  // Greedy on purpose: a single JSON object ends at the LAST closing brace, and a nested
  // brace inside a reason string would truncate a non-greedy match.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read {claim, confidence, reason}. When the JSON is truncated or incomplete, the
 * value is read straight from the text with a regex; keyword guessing is the last
 * resort, because a reason sentence can contain a negation that misleads it.
 */
export function parseClaim(raw: string): Omit<Claim, "member"> {
  const parsed = firstJson(raw);
  if (parsed) {
    const claim = parsed["claim"] === true || parsed["claim"] === "true";
    const confidenceRaw = parsed["confidence"];
    const confidence =
      typeof confidenceRaw === "number" ? Math.max(0, Math.min(1, confidenceRaw)) : claim ? 0.6 : 0.2;
    const reasonRaw = parsed["reason"];
    return { claim, confidence, reason: typeof reasonRaw === "string" ? reasonRaw.slice(0, 90) : "" };
  }
  const direct = raw.match(/"?claim"?\s*[:=]\s*"?(true|false|ya|tidak|yes|no)/i); // lang-allow: recognises Indonesian keywords in model output
  if (direct?.[1]) {
    const value = direct[1].toLowerCase();
    const claim = value === "true" || value === "ya" || value === "yes";
    return { claim, confidence: claim ? 0.55 : 0.15, reason: "(incomplete format)" };
  }
  const lower = raw.toLowerCase().slice(0, 200);
  const negative = /\b(tidak|bukan|no|not|nope|false|outside|unrelated)\b/.test(lower); // lang-allow: keyword list
  const positive = /\b(ya|yes|true|responsible|mine|my area)\b/.test(lower); // lang-allow: keyword list
  const claim = positive && !negative;
  return { claim, confidence: claim ? 0.4 : 0.1, reason: "(no format)" };
}

/** Nyahut phase 1: every member judges whether this message is theirs. A failure means no claim. */
export async function claimAll(
  members: readonly string[],
  question: string,
  digest: string,
): Promise<Claim[]> {
  const results = await Promise.all(
    members.map(async (member): Promise<Claim> => {
      const files = await readAgent(member);
      if (!files) return { member, claim: false, confidence: 0, reason: "agent not found" };
      const scope = (files.record.responsibility ?? files.soulMd.slice(0, 600)).trim() || "(not set)";
      try {
        const raw = await shortCall(
          'You judge whether a message in a group falls inside your area of responsibility. Reply with JSON ONLY: {"claim": true or false, "confidence": 0..1, "reason": "max 12 words"}.',
          "Name: " +
            member +
            "\nArea of responsibility: " +
            scope +
            "\n\nNewest message in the group:\n" +
            question +
            "\n\nRecent conversation:\n" +
            digest.slice(-1200),
          300,
          { agentId: member, source: "nyahut-claim" },
        );
        return { member, ...parseClaim(raw) };
      } catch (error) {
        return { member, claim: false, confidence: 0, reason: "judge failed: " + String(error).slice(0, 60) };
      }
    }),
  );
  return results;
}

/** Nyahut phase 3: non-responders may add at most one sentence, once per message. */
export async function overseeAll(
  members: readonly string[],
  question: string,
  answers: readonly { author: string; text: string }[],
): Promise<Oversight[]> {
  const transcript = answers.map((answer) => answer.author + ": " + answer.text).join("\n");
  return Promise.all(
    members.map(async (member): Promise<Oversight> => {
      try {
        const raw = await shortCall(
          'You are an overseer in a group chat. Read the user question and the answers other members gave. Add at most one sentence ONLY when an answer is wrong, unsafe, or misses something important the user needs. If the answers are fine, add nothing. Reply with JSON ONLY: {"add": true or false, "text": "your one-sentence addition"}.',
          "You are " +
            member +
            ".\n\nUser message:\n" +
            question +
            "\n\nOther members\' answers:\n" +
            transcript.slice(-1600),
          400,
          { agentId: member, source: "nyahut-oversee" },
        );
        const parsed = firstJson(raw);
        if (!parsed) {
          // Stay safe (no addition), but leave a trail: an unparsable answer is usually a truncated one.
          console.warn("oversee: unparsable answer from " + member + ": " + raw.slice(0, 120));
          return { member, add: false, text: "" };
        }
        const add = parsed["add"] === true || parsed["add"] === "true";
        const text = typeof parsed["text"] === "string" ? parsed["text"].trim() : "";
        return { member, add: add && text.length > 0, text: text.slice(0, 400) };
      } catch {
        return { member, add: false, text: "" };
      }
    }),
  );
}