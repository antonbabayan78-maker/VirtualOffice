/**
 * An office, as the scheduler needs to see it.
 *
 * The scheduler reads a narrow view — hours, statuses, who owes what — rather
 * than whole entities, so it can be tested without building an office. This is
 * the one place that view is built, because a worker and a headless run that
 * each built their own would eventually disagree about something small, like
 * whether an employee with no hours follows the office or works around the
 * clock.
 */
import { contestStanding, type Department, type Employee, type Office, type Task } from "@vo/core";
import type { JudgeableContest, RecurringJob, SchedulerSnapshot } from "./scheduler.js";

/**
 * What each level has spent in the period its budget covers.
 *
 * A summary rather than the rows themselves: a worker needs a handful of
 * numbers to decide what to queue, and shipping every priced call to every
 * worker on every tick is the thing the rollups task exists to prevent.
 */
export interface OfficeSpend {
  readonly officeUsd: number;
  readonly byDepartment: Readonly<Record<string, number>>;
  readonly byEmployee: Readonly<Record<string, number>>;
}

export interface OfficeSnapshotInput {
  readonly office: Office;
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
  readonly recurring?: readonly RecurringJob[];
  /** Absent means nothing is known to have been spent, which schedules as before. */
  readonly spend?: OfficeSpend;
}

/**
 * The contests that are ready for the judge their bench names.
 *
 * Derived here rather than stored, like everything else about a contest: the
 * entries say whether the answers are in and whether anybody has decided, and a
 * flag saying the same thing would be a second thing to keep in step.
 *
 * A bench with no judge produces nothing. Those contests are for a person to
 * decide on the canvas, and queueing a job with nobody to do it would be a job
 * that fails on every attempt.
 */
function judgeableContests(
  departments: readonly Department[],
  tasks: readonly Task[],
): readonly JudgeableContest[] {
  const waiting: JudgeableContest[] = [];
  for (const department of departments) {
    for (const bench of department.benches) {
      if (bench.strategy !== "shootout" || bench.judgeId === null) continue;

      const byContest = new Map<string, Task[]>();
      for (const task of tasks) {
        if (task.benchId !== bench.id || task.contestId === null) continue;
        const already = byContest.get(task.contestId);
        if (already === undefined) byContest.set(task.contestId, [task]);
        else already.push(task);
      }

      for (const [contestId, entries] of byContest) {
        if (contestStanding(entries) !== "ready") continue;
        waiting.push({
          contestId: contestId as JudgeableContest["contestId"],
          officeId: department.officeId,
          departmentId: department.id,
          judgeId: bench.judgeId,
          // All the entries were asked the same way, so the first one speaks for
          // the contest.
          priority: entries[0]?.priority ?? "normal",
        });
      }
    }
  }
  return waiting;
}

export function officeSnapshot(input: OfficeSnapshotInput): SchedulerSnapshot {
  return {
    offices: [
      {
        id: input.office.id,
        schedule: input.office.schedule,
        runState: input.office.runState,
        budget: input.office.budget,
        spentUsd: input.spend?.officeUsd ?? 0,
        priority: input.office.priority,
      },
    ],
    departments: input.departments.map((department) => ({
      id: department.id,
      officeId: department.officeId,
      schedule: department.schedule,
      runState: department.runState,
      budget: department.budget,
      spentUsd: input.spend?.byDepartment[department.id] ?? 0,
      priority: department.priority,
    })),
    employees: input.employees.map((employee) => ({
      id: employee.id,
      officeId: employee.officeId,
      departmentId: employee.departmentId,
      status: employee.status,
      // No hours of their own means the department's and the office's apply.
      schedule: employee.schedule ?? { kind: "always" },
      budget: employee.budget,
      spentUsd: input.spend?.byEmployee[employee.id] ?? 0,
      priority: employee.priority,
      selfImprovement: employee.selfImprovement,
    })),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      officeId: task.officeId,
      departmentId: task.departmentId,
      assigneeId: task.assigneeId,
      status: task.status,
      priority: task.priority,
      reviewerIds: task.reviewerIds,
      revision: task.history.length,
    })),
    recurring: input.recurring ?? [],
    contests: judgeableContests(input.departments, input.tasks),
  };
}
