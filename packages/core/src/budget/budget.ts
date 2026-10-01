/**
 * What a level of the office may spend, and where it stands against that.
 *
 * An office that runs unattended needs a floor under it: a misconfigured
 * employee on an expensive model can spend all night, and the only thing that
 * would have stopped it was somebody watching. A budget is that floor.
 *
 * **Over budget is not paused.** The scheduler passes the work over with a
 * reason of its own, and the period rolling puts it back — nobody has to
 * restart anybody. The run-state switch keeps meaning "a person stopped this",
 * which is what makes a stopped office readable at a glance: two different
 * stops that looked identical on the canvas would tell you nothing.
 *
 * The period turns where the office is, not where the server is. A daily budget
 * that reset at UTC midnight would cut a Nicosia working day in half, and the
 * office in question would see its budget vanish mid-afternoon.
 */
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

export const BUDGET_PERIODS = ["day", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return typeof value === "string" && (BUDGET_PERIODS as readonly string[]).includes(value);
}

export interface Budget {
  readonly limitUsd: number;
  /** Where to warn, at or below the limit. Null warns only when work stops. */
  readonly warnAtUsd: number | null;
  readonly period: BudgetPeriod;
}

export type BudgetStanding = "ok" | "warn" | "over";

/**
 * Where one level stands. Not the office as a whole: each level is judged
 * against its own budget, and the scheduler asks all three.
 *
 * At the limit is over, not under it. A limit of $10 that permitted $10.00 and
 * stopped at $10.01 would be a limit nobody could state out loud.
 */
export function budgetStanding(budget: Budget | null, spentUsd: number): BudgetStanding {
  if (budget === null) return "ok";
  if (spentUsd >= budget.limitUsd) return "over";
  // A warning above the limit can only come from a file written before that was
  // refused; honouring it would make the warning unreachable rather than early.
  if (budget.warnAtUsd !== null && budget.warnAtUsd <= budget.limitUsd) {
    return spentUsd >= budget.warnAtUsd ? "warn" : "ok";
  }
  return "ok";
}

/**
 * The instant the current period began, where the office is.
 *
 * An unknown zone falls back to UTC rather than throwing: an office file can
 * carry anything, and a budget that threw here would take the whole tick with
 * it — a mistyped timezone must not stop work.
 */
export function periodStart(period: BudgetPeriod, at: Date, timezone: string): Date {
  const parts = localParts(at, timezone);
  // Built from the office's own wall-clock date, then read back as the instant
  // that local midnight corresponds to.
  const day = period === "month" ? 1 : parts.day;
  return instantOf(parts.year, parts.month, day, timezone);
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localParts(at: Date, timezone: string): LocalParts {
  const formatter = safeFormatter(timezone);
  const parts = formatter.formatToParts(at);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

function safeFormatter(timezone: string): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
}

/**
 * The instant at which it was midnight on this local date in this zone.
 *
 * Found by taking the UTC guess and correcting by the zone's offset at that
 * moment, which handles the offset having changed since — the correction is
 * applied twice because a shift can move the instant across the change itself.
 */
function instantOf(year: number, month: number, day: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = guess + (instant - asUtcMillis(new Date(instant), timezone));
  }
  return new Date(instant);
}

/** The wall-clock time in a zone, read back as though it were UTC. */
function asUtcMillis(at: Date, timezone: string): number {
  const parts = safeFormatter(timezone).formatToParts(at);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
}

/** What was spent at or after an instant. The boundary belongs to the period it opens. */
export function spentSince(
  rows: readonly { readonly at: Date; readonly usd: number }[],
  since: Date,
): number {
  return rows.reduce(
    (total, row) => (row.at.getTime() >= since.getTime() ? total + row.usd : total),
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A budget as a file or a route states it. Absent is an office with no budget. */
export function parseBudget(raw: unknown): Result<Budget | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (!isRecord(raw)) return err([{ path: "budget", message: "must be an object" }]);

  const errors: ValidationError[] = [];
  const limitUsd = raw["limitUsd"];
  if (typeof limitUsd !== "number" || !Number.isFinite(limitUsd) || limitUsd <= 0) {
    // Zero would stop every piece of work for ever, which is a switch rather
    // than a budget — and there is already a switch.
    errors.push({ path: "budget.limitUsd", message: "must be an amount greater than zero" });
  }

  const period = raw["period"];
  if (!isBudgetPeriod(period)) {
    errors.push({ path: "budget.period", message: `must be one of ${BUDGET_PERIODS.join(", ")}` });
  }

  const warnRaw = raw["warnAtUsd"];
  let warnAtUsd: number | null = null;
  if (warnRaw !== undefined && warnRaw !== null) {
    if (typeof warnRaw !== "number" || !Number.isFinite(warnRaw) || warnRaw <= 0) {
      errors.push({ path: "budget.warnAtUsd", message: "must be an amount greater than zero" });
    } else if (typeof limitUsd === "number" && warnRaw > limitUsd) {
      errors.push({
        path: "budget.warnAtUsd",
        message: "must not be above the limit, or it would never fire",
      });
    } else warnAtUsd = warnRaw;
  }

  if (errors.length > 0 || typeof limitUsd !== "number" || !isBudgetPeriod(period)) {
    return err(errors);
  }
  return ok({ limitUsd, warnAtUsd, period });
}
