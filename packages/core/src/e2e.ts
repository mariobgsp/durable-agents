import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxContentBlock,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { models } from "./models.ts";

/**
 * Deterministic E2E mode (`PI_E2E=1`).
 *
 * Replaces every real provider with the official faux provider, so the whole stack — HTTP, WS,
 * pi-durable, SQLite — can be driven with scripted model answers: no network, no cost, no flakiness.
 * Two models are defined on purpose: one that accepts images and one that does not, which is how the
 * image pre-flight is tested.
 */
export const E2E_PROVIDER = "e2e";
export const E2E_VISION_MODEL = "faux-vision";
export const E2E_TEXT_MODEL = "faux-text";

/** One scripted answer. `echo` answers with something the model was actually given. */
export type E2EStep = {
  text?: string;
  thinking?: string;
  toolCall?: { name: string; arguments?: Record<string, unknown>; id?: string };
  error?: string;
  echo?: "model" | "systemPrompt" | "lastUser" | "images" | "tools";
};

let handle: FauxProviderHandle | undefined;

export function enableE2E(): void {
  if (handle) return;
  handle = fauxProvider({
    provider: E2E_PROVIDER,
    // Stream at a realistic pace: an instant answer would never appear as a committed partial, so the
    // streaming path (pi.live -> delta frames) would go untested. The benchmark turns the pace off:
    // it drives multi-hundred-kilobyte tool arguments, and 12 tokens/s would measure the faux
    // provider's clock instead of memory.
    tokensPerSecond: process.env.DURA_BENCH === "1" ? 1_000_000 : 12,
    tokenSize: { min: 2, max: 4 },
    models: [
      {
        id: E2E_VISION_MODEL,
        name: "Faux Vision",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
      {
        id: E2E_TEXT_MODEL,
        name: "Faux Text",
        input: ["text"],
        reasoning: false,
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    ],
  });
  models.clearProviders();
  models.setProvider(handle.provider);
}

export function setE2EScript(steps: readonly E2EStep[]): void {
  if (!handle) throw new Error("E2E mode is not enabled");
  handle.setResponses(steps.map(stepToResponse));
}

/**
 * Benchmark mode: every conversation runs the same scripted "complex task" — a CPU-bound shell
 * loop, a multi-hundred-kilobyte file write and read, a memory note, and a short sleep — then a
 * final answer. The factory reads the conversation's own transcript, so five concurrent agents do
 * not consume each other's steps.
 */
export function enableBench(): void {
  if (!handle) throw new Error("E2E mode is not enabled");
  const factory = (context: unknown) => {
    const messages = messagesOf(context);
    // A compaction call is a separate summarisation request. It must answer with text; a tool call
    // there is rejected by the harness and fails the whole run ("Summarization attempted to call a tool").
    if (/summar|compact/i.test(systemPromptOf(context))) {
      return fauxAssistantMessage("Concise summary of the earlier transcript.");
    }
    // Count all messages, not a particular role name: the provider's transcript context spells tool
    // results differently across versions, while "one assistant + one result per round" is stable.
    const rounds = Math.floor(messages.length / 2);
    if (messages.length >= 18) return fauxAssistantMessage("Benchmark task complete.");
    const tool: { name: string; arguments: Record<string, unknown> } =
      rounds % 4 === 0
        ? { name: "bash", arguments: { command: "for i in $(seq 1 300000); do :; done" } }
        : rounds % 4 === 1
          ? { name: "write", arguments: { path: "bench.txt", content: "x".repeat(20_000) } }
          : rounds % 4 === 2
            ? { name: "read", arguments: { path: "bench.txt" } }
            : { name: "remember", arguments: { note: "bench run " + rounds + " at " + Date.now() } };
    return fauxAssistantMessage(fauxToolCall(tool.name, tool.arguments as Parameters<typeof fauxToolCall>[1]), { stopReason: "toolUse" });
  };
  // The faux provider consumes its queue one entry per model request. A single factory would answer
  // one call and leave every later generation pending; 200 identical factories cover five agents
  // doing eight tool rounds each with room to spare.
  handle.setResponses(Array.from({ length: 200 }, () => factory));
}

export function e2eState(): { callCount: number; pending: number } {
  if (!handle) return { callCount: 0, pending: 0 };
  return { callCount: handle.state.callCount, pending: handle.getPendingResponseCount() };
}

/** Text of a content value: a string, one block, or a list of blocks. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") {
    const block = value as { text?: unknown; content?: unknown };
    if (typeof block.text === "string") return block.text;
    if (block.content !== undefined) return textOf(block.content);
  }
  return "";
}

function messagesOf(context: unknown): readonly unknown[] {
  if (!context || typeof context !== "object") return [];
  const messages = (context as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function systemPromptOf(context: unknown): string {
  if (context && typeof context === "object") {
    const direct = (context as { systemPrompt?: unknown }).systemPrompt;
    if (typeof direct === "string" && direct.length > 0) return direct;
  }
  return messagesOf(context)
    .filter((message) => (message as { role?: unknown }).role === "system")
    .map((message) => textOf((message as { content?: unknown }).content))
    .join("\n");
}

function countImages(context: unknown): number {
  let images = 0;
  for (const message of messagesOf(context)) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") images += 1;
    }
  }
  return images;
}

function stepToResponse(step: E2EStep): FauxResponseStep {
  if (step.echo !== undefined) {
    const echo = step.echo;
    return (context, _options, _state, model) => {
      if (echo === "model") return fauxAssistantMessage(model.id);
      if (echo === "systemPrompt") return fauxAssistantMessage(systemPromptOf(context).slice(0, 4000) || "(empty)");
      if (echo === "images") return fauxAssistantMessage("images: " + countImages(context));
      if (echo === "tools") return fauxAssistantMessage(systemPromptOf(context).slice(0, 4000) || "(empty)");
      const last = [...messagesOf(context)].reverse().find((message) => (message as { role?: unknown }).role === "user");
      return fauxAssistantMessage(last ? textOf((last as { content?: unknown }).content).slice(0, 4000) : "(none)");
    };
  }
  if (step.error !== undefined) {
    return fauxAssistantMessage(step.error, { stopReason: "error", errorMessage: step.error });
  }
  const blocks: FauxContentBlock[] = [];
  if (step.thinking) blocks.push(fauxThinking(step.thinking));
  if (step.text) blocks.push(fauxText(step.text));
  if (step.toolCall) {
    const call = step.toolCall;
    blocks.push(
      fauxToolCall(
        call.name,
        (call.arguments ?? {}) as Parameters<typeof fauxToolCall>[1],
        call.id === undefined ? undefined : { id: call.id },
      ),
    );
  }
  // A message that carries a tool call must say so: `stopReason` is what tells the harness the turn is not
  // over and a tool has to run. Left at "stop", a scripted tool call is scrolled into the transcript and
  // never executed, which is how a `toolCall` step would look broken rather than test the tool path.
  return fauxAssistantMessage(blocks.length > 0 ? blocks : fauxText("(empty)"), {
    ...(step.toolCall ? { stopReason: "toolUse" as const } : {}),
  });
}
