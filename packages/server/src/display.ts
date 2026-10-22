import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath } from "./paths.ts";

/**
 * The owner's global display, chosen by an agent or reset from the System panel.
 *
 * This is intentionally not source code. It is a closed set of tokens plus a bounded CSS layer, applied live by
 * the client and persisted in data/display.json. A change needs no build and no restart: the page sees it on the
 * next flush of the presence socket, or on its next refresh.
 */
export type DisplayFont = "geist" | "system" | "serif" | "mono";
export type DisplayDensity = "compact" | "comfortable" | "spacious";

export type DisplayTheme = {
  displayName: string;
  tagline: string;
  logo: string;
  accent: string;
  background: string;
  panel: string;
  text: string;
  muted: string;
  font: DisplayFont;
  density: DisplayDensity;
  radius: number;
  customCss: string;
};

export type DisplaySnapshot = DisplayTheme & {
  updatedAt: number;
  updatedBy?: string;
};

export type DisplayPatch = Partial<DisplayTheme>;

export const DEFAULT_DISPLAY: DisplayTheme = {
  displayName: "dura-agents",
  tagline: "durable agent work",
  logo: "",
  accent: "#e0a35c",
  background: "#000000",
  panel: "#0a0b0d",
  text: "#ecedef",
  muted: "#8b9096",
  font: "geist",
  density: "comfortable",
  radius: 10,
  customCss: "",
};

export class DisplayError extends Error {
  readonly code: string;
  readonly status: 400;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DisplayError";
    this.code = code;
    this.status = 400;
  }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONTS: DisplayFont[] = ["geist", "system", "serif", "mono"];
const DENSITIES: DisplayDensity[] = ["compact", "comfortable", "spacious"];
const CSS_LIMIT = 20_000;
const UNSAFE_CSS = /@import|url\s*\(|https?:\/\/|\/\/|javascript:|expression\s*\(|behavior\s*:|-moz-binding|@font-face/i;

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new DisplayError("invalid_" + field, field + " must be text");
  const clean = value.trim();
  if (clean.length > max) throw new DisplayError("invalid_" + field, field + " is longer than " + max + " characters");
  return clean;
}

function color(value: unknown, field: string): string {
  const clean = text(value, 9, field);
  if (!HEX.test(clean)) throw new DisplayError("invalid_" + field, field + " must be a hex colour such as #e0a35c");
  return clean;
}

function font(value: unknown): DisplayFont {
  if (typeof value !== "string" || !FONTS.includes(value as DisplayFont)) {
    throw new DisplayError("invalid_font", "font must be geist, system, serif or mono");
  }
  return value as DisplayFont;
}

function density(value: unknown): DisplayDensity {
  if (typeof value !== "string" || !DENSITIES.includes(value as DisplayDensity)) {
    throw new DisplayError("invalid_density", "density must be compact, comfortable or spacious");
  }
  return value as DisplayDensity;
}

function radius(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 28) {
    throw new DisplayError("invalid_radius", "radius must be between 0 and 28");
  }
  return Math.round(number);
}

/** The CSS layer is deliberately channel and network free: colours, layout, spacing and type only. */
export function sanitizeCustomCss(value: unknown): string {
  if (value === undefined) return "";
  const css = text(value, CSS_LIMIT, "customCss");
  if (UNSAFE_CSS.test(css)) {
    throw new DisplayError(
      "unsafe_css",
      "custom CSS may not use @import, url(), remote URLs, @font-face, javascript:, expression() or behavior",
    );
  }
  return css;
}

function themeOf(value: Partial<DisplayTheme>): DisplayTheme {
  return {
    displayName: value.displayName ?? DEFAULT_DISPLAY.displayName,
    tagline: value.tagline ?? DEFAULT_DISPLAY.tagline,
    logo: value.logo ?? DEFAULT_DISPLAY.logo,
    accent: value.accent ?? DEFAULT_DISPLAY.accent,
    background: value.background ?? DEFAULT_DISPLAY.background,
    panel: value.panel ?? DEFAULT_DISPLAY.panel,
    text: value.text ?? DEFAULT_DISPLAY.text,
    muted: value.muted ?? DEFAULT_DISPLAY.muted,
    font: value.font ?? DEFAULT_DISPLAY.font,
    density: value.density ?? DEFAULT_DISPLAY.density,
    radius: value.radius ?? DEFAULT_DISPLAY.radius,
    customCss: value.customCss ?? DEFAULT_DISPLAY.customCss,
  };
}

