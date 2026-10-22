import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { agentResolver } from "./remember.ts";
import {
  DisplayError,
  displaySnapshot,
  resetDisplay,
  updateDisplay,
  type DisplayPatch,
} from "./display.ts";

/**
 * The customize_ui tool.
 *
 * It edits the saved global display, not the source tree: a closed token set plus a bounded CSS layer. Changes
 * are durable and are broadcast to every open tab, so the owner needs at most a refresh to see them. There is no
 * build and no server restart, and the owner can reset from System or with ?display=default.
 */
function refusal(message: string): { output: { type: "text"; text: string }[]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

export const customizeUiTool = defineTool({
  name: "customize_ui",
  description:
    "Change the global dura-agents display: product name, tagline, logo emoji, hex colours, font, density, " +
    "radius, and a bounded custom CSS layer. The change is saved under data/display.json and applied live; the " +
    "owner only needs a refresh if a tab missed the socket frame. Use reset: true to restore the defaults.",
  parameters: Type.Object({
    displayName: Type.Optional(Type.String({ description: "Product name, at most 40 characters." })),
    tagline: Type.Optional(Type.String({ description: "Short subtitle, at most 160 characters." })),
    logo: Type.Optional(Type.String({ description: "Optional short emoji or glyph shown beside the name." })),
    accent: Type.Optional(Type.String({ description: "Hex accent colour, for example #e0a35c." })),
    background: Type.Optional(Type.String({ description: "Hex page background." })),
    panel: Type.Optional(Type.String({ description: "Hex panel surface." })),
    text: Type.Optional(Type.String({ description: "Hex main text colour." })),
    muted: Type.Optional(Type.String({ description: "Hex muted text colour." })),
    font: Type.Optional(Type.String({ description: "geist, system, serif or mono." })),
    density: Type.Optional(Type.String({ description: "compact, comfortable or spacious." })),
    radius: Type.Optional(Type.Number({ description: "Corner radius in pixels, 0 to 28." })),
    customCss: Type.Optional(
      Type.String({
        description:
          "Bounded CSS (max 20k). No @import, url(), remote URLs, @font-face, javascript:, expression() or behavior.",
      }),
    ),
    reset: Type.Optional(Type.Boolean({ description: "Restore the default display and ignore the other fields." })),
  }),
  async execute(args, api) {
    try {
      const by = (await agentResolver()?.(String(api.conversationId))) ?? "agent";
      if (args.reset) {
        const display = await resetDisplay(by);
        return {
          output: [{ type: "text", text: "Display reset to the defaults." }],
          details: { display },
        };
      }
      const patch: DisplayPatch = {
        ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
        ...(args.tagline === undefined ? {} : { tagline: args.tagline }),
        ...(args.logo === undefined ? {} : { logo: args.logo }),
        ...(args.accent === undefined ? {} : { accent: args.accent }),
        ...(args.background === undefined ? {} : { background: args.background }),
        ...(args.panel === undefined ? {} : { panel: args.panel }),
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.muted === undefined ? {} : { muted: args.muted }),
        ...(args.font === undefined ? {} : { font: args.font as DisplayPatch["font"] }),
        ...(args.density === undefined ? {} : { density: args.density as DisplayPatch["density"] }),
        ...(args.radius === undefined ? {} : { radius: args.radius }),
        ...(args.customCss === undefined ? {} : { customCss: args.customCss }),
      };
      if (Object.keys(patch).length === 0) {
        return refusal("Nothing to change: supply at least one display field or reset: true.");
      }
      const display = await updateDisplay(patch, by);
      const changed = Object.keys(patch).join(", ");
      return {
        output: [
          {
            type: "text",
            text:
              "Global display updated (" +
              changed +
              "). Open tabs apply it live; a refresh shows it in any tab that missed the frame. " +
              "The owner can reset it from System or with ?display=default.",
          },
        ],
        details: { display },
      };
    } catch (error) {
      if (error instanceof DisplayError) return refusal(error.message);
      return refusal("Could not update the display: " + String(error).slice(0, 300));
    }
  },
});

export const displayTools: ToolRegistration[] = [customizeUiTool];

export const displayToolsExtension = defineExtension({
  name: "display",
  tools: displayTools,
});

/** Used by the API route to explain the current theme in a health-style response if needed. */
export async function currentDisplay() {
  return displaySnapshot();
}