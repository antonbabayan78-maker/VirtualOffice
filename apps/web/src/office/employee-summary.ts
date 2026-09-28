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

/** Work still on somebody's desk: anything that has not finished or been dropped. */
const OPEN = ["backlog", "assigned", "in_progress", "in_review", "changes_requested", "blocked"];

export function summariseEmployee(employee: Employee, context: SummaryContext): EmployeeSummary {
  const mine = context.tasks.filter(
    (task) => task.assigneeId === employee.id && OPEN.includes(task.status),
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
    openTasks: mine.length,
    skills: employee.skillIds,
  };
}
