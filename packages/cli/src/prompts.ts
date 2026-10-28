import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Interactive prompts. Nothing here is used when the caller passes flags; a non-TTY with a missing
 * required value fails with exit 2 instead of hanging.
 */

export function interactive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function ask(question: string, fallback = ""): Promise<string> {
  if (!interactive()) {
    if (fallback) return fallback;
    throw new Error("missing input for " + JSON.stringify(question) + " and stdin is not a terminal");
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(fallback ? question + " [" + fallback + "]: " : question + ": ")).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  if (!interactive()) return fallback;
  const hint = fallback ? "[Y/n]" : "[y/N]";
  const answer = (await ask(question + " " + hint, "")).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

/** A hidden value: nothing is echoed. Falls back to a plain line on a pipe. */
export async function secret(question: string): Promise<string> {
  if (!interactive()) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question("")).trim();
    } finally {
      rl.close();
    }
  }
  stdout.write(question + ": ");
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    await new Promise<void>((done, fail) => {
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        for (const char of text) {
          if (char === "\u0003") {
            stdin.off("data", onData);
            fail(new Error("cancelled"));
            return;
          }
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            stdout.write("\n");
            done();
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          if (char >= " ") value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  return value.trim();
}

export async function choose(
  question: string,
  options: readonly { label: string; value: string }[],
  fallbackIndex = 0,
): Promise<string> {
  if (options.length === 0) throw new Error("nothing to choose from");
  if (!interactive()) {
    const fallback = options[fallbackIndex];
    if (!fallback) throw new Error("no default choice");
    return fallback.value;
  }
  const lines = options.map((option, index) => "  " + (index + 1) + ") " + option.label);
  const answer = await ask([question, ...lines].join("\n"), String(fallbackIndex + 1));
  const index = Number(answer) - 1;
  const chosen = Number.isSafeInteger(index) && options[index] ? options[index] : options[fallbackIndex];
  return chosen?.value ?? options[0]?.value ?? "";
}
