import DOMPurify from "dompurify";
import { Renderer, marked } from "marked";

/**
 * One slice of a message: ordinary markdown rendered to HTML, or a fenced mermaid diagram that has to become
 * a real component so it can be zoomed. Splitting here keeps the markdown path unchanged for every other
 * code block.
 */
export type MarkdownPart = { kind: "html"; html: string } | { kind: "mermaid"; source: string };

/** A fence that opens a mermaid block. The info string has to be exactly `mermaid`. */
const MERMAID_OPEN = /^ {0,3}(`{3,})[ \t]*mermaid[ \t]*$/i;
/** A closing fence: the same character, at least as long, and nothing else on the line. */
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/;

/**
 * A link is internal when it is a same-page hash. The router owns `#/s/...`, and a plain `#section` is still
 * this document, so neither should ever leave the app.
 */
export function isInternalLink(href: string): boolean {
  return href.startsWith("#");
}

/**
 * Split markdown at fenced mermaid blocks.
 *
 * An unclosed fence stays ordinary markdown, so a diagram that is still streaming renders as a code block
 * until its closing fence arrives instead of flashing an error.
 */
/**
 * The complete mermaid fences in a message, without rendering any markdown.
 *
 * The Diagram drawer needs the sources for every message; running the markdown sanitizer over the whole
 * transcript just to find fences would be expensive and pointless. An unclosed fence is not a diagram.
 */
export function mermaidBlocks(src: string): string[] {
  const out: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  for (const line of src.split("\n")) {
    if (fence === null) {
      const open = line.match(MERMAID_OPEN);
      if (open?.[1]) fence = { marker: open[1], lines: [] };
      continue;
    }
    const close = line.match(FENCE_CLOSE);
    if (close?.[1] && close[1].length >= fence.marker.length) {
      const source = fence.lines.join("\n").trim();
      if (source.length > 0) out.push(source);
      fence = null;
      continue;
    }
    fence.lines.push(line);
  }
  return out;
}

export function markdownParts(src: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let plain: string[] = [];
  let fence: { marker: string; open: string; lines: string[] } | null = null;

  const flush = (): void => {
    const source = plain.join("\n");
    plain = [];
    if (source.trim().length > 0) parts.push({ kind: "html", html: renderMarkdown(source) });
  };

  for (const line of src.split("\n")) {
    if (fence === null) {
      const open = line.match(MERMAID_OPEN);
      if (open?.[1]) {
        flush();
        fence = { marker: open[1], open: line, lines: [] };
      } else {
        plain.push(line);
      }
      continue;
    }

    const close = line.match(FENCE_CLOSE);
    if (close?.[1] && close[1].length >= fence.marker.length) {
      const source = fence.lines.join("\n").trim();
      if (source.length > 0) parts.push({ kind: "mermaid", source });
      fence = null;
      continue;
    }
    fence.lines.push(line);
  }

  if (fence) plain.push(fence.open, ...fence.lines);
  flush();
  return parts;
}

let linkPolicyInstalled = false;

/**
 * Give every anchor its final link behaviour after sanitizing.
 *
 * Doing it here rather than in the markdown source means raw HTML from the model goes through the same rule:
 * external links open away from the thread, while a hash link is left to the in-app router and must not carry
 * a target. `javascript:` never reaches this hook — DOMPurify drops the attribute first.
 */
function installLinkPolicy(): void {
  if (linkPolicyInstalled) return;
  linkPolicyInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element) || node.tagName !== "A") return;
    const href = node.getAttribute("href");
    if (href === null || href.length === 0) return;
    if (isInternalLink(href)) {
      node.removeAttribute("target");
      node.removeAttribute("rel");
      return;
    }
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  });
}

/** Render markdown to HTML that is safe to inject into a message bubble. */
export function renderMarkdown(src: string): string {
  installLinkPolicy();
  // Tables own a scroll container, so a wide table stays readable on a phone instead of forcing the whole
  // message bubble sideways. The wrapper is ordinary HTML and passes through the same sanitizer.
  const renderer = new Renderer();
  const table = renderer.table.bind(renderer);
  renderer.table = (token) => '<div class="md-table">' + table(token) + "</div>";
  return DOMPurify.sanitize(marked.parse(src, { async: false, renderer }) as string);
}