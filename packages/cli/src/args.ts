/** A small flag parser. No dependency, and it accepts both --key=value and --key value. */
export type Parsed = {
  positional: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
};

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const [nameRaw, inline] = arg.slice(2).split("=", 2);
      const name = nameRaw ?? "";
      if (inline !== undefined) {
        const list = flags.get(name) ?? [];
        list.push(inline);
        flags.set(name, list);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        const list = flags.get(name) ?? [];
        list.push(next);
        flags.set(name, list);
        index += 1;
      } else {
        booleans.add(name);
      }
      continue;
    }
    // Short flags: -f, -y; a grouped -abc is not supported on purpose.
    booleans.add(arg.slice(1));
  }
  return { positional, flags, booleans };
}

export function flag(parsed: Parsed, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

export function flagAll(parsed: Parsed, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

export function has(parsed: Parsed, name: string): boolean {
  return parsed.booleans.has(name);
}

export function numberFlag(parsed: Parsed, name: string): number | undefined {
  const raw = flag(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function jsonFlag(parsed: Parsed): boolean {
  return has(parsed, "json");
}
