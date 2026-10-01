/**
 * What the office spent, read off the rows it already holds.
 *
 * Kept apart from the screen because this is the part with arithmetic, and
 * money arithmetic is worth testing without a DOM. The screen decides how to
 * draw a bar; this decides what the bar is.
 *
 * **An unpriced call is counted and never added as zero.** The registry returns
 * no price for a model it does not know, so adding it as free would make a
 * total quietly smaller than the truth — and a dashboard whose numbers are too
 * low is worse than one that admits a gap. Every total here says how many calls
 * it could not price.
 *
 * A department's spend is joined through its people, because a usage row
 * deliberately promotes only the office, the task and the person.
 */
import type { Department, Employee, Task, UsageRecord } from "@vo/core";

export interface UsageFilter {
  readonly departmentId?: string;
  /** Only what happened at or after this moment. */
  readonly since?: Date;
}

export interface SpendRow {
  readonly name: string;
  /** Something to say beside the name: the model a person runs. */
  readonly detail: string | null;
  readonly usd: number;
  readonly calls: number;
  /**
   * Calls in this row the registry could not price. Carried per row, not only
   * on the total: a row showing "$0.00" for a model nobody can price reads as
   * "this one is free", which is the opposite of what is known about it.
   */
  readonly unpricedCalls: number;
}

export interface UsageLine {
  readonly at: Date;
  readonly who: string;
  readonly model: string;
  readonly taskTitle: string;
  readonly usd: number | null;
  readonly ms: number;
}

export interface UsageReport {
  readonly totalUsd: number;
  readonly calls: number;
  readonly unpricedCalls: number;
  readonly completedTasks: number;
  /** Null when nothing has finished: dividing by none says nothing. */
  readonly usdPerCompletedTask: number | null;
  readonly byEmployee: readonly SpendRow[];
  readonly byDepartment: readonly SpendRow[];
  readonly byModel: readonly SpendRow[];
  /** Every call the filter left, newest first. */
  readonly lines: readonly UsageLine[];
}

export interface UsageReportInput {
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
  readonly usage: readonly UsageRecord[];
  readonly filter: UsageFilter;
}

const GONE = "Someone who has left";

function costOf(record: UsageRecord): number | null {
  const cost = record.event["cost"];
  if (typeof cost !== "object" || cost === null) return null;
  const total = (cost as { totalUsd?: unknown }).totalUsd;
  return typeof total === "number" ? total : null;
}

const textOf = (record: UsageRecord, field: string, fallback: string): string => {
  const value = record.event[field];
  return typeof value === "string" ? value : fallback;
};

const msOf = (record: UsageRecord): number => {
  const value = record.event["durationMs"];
  return typeof value === "number" ? value : 0;
};

/** Biggest first, so a dashboard answers "where did it go" in its first row. */
function ranked(totals: Map<string, SpendRow>): readonly SpendRow[] {
  return [...totals.values()].sort((a, b) => b.usd - a.usd);
}

function add(
  totals: Map<string, SpendRow>,
  key: string,
  name: string,
  detail: string | null,
  usd: number | null,
): void {
  const row = totals.get(key) ?? { name, detail, usd: 0, calls: 0, unpricedCalls: 0 };
  totals.set(key, {
    ...row,
    usd: row.usd + (usd ?? 0),
    calls: row.calls + 1,
    unpricedCalls: row.unpricedCalls + (usd === null ? 1 : 0),
  });
}

export function usageReport(input: UsageReportInput): UsageReport {
  const people = new Map(input.employees.map((one) => [one.id as string, one]));
  const rooms = new Map(input.departments.map((one) => [one.id as string, one]));
  const tasks = new Map(input.tasks.map((one) => [one.id as string, one]));

  const rows = input.usage.filter((record) => {
    if (input.filter.since !== undefined && record.at.getTime() < input.filter.since.getTime()) {
      return false;
    }
    if (input.filter.departmentId === undefined) return true;
    // Through the person, since the row does not carry a department.
    const employee = record.employeeId === null ? undefined : people.get(record.employeeId);
    return employee?.departmentId === input.filter.departmentId;
  });

  let totalUsd = 0;
  let unpricedCalls = 0;
  const byEmployee = new Map<string, SpendRow>();
  const byDepartment = new Map<string, SpendRow>();
  const byModel = new Map<string, SpendRow>();
  const lines: UsageLine[] = [];
  const finishedTasks = new Set<string>();
  let finishedUsd = 0;

  for (const record of rows) {
    const usd = costOf(record);
    const employee = record.employeeId === null ? undefined : people.get(record.employeeId);
    const model = textOf(record, "model", "—");

    if (usd === null) unpricedCalls += 1;
    else totalUsd += usd;

    lines.push({
      at: record.at,
      who: record.employeeId === null ? "Nobody in particular" : (employee?.name ?? GONE),
      model,
      taskTitle: record.taskId === null ? "" : (tasks.get(record.taskId)?.title ?? ""),
      usd,
      ms: msOf(record),
    });

    // Only spend on work that is actually finished counts towards the average.
    // Dividing everything spent by what has finished would make the figure
    // drift upwards all day as work sat in flight and drop each time something
    // completed — a number that moves for reasons nobody did.
    if (record.taskId !== null && tasks.get(record.taskId)?.status === "done") {
      finishedTasks.add(record.taskId);
      finishedUsd += usd ?? 0;
    }
    if (record.employeeId !== null) {
      add(byEmployee, record.employeeId, employee?.name ?? GONE, employee?.llm.model ?? null, usd);
      const departmentId = employee?.departmentId;
      if (departmentId !== undefined) {
        add(byDepartment, departmentId, rooms.get(departmentId)?.name ?? GONE, null, usd);
      }
    }
    add(byModel, model, model, null, usd);
  }

  return {
    totalUsd,
    calls: rows.length,
    unpricedCalls,
    completedTasks: finishedTasks.size,
    usdPerCompletedTask: finishedTasks.size === 0 ? null : finishedUsd / finishedTasks.size,
    byEmployee: ranked(byEmployee),
    byDepartment: ranked(byDepartment),
    byModel: ranked(byModel),
    lines: [...lines].sort((a, b) => b.at.getTime() - a.at.getTime()),
  };
}

/** A field as CSV: quoted only when it has to be, and quotes doubled inside. */
function field(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The report as a spreadsheet, one row per call.
 *
 * An unpriced call leaves its cost empty rather than writing a zero: a
 * spreadsheet that summed it would be wrong by exactly the amount nobody knew.
 */
export function asCsv(report: UsageReport): string {
  const header = ["when", "who", "model", "task", "duration_ms", "cost_usd"].join(",");
  const lines = report.lines.map((line) =>
    [
      line.at.toISOString(),
      field(line.who),
      field(line.model),
      field(line.taskTitle),
      String(line.ms),
      line.usd === null ? "" : line.usd.toFixed(6),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}
