import { spawn } from "node:child_process";

/**
 * Bytes → text, and nothing else.
 *
 * This module knows how to read a document and nothing about messages, budgets or storage: the caller
 * decides how much of the text it keeps and what to say when a file cannot be read. Both formats are
 * converted in memory — a PDF goes to `pdftotext` on **stdin**, never through a path — so there is no
 * temporary file to clean up and no path traversal to defend against.
 */

/** Why the model was given no text. Stable identifiers, so tests and the UI never match on prose. */
export type DocumentOmission = "not-text" | "pdf-unreadable" | "pdf-converter-missing" | "empty";

export type Extraction =
  | { ok: true; text: string }
  | { ok: false; code: DocumentOmission; reason: string };

/** The converter poppler installs; `PI_PDFTOTEXT` overrides it so the missing-tool path is testable. */
function converterPath(): string {
  return process.env.PI_PDFTOTEXT ?? "pdftotext";
}

/** How long one PDF may take before it is killed. A local conversion is milliseconds; this is a guard. */
const PDF_TIMEOUT_MS = 20_000;
/** Cap on the text collected from stdout. The caller's character budget is far below this. */
const PDF_MAX_BYTES = 4 * 1024 * 1024;
/** Bytes inspected for a NUL, the cheapest reliable signal that a file is not text. */
const SNIFF_BYTES = 8192;

/** True when the bytes are a PDF by magic number, whatever the declared type says. */
export function looksLikePdf(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "application/pdf") return true;
  const magic = "%PDF-";
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * The text of one document, or the reason there is none.
 *
 * Text is detected by decoding rather than by extension or by the declared MIME type, so there is no
 * format table to keep in sync with reality: anything that is valid UTF-8 without a NUL is text.
 */
export async function extractDocument(
  bytes: Uint8Array,
  name: string,
  mimeType: string,
): Promise<Extraction> {
  if (looksLikePdf(bytes, mimeType)) return extractPdf(bytes, name);

  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return {
      ok: false,
      code: "not-text",
      reason: name + " is not text and is not a PDF, so it was not sent to the model",
    };
  }
  if (text.trim().length === 0) {
    return { ok: false, code: "empty", reason: name + " has no readable text" };
  }
  return { ok: true, text };
}

/** UTF-8 text, or undefined when the bytes are binary. A NUL in the head is the fast reject. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  const head = bytes.subarray(0, Math.min(SNIFF_BYTES, bytes.length));
  if (head.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** `pdftotext - -`: the PDF on stdin, the text on stdout. Nothing is written to disk. */
function extractPdf(bytes: Uint8Array, name: string): Promise<Extraction> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(converterPath(), ["-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(missingConverter(name));
      return;
    }

    const chunks: Buffer[] = [];
    let collected = 0;
    let settled = false;
    let overBudget = false;

    const finish = (result: Extraction): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, code: "pdf-unreadable", reason: name + " took too long to read" });
    }, PDF_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? missingConverter(name) : unreadable(name));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      collected += chunk.length;
      if (collected > PDF_MAX_BYTES) {
        // Keep what fits and stop reading: the caller's character budget truncates far below this.
        overBudget = true;
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (collected - PDF_MAX_BYTES))));
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on("error", () => undefined);
    // A killed child must not throw into the request that started it.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!overBudget && code !== 0) {
        finish(unreadable(name));
        return;
      }
      if (text.trim().length === 0) {
        finish({ ok: false, code: "empty", reason: name + " has no readable text" });
        return;
      }
      finish({ ok: true, text });
    });

    child.stdin.end(bytes);
  });
}

function missingConverter(name: string): Extraction {
  return {
    ok: false,
    code: "pdf-converter-missing",
    reason: name + " is a PDF and reading PDFs needs poppler (pdftotext), which is not installed",
  };
}

function unreadable(name: string): Extraction {
  return { ok: false, code: "pdf-unreadable", reason: name + " could not be read as a PDF" };
}
