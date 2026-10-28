/**
 * A tiny, dependency-free PDF writer for text and Markdown-shaped content.
 *
 * The app runs on a laptop and must not pull a PDF toolchain into every boot. This writer covers what an agent
 * actually delivers in a chat: headings, paragraphs, bullets and code. It uses the standard Helvetica/Courier
 * fonts, A4 pages and WinAnsi text. Non-Latin characters that the base fonts cannot encode become "?" rather
 * than producing a broken PDF; agents that need a custom font can generate the file themselves and publish it.
 */

type Block =
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "p" | "bullet" | "code"; text: string }
  | { kind: "space" };

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function replaceInline(text: string): string {
  return text
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function parseMarkdown(body: string): Block[] {
  const blocks: Block[] = [];
  let code = false;
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "    ").trimEnd();
    if (/^ {0,3}```/.test(line)) {
      code = !code;
      if (!code) blocks.push({ kind: "space" });
      continue;
    }
    if (code) {
      blocks.push({ kind: "code", text: line });
      continue;
    }
    if (line.trim().length === 0) {
      blocks.push({ kind: "space" });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      blocks.push({ kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3", text: replaceInline(h[2] ?? "") });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", text: replaceInline(bullet[1] ?? "") });
      continue;
    }
    blocks.push({ kind: "p", text: replaceInline(line) });
  }
  return blocks;
}

function winAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (char === "\n") {
      out += " ";
      continue;
    }
    if (code === 0x2018 || code === 0x2019) out += "'";
    else if (code === 0x201c || code === 0x201d) out += '"';
    else if (code === 0x2013 || code === 0x2014) out += "-";
    else if (code === 0x2022) out += "-";
    else if (code >= 32 && code <= 255) out += String.fromCharCode(code);
    else out += "?";
  }
  return out;
}

function escapePdf(text: string): string {
  return winAnsi(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text: string, size: number, width = CONTENT_WIDTH): string[] {
  const max = Math.max(8, Math.floor(width / (size * 0.5)));
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : line + " " + word;
    if (candidate.length <= max) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    if (word.length <= max) {
      line = word;
      continue;
    }
    for (let index = 0; index < word.length; index += max) {
      const part = word.slice(index, index + max);
      if (index + max < word.length) lines.push(part);
      else line = part;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function textCommand(font: string, size: number, x: number, y: number, text: string): string {
  return "BT /" + font + " " + size + " Tf " + x.toFixed(2) + " " + y.toFixed(2) + " Td (" + escapePdf(text) + ") Tj ET";
}

/** Render a Markdown-shaped body as a valid PDF. */
export function renderPdf(input: { title?: string; body: string }): Buffer {
  const blocks = parseMarkdown(input.body);
  if (input.title?.trim()) blocks.unshift({ kind: "h1", text: input.title.trim() });

  const pages: string[] = [];
  let content: string[] = [];
  let y = PAGE_HEIGHT - MARGIN;

  const newPage = (): void => {
    if (content.length > 0) pages.push(content.join("\n"));
    content = [];
    y = PAGE_HEIGHT - MARGIN;
  };
  const ensure = (height: number): void => {
    if (y - height < MARGIN) newPage();
  };
  const line = (font: string, size: number, text: string, indent = 0): void => {
    const height = size * 1.45;
    ensure(height);
    content.push(textCommand(font, size, MARGIN + indent, y, text));
    y -= height;
  };

  for (const block of blocks) {
    if (block.kind === "space") {
      y -= 7;
      continue;
    }
    if (block.kind === "h1" || block.kind === "h2" || block.kind === "h3") {
      const size = block.kind === "h1" ? 20 : block.kind === "h2" ? 15 : 12.5;
      ensure(size * 2);
      y -= 4;
      for (const lineText of wrap(block.text, size)) line("F2", size, lineText);
      y -= 6;
      continue;
    }
    if (block.kind === "code") {
      ensure(12);
      content.push(textCommand("F3", 8.5, MARGIN + 8, y, block.text));
      y -= 12;
      continue;
    }
    if (block.kind === "bullet") {
      const wrapped = wrap(block.text, 10.5, CONTENT_WIDTH - 14);
      wrapped.forEach((part, index) => {
        const text = (index === 0 ? "- " : "  ") + part;
        line("F1", 10.5, text, 10);
      });
      continue;
    }
    for (const lineText of wrap(block.text, 10.5)) line("F1", 10.5, lineText);
    y -= 3;
  }
  if (content.length === 0) content.push(textCommand("F1", 11, MARGIN, y, "(No content)"));
  pages.push(content.join("\n"));

  const pageCount = pages.length;
  const objects: string[] = new Array(6 + pageCount * 2).fill("");
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids: string[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageObject = 6 + index * 2;
    const contentObject = pageObject + 1;
    kids.push(pageObject + " 0 R");
    const stream = pages[index]!;
    objects[pageObject - 1] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " +
      PAGE_WIDTH.toFixed(2) +
      " " +
      PAGE_HEIGHT.toFixed(2) +
      "] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents " +
      contentObject +
      " 0 R >>";
    objects[contentObject - 1] =
      "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream";
  }
  objects[1] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pageCount + " >>";
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += index + 1 + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) out += String(offset).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}