function applyPatch(current: DisplaySnapshot, patch: DisplayPatch): DisplayTheme {
  const next = themeOf(current);
  if (patch.displayName !== undefined) next.displayName = text(patch.displayName, 40, "displayName") || DEFAULT_DISPLAY.displayName;
  if (patch.tagline !== undefined) next.tagline = text(patch.tagline, 160, "tagline");
  if (patch.logo !== undefined) next.logo = text(patch.logo, 8, "logo");
  if (patch.accent !== undefined) next.accent = color(patch.accent, "accent");
  if (patch.background !== undefined) next.background = color(patch.background, "background");
  if (patch.panel !== undefined) next.panel = color(patch.panel, "panel");
  if (patch.text !== undefined) next.text = color(patch.text, "text");
  if (patch.muted !== undefined) next.muted = color(patch.muted, "muted");
  if (patch.font !== undefined) next.font = font(patch.font);
  if (patch.density !== undefined) next.density = density(patch.density);
  if (patch.radius !== undefined) next.radius = radius(patch.radius);
  if (patch.customCss !== undefined) next.customCss = sanitizeCustomCss(patch.customCss);
  return next;
}

type DisplayRecord = DisplayTheme & { version: 1; updatedAt: number; updatedBy?: string };

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function readRecord(): Promise<DisplayRecord> {
  try {
    const parsed = JSON.parse(await readFile(displayPath, "utf8")) as Partial<DisplayRecord>;
    const theme = themeOf({
      ...(typeof parsed.displayName === "string" ? { displayName: parsed.displayName } : {}),
      ...(typeof parsed.tagline === "string" ? { tagline: parsed.tagline } : {}),
      ...(typeof parsed.logo === "string" ? { logo: parsed.logo } : {}),
      ...(typeof parsed.accent === "string" && HEX.test(parsed.accent) ? { accent: parsed.accent } : {}),
      ...(typeof parsed.background === "string" && HEX.test(parsed.background) ? { background: parsed.background } : {}),
      ...(typeof parsed.panel === "string" && HEX.test(parsed.panel) ? { panel: parsed.panel } : {}),
      ...(typeof parsed.text === "string" && HEX.test(parsed.text) ? { text: parsed.text } : {}),
      ...(typeof parsed.muted === "string" && HEX.test(parsed.muted) ? { muted: parsed.muted } : {}),
      ...(typeof parsed.font === "string" && FONTS.includes(parsed.font as DisplayFont) ? { font: parsed.font as DisplayFont } : {}),
      ...(typeof parsed.density === "string" && DENSITIES.includes(parsed.density as DisplayDensity)
        ? { density: parsed.density as DisplayDensity }
        : {}),
      ...(typeof parsed.radius === "number" ? { radius: parsed.radius } : {}),
      ...(typeof parsed.customCss === "string" && !UNSAFE_CSS.test(parsed.customCss) ? { customCss: parsed.customCss.slice(0, CSS_LIMIT) } : {}),
    });
    return {
      ...theme,
      version: 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      ...(typeof parsed.updatedBy === "string" ? { updatedBy: parsed.updatedBy.slice(0, 80) } : {}),
    };
  } catch {
    return { ...DEFAULT_DISPLAY, version: 1, updatedAt: Date.now() };
  }
}

async function writeRecord(record: DisplayRecord): Promise<void> {
  await mkdir(dirname(displayPath), { recursive: true });
  const tmp = displayPath + ".tmp";
  await writeFile(tmp, JSON.stringify(record, null, 2));
  await rename(tmp, displayPath);
}

const listeners = new Set<() => void>();
export function subscribeDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A broken listener must not stop a display update. */
    }
  }
}

export async function displaySnapshot(): Promise<DisplaySnapshot> {
  const record = await readRecord();
  const { version: _version, ...snapshot } = record;
  return snapshot;
}

export async function updateDisplay(patch: DisplayPatch, updatedBy?: string): Promise<DisplaySnapshot> {
  const current = await readRecord();
  const nextTheme = applyPatch(current, patch);
  const next: DisplayRecord = {
    ...nextTheme,
    version: 1,
    updatedAt: Date.now(),
    ...(updatedBy ? { updatedBy: updatedBy.slice(0, 80) } : {}),
  };
  await serialize(() => writeRecord(next));
  emit();
  const { version: _version, ...snapshot } = next;
  return snapshot;
}

export async function resetDisplay(updatedBy?: string): Promise<DisplaySnapshot> {
  return updateDisplay({ ...DEFAULT_DISPLAY }, updatedBy ?? "owner");
}