/**
 * Discord formatting and message splitting.
 *
 * Agent answers are Markdown. Discord renders most of it, but not GFM tables and not Telegram's HTML.
 * The renderer deliberately converts rather than escapes: Markdown is the source of truth.
 */

const MAX_MESSAGE = 2000;
const MAX_CODE = 1990;

/** Strip HTML tags and decode the five entities Telegram's renderer can emit. */
export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isTableLine(line: string): boolean {
  return line.includes("|") && line.trim().startsWith("|");
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

/** GFM table -> fenced code, because Discord has no table renderer. */
function tablesToCode(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isTableLine(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? "")) {
      const rows: string[] = [line.trim()];
      index += 2;
      while (index < lines.length && isTableLine(lines[index] ?? "")) {
        rows.push((lines[index] ?? "").trim());
        index += 1;
      }
      index -= 1;
      out.push("```text", ...rows, "```");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Convert an agent answer to Discord Markdown.
 *
 * Discord's client understands headings, emphasis, blockquotes, lists and fences. The only lossy
 * conversion is tables; everything else is left alone so code and prose keep their shape.
 */
export function toDiscordMarkdown(value: string): string {
  return tablesToCode(stripHtml(value).replace(/\r\n/g, "\n")).trim();
}

type Fence = { marker: string; language: string } | undefined;

function openFence(line: string): Fence {
  const match = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
  if (!match) return undefined;
  return { marker: match[1] ?? "```", language: match[2] ?? "" };
}

function closesFence(line: string, fence: NonNullable<Fence>): boolean {
  return new RegExp("^\\s*" + fence.marker[0] + "{" + fence.marker.length + ",}\\s*$").test(line);
}

/**
 * Split one answer into Discord-sized messages without breaking a fenced code block.
 *
 * A chunk that starts inside a fence reopens it, and a chunk that ends inside one closes it, so every
 * message is valid Markdown on its own. Lines are preferred over arbitrary character cuts.
 */
export function splitDiscordMessage(input: string, limit = MAX_MESSAGE): string[] {
  const text = toDiscordMarkdown(input);
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let fence: Fence;

  const flush = (): void => {
    if (current.length === 0) return;
    let body = current.join("\n");
    if (fence) body += "\n" + fence.marker;
    if (body.trim().length > 0) chunks.push(body);
    current = [];
    currentLength = 0;
    if (fence) {
      current.push(fence.marker + fence.language);
      currentLength = fence.marker.length + fence.language.length;
    }
  };

  for (const line of lines) {
    const closing = fence && closesFence(line, fence) ? fence : undefined;
    const added = (currentLength > 0 ? 1 : 0) + line.length + (closing ? 0 : fence ? 1 : 0);
    if (currentLength > 0 && currentLength + added > limit) flush();
    if (line.length <= limit - currentLength) {
      current.push(line);
      currentLength += (current.length > 1 ? 1 : 0) + line.length;
    } else {
      // A single huge line (a minified JSON body, a long URL): cut it, then keep going.
      if (current.length > 0) flush();
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      if (rest.length > 0) {
        current.push(rest);
        currentLength = rest.length;
      }
    }
    if (closing) fence = undefined;
    else if (!fence) {
      const opened = openFence(line);
      if (opened) fence = opened;
    }
  }
  flush();
  return chunks;
}

/** A short progress line for the status message. */
export function progressLine(tool: string, summary?: string): string {
  const name = tool.toLowerCase();
  const label =
    name === "bash" || name === "terminal" ? "bash"
    : name === "read" ? "read"
    : name === "write" || name === "edit" || name === "create_file" ? name
    : name === "grep" || name === "glob" || name === "find" ? "search"
    : name === "codemode" ? "codemode"
    : name === "coding" ? "coding"
    : name === "browser" ? "browser"
    : name === "question" ? "asking you"
    : name.startsWith("mcp__") ? "mcp: " + tool.split("__").slice(2).join("__")
    : name.startsWith("agents_") ? "team: " + name.replace("agents_", "")
    : tool;
  const detail = (summary ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
  return detail ? label + " · " + detail : label;
}

export type ComponentRow = { type: 1; components: Record<string, unknown>[] };

export function buttonRow(buttons: { text: string; data: string; style?: number }[]): ComponentRow {
  return {
    type: 1,
    components: buttons.slice(0, 5).map((button) => ({
      type: 2,
      style: button.style ?? 2,
      label: button.text.slice(0, 80),
      custom_id: button.data.slice(0, 100),
    })),
  };
}

/** Question options as buttons, or a select menu when there are more than five. */
export function questionComponents(options: string[], nonce: string): ComponentRow[] {
  const clean = options.map((option) => option.trim()).filter(Boolean).slice(0, 25);
  if (clean.length === 0) return [];
  if (clean.length <= 5) {
    return [buttonRow(clean.map((option, index) => ({ text: option, data: "q:" + nonce + ":" + index, style: 1 })))];
  }
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "q:" + nonce,
          placeholder: "Choose an answer",
          min_values: 1,
          max_values: 1,
          options: clean.map((option, index) => ({ label: option.slice(0, 100), value: "q:" + nonce + ":" + index })),
        },
      ],
    },
  ];
}

/** One code block that is guaranteed to be under the message limit. */
export function codeBlock(value: string, language = "text"): string {
  const body = value.length > MAX_CODE ? value.slice(0, MAX_CODE) + "\n…" : value;
  return "```" + language + "\n" + body + "\n```";
}

/** Discord message links work in guilds; DMs have no stable public URL. */
export function messageLink(guildId: string | undefined, channelId: string, messageId: string): string | undefined {
  if (!guildId) return undefined;
  return "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId;
}
