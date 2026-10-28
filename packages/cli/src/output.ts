/** Terminal output with one switch for colour. Everything scriptable goes through --json. */
// A short pipe (head, less) closing stdout is not an error; exit quietly instead of an EPIPE stack.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});
process.stderr.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const code = {
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m",
} as const;

export function paint(style: keyof typeof code, text: string): string {
  return useColor ? code[style] + text + code.reset : text;
}

export function print(text = ""): void {
  process.stdout.write(text + "\n");
}

export function printError(text: string): void {
  process.stderr.write(text + "\n");
}

export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd();
  print(paint("dim", line(headers)));
  for (const row of rows) print(line(row));
}

export function kv(rows: [string, string][]): void {
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) print(paint("dim", key.padEnd(width)) + "  " + value);
}

export function bytes(value: number): string {
  if (value < 1024) return value + " B";
  const units = ["KiB", "MiB", "GiB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return size.toFixed(1) + " " + units[unit];
}

export function duration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  const seconds = ms / 1000;
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + Math.round(seconds % 60) + "s";
}

/** Exit helpers: the codes documented in the plan. */
export class CliExit extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliExit";
    this.exitCode = exitCode;
  }
}

export function fail(message: string, exitCode = 1): never {
  throw new CliExit(message, exitCode);
}
