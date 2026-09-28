/**
 * What to say about somebody when you point at them.
 *
 * Gathered here rather than in the tooltip so the answer can be tested without
 * a DOM, and so the same summary can be used anywhere else it is wanted — a
 * drawer header, a directory, an org chart.
 *
 * It answers the questions someone actually has when they hover a figure on a
 * busy canvas: who is this, what are they for, what are they doing right now,
 * what is it costing, and who do they answer to.
 */
import { openTaskCounts, TERMINAL_TASK_STATUSES } from "@vo/core";
import type { Department, Employee, Task } from "@vo/core";
import { describeActivity } from "./activity.js";
import type { ActivityState } from "../canvas/EmployeeAvatar.js";

export interface EmployeeSummary {
  readonly name: string;
  readonly role: string;
  readonly department: string;
  readonly model: string;
  readonly reportsTo: string | null;
  readonly activity: string;
  /** The task they are on, when there is one worth naming. */
  readonly task: string | null;
  readonly openTasks: number;
  readonly skills: readonly string[];
}

export interface SummaryContext {
  readonly department: Department | undefined;
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
  readonly activity: ActivityState;
}

export function summariseEmployee(employee: Employee, context: SummaryContext): EmployeeSummary {
  // Counted the way the office itself counts, so what a tooltip says is on
  // somebody's desk is what a review policy sees when it looks for whoever has
  // the least on. Two definitions of "open" would disagree in front of you.
  const open = openTaskCounts(context.tasks)[employee.id] ?? 0;
  const mine = context.tasks.filter(
    (task) => task.assigneeId === employee.id && !TERMINAL_TASK_STATUSES.includes(task.status),
  );
  const supervisor =
    employee.supervisorId === null
      ? null
      : (context.employees.find((other) => other.id === employee.supervisorId)?.name ?? null);

  return {
    name: employee.name,
    role: employee.role,
    department: context.department?.name ?? "—",
    model: employee.llm.model,
    reportsTo: supervisor,
    // Read as a value after a label ("Doing: …"), so idle is a noun phrase
    // rather than the sentence fragment the chip under a figure wants.
    activity:
      context.activity === "idle" ? "nothing right now" : describeActivity(context.activity),
    task: mine[0]?.title ?? null,
    openTasks: open,
    skills: employee.skillIds,
  };
}
