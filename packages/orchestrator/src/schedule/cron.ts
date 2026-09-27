/**
 * Cron for recurring office work: a daily digest, a weekly report.
 *
 * A deliberately small subset of cron — stars, numbers, lists, ranges and steps
 * over five fields — because anything it does not implement is rejected rather
 * than guessed at. No `L`, `#` or `?`: a schedule that silently means something
 * other than what it says is worse than one that will not parse.
 *
 * Expressions are read in the office's timezone, so "0 9 * * *" is nine in the
 * morning where the office is, in summer and in winter alike. Local times are
 * turned into instants by correcting for the offset that actually applies then,
 * which is what makes that true across a clock change.
 */
import { err, ok, type Result } from "@vo/core";

export const CRON_FIELDS = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"] as const;
export type CronField = (typeof CRON_FIELDS)[number];

export interface CronExpr {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
  /** Whether each day field was a star, which decides how the two combine. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

const RANGES: Record<CronField, { readonly min: number; readonly max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

const NAMES: Partial<Record<CronField, Readonly<Record<string, number>>>> = {
  month: {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  },
  dayOfWeek: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};

/** Four years covers every date a five-field expression can name, or none does. */
const MAX_DAYS_AHEAD = 366 * 4;

function parseValue(raw: string, field: CronField): number | null {
  const named = NAMES[field]?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  const { min, max } = RANGES[field];
  if (value < min || value > max) return null;
  return value;
}

function parseField(raw: string, field: CronField): Result<{ values: number[]; star: boolean }> {
  const fail = (message: string): Result<{ values: number[]; star: boolean }> =>
    err([{ path: field, message }]);
  const { min, max } = RANGES[field];
  const values = new Set<number>();
  let star = false;

  for (const part of raw.split(",")) {
    const [spec, stepRaw, ...extra] = part.split("/");
    if (spec === undefined || extra.length > 0) return fail(`cannot read "${part}"`);

    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) {
        return fail(`step in "${part}" must be a positive number`);
      }
      step = Number(stepRaw);
    }

    let from: number;
    let to: number;
    if (spec === "*") {
      star = stepRaw === undefined;
      from = min;
      to = max;
    } else if (spec.includes("-")) {
      const [startRaw, endRaw, ...rest] = spec.split("-");
      if (startRaw === undefined || endRaw === undefined || rest.length > 0) {
        return fail(`cannot read the range "${spec}"`);
      }
      const start = parseValue(startRaw, field);
      const end = parseValue(endRaw, field);
      if (start === null || end === null)
        return fail(`"${spec}" is out of range ${String(min)}-${String(max)}`);
      if (start > end) return fail(`the range "${spec}" runs backwards`);
      from = start;
      to = end;
    } else {
      const single = parseValue(spec, field);
      if (single === null) return fail(`"${spec}" is out of range ${String(min)}-${String(max)}`);
      from = single;
      to = stepRaw === undefined ? single : max;
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) return fail("matches nothing");
  return ok({ values: [...values].sort((a, b) => a - b), star });
}

export function parseCron(expression: string): Result<CronExpr> {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (fields.length !== CRON_FIELDS.length) {
    return err([
      {
        path: "",
        message: `a cron expression has five fields (${CRON_FIELDS.join(" ")}); got ${String(fields.length)}`,
      },
    ]);
  }

  const parsed: Partial<Record<CronField, { values: number[]; star: boolean }>> = {};
  for (const [index, field] of CRON_FIELDS.entries()) {
    const raw = fields[index] ?? "";
    const result = parseField(raw, field);
    if (!result.ok) return err(result.error);
    parsed[field] = result.value;
  }

  const minute = parsed.minute;
  const hour = parsed.hour;
  const dayOfMonth = parsed.dayOfMonth;
  const month = parsed.month;
  const dayOfWeek = parsed.dayOfWeek;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return err([{ path: "", message: "could not read every field" }]);
  }

  return ok({
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    // Sunday is both 0 and 7 in cron; keep one of them.
    dayOfWeek: [...new Set(dayOfWeek.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b),
    dayOfMonthRestricted: !dayOfMonth.star,
    dayOfWeekRestricted: !dayOfWeek.star,
  });
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsCache.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  partsCache.set(timeZone, made);
  return made;
}

interface LocalClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localFields(at: Date, timeZone: string): LocalClock {
  const raw: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== "literal") raw[part.type] = Number(part.value);
  }
  return {
    year: raw["year"] ?? 1970,
    month: raw["month"] ?? 1,
    day: raw["day"] ?? 1,
    // Some locales render midnight as hour 24.
    hour: (raw["hour"] ?? 0) % 24,
    minute: raw["minute"] ?? 0,
    second: raw["second"] ?? 0,
  };
}

/** How far local wall-clock time is ahead of UTC at this instant, in ms. */
function offsetMs(at: Date, timeZone: string): number {
  const f = localFields(at, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - at.getTime();
}

/**
 * The instant at which the clock in `timeZone` reads this local time. Corrected
 * twice because the offset itself depends on the instant; a local time that a
 * clock change skipped lands on the next one that exists rather than vanishing.
 */
function instantForLocal(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  let guess = new Date(naive - offsetMs(new Date(naive), timeZone));
  guess = new Date(naive - offsetMs(guess, timeZone));
  return guess;
}

function matchesDay(expr: CronExpr, date: LocalDate): boolean {
  if (!expr.month.includes(date.month)) return false;
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const domMatch = expr.dayOfMonth.includes(date.day);
  const dowMatch = expr.dayOfWeek.includes(weekday);
  // When both are restricted, cron fires if either matches.
  if (expr.dayOfMonthRestricted && expr.dayOfWeekRestricted) return domMatch || dowMatch;
  if (expr.dayOfMonthRestricted) return domMatch;
  if (expr.dayOfWeekRestricted) return dowMatch;
  return true;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/**
 * The first instant strictly after `after` that the expression names. Throws
 * when nothing matches within four years, which means the expression names a
 * date that does not exist — 30 February and the like.
 */
export function nextCronRun(expr: CronExpr, after: Date, timeZone = "UTC"): Date {
  const start = localFields(after, timeZone);
  const date: LocalDate = { year: start.year, month: start.month, day: start.day };

  for (let dayOffset = 0; dayOffset <= MAX_DAYS_AHEAD; dayOffset++) {
    const candidate = dayOffset === 0 ? date : addDays(date, dayOffset);
    if (!matchesDay(expr, candidate)) continue;
    for (const hour of expr.hour) {
      for (const minute of expr.minute) {
        const instant = instantForLocal(candidate, hour, minute, timeZone);
        if (instant.getTime() > after.getTime()) return instant;
      }
    }
  }

  throw new Error(
    `no occurrence of this cron expression within ${String(MAX_DAYS_AHEAD)} days of ${after.toISOString()}`,
  );
}
