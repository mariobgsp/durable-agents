import type { WireMsg } from "../../core/src/wire.ts";
import type { InlineKeyboard } from "./client.ts";

/**
 * Telegram renders HTML, not Markdown. One converter, one escaping path: every text node is escaped
 * before any tag is added, so a transcript can never inject markup. Tables become monospace blocks
 * (Telegram has no table), mermaid stays a code block, and long answers are split on safe boundaries.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first, so formatting characters inside it are not interpreted. ` is a backtick:
  // the converter source stays free of the character so a future template/quoting layer cannot eat it.
  const codes: string[] = [];
  out = out.replace(new RegExp("\x60([^\x60]+)\x60", "g"), (_match: string, body: string) => {
    codes.push(body);
    return "\u0000C" + (codes.length - 1) + "\u0000";
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\u0000C(\d+)\u0000/g, (_match: string, index: string) => "<code>" + (codes[Number(index)] ?? "") + "</code>");
  return out;
}

/** Convert the markdown subset agents actually emit into Telegram-safe HTML. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: { lang: string; body: string[] } | undefined;
  let table: string[] | undefined;

  const flushTable = (): void => {
    if (!table) return;
    out.push("<pre>" + escapeHtml(table.join("\n")) + "</pre>");
    table = undefined;
  };

  const fenceLine = /^\s*\x60{3}(\w*)\s*$/;
  for (const line of lines) {
    const fenceMatch = fenceLine.exec(line);
    if (fenceMatch) {
      if (fence) {
        const body = escapeHtml(fence.body.join("\n"));
        out.push(
          fence.lang
            ? '<pre><code class="language-' + escapeHtml(fence.lang) + '">' + body + "</code></pre>"
            : "<pre>" + body + "</pre>",
        );
        fence = undefined;
      } else {
        flushTable();
        fence = { lang: fenceMatch[1] ?? "", body: [] };
      }
      continue;
    }
    if (fence) {
      fence.body.push(line);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      table ??= [];
      table.push(line.trim());
      continue;
    }
    flushTable();

    if (line.trim().length === 0) {
      out.push("");
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push("<b>" + inline(heading[2] ?? "") + "</b>");
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push("• " + inline(bullet[1] ?? ""));
      continue;
    }
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      out.push((numbered[1] ?? "") + ". " + inline(numbered[2] ?? ""));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push("<i>" + inline(quote[1] ?? "") + "</i>");
      continue;
    }
    out.push(inline(line));
  }
  if (fence) out.push("<pre>" + escapeHtml(fence.body.join("\n")) + "</pre>");
  flushTable();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function authorLabel(agentId: string | null | undefined, emoji?: string): string {
  if (!agentId) return "you";
  return (emoji ? emoji + " " : "") + agentId.replace(/-/g, " ");
}

export function runFooter(message: WireMsg): string {
  if (!message.run) return "";
  const seconds = Math.max(0, message.run.durationMs) / 1000;
  const usage = message.run.usage;
  const parts = ["⏱ " + (seconds < 60 ? seconds.toFixed(1) + "s" : Math.round(seconds / 60) + "m")];
  if (usage.totalTokens > 0) parts.push(usage.totalTokens.toLocaleString("en-US") + " tokens");
  if (usage.cacheRead > 0) parts.push(usage.cacheRead.toLocaleString("en-US") + " cached");
  if (usage.cost > 0) parts.push("$" + usage.cost.toFixed(4));
  return parts.join(" · ");
}

export function summaryLine(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

/** The one final rendering of an answer: text, then the footer. */
/**
 * Rich Markdown for sendRichMessage. Telegram renders GFM headings, tables, task lists, details and
 * long code blocks here, which the HTML path cannot represent. The model's answer is already Markdown;
 * do not pre-escape it for MarkdownV2.
 */
export function renderRichAnswer(message: WireMsg): string {
  const body = message.text || "(empty answer)";
  const footer = runFooter(message);
  return body + (footer ? "\n\n---\n" + footer : "");
}

export function renderAnswer(message: WireMsg): string {
  const body = markdownToHtml(message.text || "(empty answer)");
  const footer = runFooter(message);
  return body + (footer ? "\n\n<i>" + escapeHtml(footer) + "</i>" : "");
}

export function renderLive(status: string, text: string): string {
  const head = "<i>" + escapeHtml(status) + "</i>";
  const body = text ? markdownToHtml(text) : "";
  const combined = body ? head + "\n\n" + body : head;
  return combined.length > 3900 ? "…" + combined.slice(-3900) : combined;
}

export function questionKeyboard(sessionId: string, options: readonly string[]): InlineKeyboard | undefined {
  if (options.length === 0) return undefined;
  return {
    inline_keyboard: options.slice(0, 8).map((option, index) => [
      { text: option.slice(0, 60), callback_data: "q:" + sessionId + ":" + index },
    ]),
  };
}

export function buttons(rows: { text: string; data: string }[][]): InlineKeyboard {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({ text: button.text.slice(0, 60), callback_data: button.data.slice(0, 64) })),
    ),
  };
}

export function splitMessage(html: string, limit = 3900): string[] {
  if (html.length <= limit) return [html];
  const chunks: string[] = [];
  let rest = html;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
