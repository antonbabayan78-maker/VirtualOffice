/**
 * Office schedule: either always open (24/7) or a set of weekly working windows
 * evaluated in the office's IANA timezone. Pure, dependency-free; DST is handled
 * by Intl, which knows the zone rules.
 */
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WorkingWindow {
  readonly days: readonly Weekday[];
  /** "HH:MM", 24h, inclusive. */
  readonly start: string;
  /** "HH:MM", 24h, exclusive. `end < start` means the window crosses midnight. */
  readonly end: string;
}

export type Schedule =
  | { readonly kind: "always" }
  | {
      readonly kind: "windows";
      readonly timezone: string;
      readonly windows: readonly WorkingWindow[];
    };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minutes since midnight, or NaN when the string is not a valid "HH:MM". */
function minutesOf(time: unknown): number {
  const m = typeof time === "string" ? TIME.exec(time) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseWindow(
  input: unknown,
  path: string,
): { window?: WorkingWindow; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!isRecord(input)) return { errors: [{ path, message: "must be an object" }] };

  const days = input["days"];
  let validDays: Weekday[] = [];
  if (!Array.isArray(days) || days.length === 0) {
    errors.push({ path: `${path}.days`, message: "must be a non-empty list of weekdays" });
  } else {
    const seen = new Set<string>();
    for (const d of days) {
      if (typeof d !== "string" || !(WEEKDAYS as readonly string[]).includes(d)) {
        errors.push({ path: `${path}.days`, message: `unknown weekday ${JSON.stringify(d)}` });
      } else if (seen.has(d)) {
        errors.push({ path: `${path}.days`, message: `duplicate weekday "${d}"` });
      } else {
        seen.add(d);
      }
    }
    validDays = [...seen] as Weekday[];
  }

  const start = input["start"];
  const end = input["end"];
  const startMin = minutesOf(start);
  const endMin = minutesOf(end);
  if (Number.isNaN(startMin)) {
    errors.push({ path: `${path}.start`, message: 'must be "HH:MM" (00:00-23:59)' });
  }
  if (Number.isNaN(endMin)) {
    errors.push({ path: `${path}.end`, message: 'must be "HH:MM" (00:00-23:59)' });
  }
  if (startMin === endMin) {
    errors.push({ path: `${path}.end`, message: "must differ from start" });
  }

  if (errors.length > 0) return { errors };
  return {
    window: { days: validDays, start: start as string, end: end as string },
    errors,
  };
}

export function parseSchedule(input: unknown): Result<Schedule> {
  if (!isRecord(input)) return err([{ path: "", message: "schedule must be an object" }]);
  const kind = input["kind"];
  if (kind === "always") return ok({ kind: "always" });
  if (kind !== "windows") {
    return err([{ path: "kind", message: 'must be "always" or "windows"' }]);
  }

  const errors: ValidationError[] = [];
  const timezone = input["timezone"];
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    errors.push({ path: "timezone", message: "must be a valid IANA timezone" });
  }

  const windowsInput = input["windows"];
  const windows: WorkingWindow[] = [];
  if (!Array.isArray(windowsInput) || windowsInput.length === 0) {
    errors.push({ path: "windows", message: "must contain at least one working window" });
  } else {
    windowsInput.forEach((w: unknown, i) => {
      const parsed = parseWindow(w, `windows[${String(i)}]`);
      errors.push(...parsed.errors);
      if (parsed.window) windows.push(parsed.window);
    });
  }

  if (errors.length > 0) return err(errors);
  return ok({ kind: "windows", timezone: timezone as string, windows });
}

interface LocalTime {
  weekday: Weekday;
  minutes: number;
}

const WEEKDAY_BY_SHORT = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
} as const satisfies Record<string, Weekday>;

const PREVIOUS_DAY: Record<Weekday, Weekday> = {
  mon: "sun",
  tue: "mon",
  wed: "tue",
  thu: "wed",
  fri: "thu",
  sat: "fri",
  sun: "sat",
};

function localTime(at: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  let weekday: Weekday = "mon";
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") weekday = WEEKDAY_BY_SHORT[p.value as keyof typeof WEEKDAY_BY_SHORT];
    else if (p.type === "hour") hour = Number(p.value) % 24;
    else if (p.type === "minute") minute = Number(p.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

function windowIsOpen(w: WorkingWindow, t: LocalTime): boolean {
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  if (start < end) {
    return w.days.includes(t.weekday) && t.minutes >= start && t.minutes < end;
  }
  // Crosses midnight: the start day owns the whole window.
  if (t.minutes >= start) return w.days.includes(t.weekday);
  if (t.minutes < end) return w.days.includes(PREVIOUS_DAY[t.weekday]);
  return false;
}

export function isOpen(schedule: Schedule, at: Date): boolean {
  if (schedule.kind === "always") return true;
  const t = localTime(at, schedule.timezone);
  return schedule.windows.some((w) => windowIsOpen(w, t));
}
