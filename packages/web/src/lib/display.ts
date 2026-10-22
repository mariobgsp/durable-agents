import type { DisplayDensity, DisplayFont, DisplaySnapshot, DisplayTheme } from "../types.ts";

/**
 * Apply a saved display to the shell.
 *
 * The server owns validation; this module only translates the closed token set into the existing CSS variables.
 * It is intentionally not an arbitrary-code loader: customCss is a style tag, with the network/channel features
 * rejected server-side. A tab that misses the socket frame still gets the same result on refresh because the
 * source of truth is data/display.json, fetched during boot.
 */
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

const FONT_STACKS: Record<DisplayFont, string> = {
  geist: '"Geist Variable", system-ui, sans-serif',
  system: "system-ui, -apple-system, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: '"Geist Mono Variable", ui-monospace, monospace',
};

const MONO_STACK = '"Geist Mono Variable", ui-monospace, monospace';

export function displayBypassed(): boolean {
  return new URLSearchParams(location.search).has("display");
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16) / 255;
  const g = Number.parseInt(raw.slice(2, 4), 16) / 255;
  const b = Number.parseInt(raw.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Apply one saved display, or the defaults when ?display=default asks for a safe recovery view. */
export function applyDisplay(display: DisplaySnapshot | DisplayTheme): void {
  const theme = displayBypassed() ? DEFAULT_DISPLAY : display;
  const root = document.documentElement;
  const style = root.style;
  style.setProperty("--bg", theme.background);
  style.setProperty("--panel", theme.panel);
  style.setProperty("--panel-2", "color-mix(in srgb, " + theme.panel + " 82%, " + theme.text + " 18%)");
  style.setProperty("--text", theme.text);
  style.setProperty("--muted", theme.muted);
  style.setProperty("--accent", theme.accent);
  style.setProperty("--line", "color-mix(in srgb, " + theme.text + " 9%, transparent)");
  style.setProperty("--line-strong", "color-mix(in srgb, " + theme.text + " 14%, transparent)");
  style.setProperty("--line-active", "color-mix(in srgb, " + theme.text + " 26%, transparent)");
  style.setProperty("--paper", theme.text);
  style.setProperty("--paper-dim", theme.muted);
  style.setProperty("--ink", theme.background);
  style.setProperty("--font-sans", FONT_STACKS[theme.font]);
  if (theme.font === "mono") style.setProperty("--font-mono", MONO_STACK);
  else style.removeProperty("--font-mono");
  style.setProperty("--r-lg", theme.radius + 10 + "px");
  style.setProperty("--r-md", theme.radius + 4 + "px");
  style.setProperty("--r-sm", theme.radius + "px");
  root.dataset.density = theme.density;
  root.style.colorScheme = luminance(theme.background) > 0.55 ? "light" : "dark";
  document.title = theme.displayName;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme.background);

  let custom = document.getElementById("agent-display-css") as HTMLStyleElement | null;
  if (!custom) {
    custom = document.createElement("style");
    custom.id = "agent-display-css";
    document.head.appendChild(custom);
  }
  custom.textContent = displayBypassed() ? "" : theme.customCss;
}

/** A display name that is always safe to render in the brand slot. */
export function brandOf(display: DisplaySnapshot | DisplayTheme | null): { name: string; logo: string; tagline: string } {
  const source = display ?? DEFAULT_DISPLAY;
  const name = source.displayName.trim() || DEFAULT_DISPLAY.displayName;
  const logo = source.logo.trim();
  const tagline = source.tagline.trim();
  return { name, logo, tagline };
}

/** Kept for a future display editor; the current owner control is Reset. */
export const DENSITY_LABEL: Record<DisplayDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};
