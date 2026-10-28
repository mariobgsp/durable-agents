/**
 * A small 5-field cron parser.
 *
 * Deliberately local-time and dependency-free: the app is a local single-user server, and a schedule's
 * "09:00" should mean the clock on the machine that runs it. The next-run search skips whole days first and
 * only scans minutes on a matching day, so a rare expression stays cheap. The window is five years; an
 * expression with no run inside it is rejected rather than silently scheduling nothing.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthStar: boolean;
  dayOfWeekStar: boolean;
};

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DAY_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

function valueOf(token: string, names: Record<string, number> | undefined): number {
  const upper = token.toUpperCase();
  if (names && upper in names) return names[upper]!;
  if (!/^\d+$/.test(token)) throw new CronError("not a number or name: " + token);
  return Number(token);
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  names?: Record<string, number>,
): { values: Set<number>; star: boolean } {
  const text = raw.trim();
  if (text.length === 0) throw new CronError("the " + label + " field is empty");
  const star = text === "*";
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) throw new CronError("the " + label + " field has an empty list item");
    const [rangePart, stepPart, extra] = piece.split("/");
    if (extra !== undefined) throw new CronError("the " + label + " field has more than one /");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step <= 0) throw new CronError("invalid step in " + label + ": " + piece);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart!.includes("-")) {
      const [left, right, more] = rangePart!.split("-");
      if (more !== undefined || left === undefined || right === undefined) {
        throw new CronError("invalid range in " + label + ": " + piece);
      }
      start = valueOf(left, names);
      end = valueOf(right, names);
    } else {
      start = valueOf(rangePart!, names);
      end = stepPart === undefined ? start : max;
    }
    if (start < min || end > max || start > end) {
      throw new CronError("the " + label + " field must be between " + min + " and " + max + ": " + piece);
    }
    for (let value = start; value <= end; value += step) {
      // Sunday is both 0 and 7; normalise before storing.
      values.add(label === "day of week" && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new CronError("the " + label + " field matches nothing");
  return { values, star };
}

export function parseCron(expression: string): CronFields {
  const raw = expression.trim();
  if (raw.length === 0) throw new CronError("cron expression is empty");
  const expanded = ALIASES[raw.toLowerCase()] ?? raw;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError("cron needs 5 fields: minute hour day-of-month month day-of-week");
  }
  const minute = parseField(parts[0]!, 0, 59, "minute");
  const hour = parseField(parts[1]!, 0, 23, "hour");
  const dayOfMonth = parseField(parts[2]!, 1, 31, "day of month");
  const month = parseField(parts[3]!, 1, 12, "month", MONTH_NAMES);
  const dayOfWeek = parseField(parts[4]!, 0, 7, "day of week", DAY_NAMES);
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthStar: dayOfMonth.star,
    dayOfWeekStar: dayOfWeek.star,
  };
}

function matchesDay(fields: CronFields, date: Date): boolean {
  if (!fields.month.has(date.getMonth() + 1)) return false;
  const dom = fields.dayOfMonth.has(date.getDate());
  const dow = fields.dayOfWeek.has(date.getDay());
  // Standard Vixie semantics: when both day fields are restricted, either may match. When one is *, the
  // other must match. Two stars match every day.
  if (fields.dayOfMonthStar && fields.dayOfWeekStar) return true;
  if (fields.dayOfMonthStar) return dow;
  if (fields.dayOfWeekStar) return dom;
  return dom || dow;
}

function atLocal(year: number, monthIndex: number, day: number, hour: number, minute: number): Date {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

/**
 * The next matching instants, oldest first. Throws CronError with a readable reason.
 *
 * The search is bounded to five years. A leap-day-only expression fits; an impossible combination such as
 * 31 February does not, and saying so is better than returning an empty schedule forever.
 */
export function nextRuns(expression: string, from: number = Date.now(), count = 1): number[] {
  const fields = parseCron(expression);
  const wanted = Math.max(1, Math.min(10, Math.floor(count)));
  const out: number[] = [];
  // Start at the next whole minute; a run in the current minute has already had its chance.
  let cursor = new Date(Math.floor(from / 60_000) * 60_000 + 60_000);
  const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 12, 0, 0, 0);
  const limit = new Date(cursor.getFullYear() + 5, cursor.getMonth(), cursor.getDate(), 12, 0, 0, 0);
  while (day.getTime() <= limit.getTime() && out.length < wanted) {
    if (matchesDay(fields, day)) {
      const startMinute =
        day.getFullYear() === cursor.getFullYear() &&
        day.getMonth() === cursor.getMonth() &&
        day.getDate() === cursor.getDate()
          ? cursor.getHours() * 60 + cursor.getMinutes()
          : 0;
      for (let minuteOfDay = startMinute; minuteOfDay < 1440; minuteOfDay += 1) {
        const hour = Math.floor(minuteOfDay / 60);
        const minute = minuteOfDay % 60;
        if (!fields.hour.has(hour) || !fields.minute.has(minute)) continue;
        const candidate = atLocal(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
        // A DST jump can make the requested local time land on another wall clock; that minute did not
        // exist, so it is not a run.
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
        if (candidate.getTime() <= from) continue;
        out.push(candidate.getTime());
        if (out.length >= wanted) break;
      }
    }
    day.setDate(day.getDate() + 1);
    // The first day's start is the next minute; later days start at midnight.
    if (day.getTime() > limit.getTime()) break;
    if (out.length >= wanted) break;
  }
  if (out.length === 0) {
    throw new CronError(
      "no matching run within five years; check the day-of-month and month combination",
    );
  }
  return out;
}

/** Validate once and return the first next run, or null if the expression is impossible. */
export function firstRun(expression: string, from: number = Date.now()): number | null {
  try {
    return nextRuns(expression, from, 1)[0] ?? null;
  } catch {
    return null;
  }
}