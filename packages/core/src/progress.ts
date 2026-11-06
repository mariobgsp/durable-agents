/**
 * The words a surface uses for what a run is doing.
 *
 * Tool names and run phases come from the harness, not from the chat platform, so their vocabulary lives
 * here: a new core tool, or a renamed phase, gets its wording in one file instead of in every transport.
 * Each surface still decides its own line format (Telegram escapes HTML, Discord escapes Markdown).
 */

/**
 * A short label for one tool call.
 *
 * The label is chosen so a trace reads like a list of actions rather than a list of tool ids: several
 * search tools collapse to `search`, and MCP tools show the server-side name without the `mcp__server__`
 * prefix the registry needs.
 */
export function toolLabel(tool: string): string {
  const name = tool.toLowerCase();
  if (name === "bash" || name === "terminal") return "bash";
  if (name === "read") return "read";
  if (name === "write" || name === "edit" || name === "create_file") return name;
  if (name === "grep" || name === "glob" || name === "find") return "search";
  if (name === "codemode" || name === "coding" || name === "browser") return name;
  if (name === "question") return "asking you";
  if (name.startsWith("mcp__")) return "mcp: " + tool.split("__").slice(2).join("__");
  if (name.startsWith("agents_")) return "team: " + name.replace("agents_", "");
  return tool;
}

/**
 * One line for a status bubble: `bash: git status`, or just the label when there is no summary.
 *
 * The summary comes from the tool's own arguments, and eight words is the budget: this is a trace the owner
 * reads in a notification, not a log. `separator` is the surface's punctuation — Telegram colon, Discord dot.
 */
export function progressLine(tool: string, summary: string | undefined, separator: string): string {
  const detail = (summary ?? "").trim().replace(/\s+/g, " ");
  const label = toolLabel(tool);
  return detail ? label + separator + detail : label;
}

/** What the run is doing, in the words the owner reads while waiting. */
export function phaseLabel(phase: string | null): string {
  if (phase === "thinking") return "\u{1F9E0} thinking…";
  if (phase === "writing") return "\u270D\uFE0F writing the answer…";
  if (phase === "compacting") return "\u{1F5DC}\uFE0F compacting the context…";
  if (phase === "retrying") return "\u{1F501} retrying…";
  if (phase === "tool") return "\u2699\uFE0F working…";
  return "starting…";
}
