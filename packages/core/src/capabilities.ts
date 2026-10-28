import { models } from "./models.ts";

/**
 * Model capabilities, read from the catalog that pi-ai resolved for this process.
 *
 * This is the only reliable way to know what a model accepts: `model.input` lists its modalities
 * (`["text", "image"]` for the providers we use) and `model.inputLimits.images.resize` its image
 * limits. pi-ai silently replaces an image with "(image omitted: model does not support images)" when
 * a model cannot see it, so the app has to check before sending.
 */
export type ModelRefLike = { provider: string; modelId: string };

export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
  input: string[];
  canSeeImages: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number };
  /** Thinking levels this model actually supports; `null` in the map means unsupported. */
  thinkingLevels: string[];
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  cost?: { input?: unknown; output?: unknown };
  thinkingLevelMap?: Record<string, unknown>;
};

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numbersOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function rawModel(ref: ModelRefLike): RawModel | undefined {
  return models.getModel(ref.provider, ref.modelId) as RawModel | undefined;
}

/** Does this model accept images? Unknown models are treated as text-only. */
export function canSeeImages(ref: ModelRefLike): boolean {
  return stringsOf(rawModel(ref)?.input).includes("image");
}

export type ImageLimits = {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  jpegQuality: number;
  maxPerMessage: number;
};

/** Image limits for one model, with the same defaults pi-durable's `read` tool uses. */
export function imageLimits(ref: ModelRefLike): ImageLimits {
  const limits = (
    rawModel(ref) as
      | { inputLimits?: { images?: { resize?: Record<string, unknown>; maxPerMessage?: unknown } } }
      | undefined
  )?.inputLimits?.images;
  const resize = limits?.resize ?? {};
  return {
    maxWidth: numbersOf(resize["maxWidth"]) ?? 1568,
    maxHeight: numbersOf(resize["maxHeight"]) ?? 1568,
    maxBytes: numbersOf(resize["maxBytes"]) ?? 4_500_000,
    jpegQuality: numbersOf(resize["jpegQuality"]) ?? 82,
    maxPerMessage: numbersOf(limits?.maxPerMessage) ?? 6,
  };
}

/** Whether this thread may send images at all, and the limits to normalize them to. */
export type ImagePolicy =
  | { allowed: true; limits: ImageLimits }
  | { allowed: false; code: "images_unsupported" | "vision_off"; reason: string };

/**
 * One answer for the pre-flight and for the refusal, so the 400 and any UI hint cannot disagree.
 *
 * pi-ai silently replaces an image with "(image omitted: model does not support images)" instead of
 * failing, so the refusal has to be ours and it has to happen before anything is durable. `visionOff` is
 * the agent's own `agent.json` switch; this is what finally enforces it.
 */
export function imagePolicy(ref: ModelRefLike, visionOff: boolean): ImagePolicy {
  if (visionOff) {
    return { allowed: false, code: "vision_off", reason: "This agent is set to vision: off." };
  }
  if (!canSeeImages(ref)) {
    return {
      allowed: false,
      code: "images_unsupported",
      reason: `You cannot send images to ${ref.provider}/${ref.modelId}.`,
    };
  }
  return { allowed: true, limits: imageLimits(ref) };
}

function thinkingLevelsOf(model: RawModel): string[] {
  const map = model.thinkingLevelMap;
  if (!map) return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return Object.entries(map)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([level]) => level);
}

/** Every model the provider currently exposes, with the capability flags the editor needs. */
export async function modelCatalog(providerId: string): Promise<ModelInfo[]> {
  let available: readonly unknown[] = [];
  try {
    available = await models.getAvailable(providerId);
  } catch {
    return [];
  }
  return available.map((entry) => {
    const model = entry as RawModel;
    const input = stringsOf(model.input);
    return {
      provider: providerId,
      id: typeof model.id === "string" ? model.id : "unknown",
      name: typeof model.name === "string" ? model.name : String(model.id ?? "unknown"),
      input,
      canSeeImages: input.includes("image"),
      contextWindow: numbersOf(model.contextWindow),
      maxTokens: numbersOf(model.maxTokens),
      reasoning: model.reasoning === true,
      cost: {
        input: numbersOf(model.cost?.input) ?? 0,
        output: numbersOf(model.cost?.output) ?? 0,
      },
      thinkingLevels: thinkingLevelsOf(model),
    };
  });
}
