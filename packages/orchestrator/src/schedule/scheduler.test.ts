import { describe, expect, it } from "vitest";
import { FakeLlmProvider, reply } from "@vo/llm";
import type {
  ContestId,
  DepartmentId,
  EmployeeId,
  OfficeId,
  Schedule,
  TaskId,
  TaskPriority,
  TaskStatus,
} from "@vo/core";
import { InProcessJobQueue } from "../queue/in-process-queue.js";
import {
  AGENT_JUDGE_JOB,
  AGENT_REVIEW_JOB,
  computeDueWork,
  enqueueDueWork,
  type JudgeableContest,
  type RecurringJob,
  type RunnableTask,
  type SchedulerSnapshot,
} from "./scheduler.js";

const office = "office-acme" as OfficeId;
const dept = "dept-eng" as DepartmentId;
const ada = "emp-ada" as EmployeeId;

const ALWAYS: Schedule = { kind: "always" };
/** Weekdays 09:00-17:00 in Nicosia. */
const OFFICE_HOURS: Schedule = {
  kind: "windows",
  timezone: "Asia/Nicosia",
  windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
};

// 2026-09-28 is a Monday. 10:00 Nicosia (UTC+3) is 07:00 UTC.
const duringHours = new Date("2026-09-28T07:00:00.000Z");
const afterHours = new Date("2026-09-28T19:00:00.000Z");

const task = (overrides: Partial<RunnableTask> = {}): RunnableTask => ({
  id: "task-1" as TaskId,
  officeId: office,
  departmentId: dept,
  assigneeId: ada,
  status: "assigned",
  priority: "normal",
  reviewerIds: [],
  revision: 1,
  ...overrides,
});

const snapshot = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
  offices: [{ id: office, schedule: ALWAYS }],
  departments: [{ id: dept, officeId: office, schedule: ALWAYS }],
  employees: [
    { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
  ],
  tasks: [],
  recurring: [],
  ...overrides,
});

describe("computeDueWork: idle cost", () => {
  it("does no work and talks to no model when there is nothing to do", () => {
    const provider = new FakeLlmProvider({ script: [reply("never asked")] });
    const due = computeDueWork(snapshot(), duringHours);
    expect(due.jobs).toEqual([]);
    expect(due.skipped).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("talks to no model even when there is plenty to do", () => {
    const provider = new FakeLlmProvider({ script: [reply("never asked")] });
    const due = computeDueWork(snapshot({ tasks: [task()] }), duringHours);
    expect(due.jobs).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("computeDueWork: tasks", () => {
  it("queues a run for work that is assigned or under way", () => {
    for (const status of ["assigned", "in_progress"] as TaskStatus[]) {
      const due = computeDueWork(snapshot({ tasks: [task({ status })] }), duringHours);
      expect(
        due.jobs.map((j) => j.kind),
        status,
      ).toEqual(["agent_run"]);
      expect(due.jobs[0]).toMatchObject({ officeId: office, employeeId: ada });
      expect(due.jobs[0]?.payload).toMatchObject({ taskId: "task-1" });
    }
  });

  it("leaves work that is not the agent's move alone", () => {
    for (const status of [
      "backlog",
      "in_review",
      "changes_requested",
      "approved",
      "done",
      "blocked",
      "escalated",
      "cancelled",
    ] as TaskStatus[]) {
      const due = computeDueWork(snapshot({ tasks: [task({ status })] }), duringHours);
      expect(due.jobs, status).toEqual([]);
    }
  });

  it("carries the task's priority into the queue", () => {
    const priorities: TaskPriority[] = ["low", "normal", "high", "urgent"];
    const jobs = priorities.map(
      (priority) =>
        computeDueWork(snapshot({ tasks: [task({ priority })] }), duringHours).jobs[0]?.priority ??
        0,
    );
    expect(jobs).toEqual([...jobs].sort((a, b) => a - b));
    expect(new Set(jobs).size).toBe(4);
  });

  it("skips a task nobody is assigned to", () => {
    const due = computeDueWork(snapshot({ tasks: [task({ assigneeId: null })] }), duringHours);
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "unassigned" });
  });

  it("skips a paused or terminated employee", () => {
    for (const status of ["paused", "terminated"] as const) {
      const due = computeDueWork(
        snapshot({
          tasks: [task()],
          employees: [{ id: ada, officeId: office, departmentId: dept, status, schedule: ALWAYS }],
        }),
        duringHours,
      );
      expect(due.jobs, status).toEqual([]);
      expect(due.skipped[0]).toMatchObject({ reason: "employee_unavailable" });
    }
  });

  it("skips a task whose assignee is not in the office at all", () => {
    const due = computeDueWork(snapshot({ tasks: [task()], employees: [] }), duringHours);
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "unknown_employee" });
  });

  it("respects the office, the department and the employee's own hours", () => {
    const cases: readonly [string, SchedulerSnapshot][] = [
      [
        "office_closed",
        snapshot({ tasks: [task()], offices: [{ id: office, schedule: OFFICE_HOURS }] }),
      ],
      [
        "department_closed",
        snapshot({
          tasks: [task()],
          departments: [{ id: dept, officeId: office, schedule: OFFICE_HOURS }],
        }),
      ],
      [
        "employee_closed",
        snapshot({
          tasks: [task()],
          employees: [
            {
              id: ada,
              officeId: office,
              departmentId: dept,
              status: "active",
              schedule: OFFICE_HOURS,
            },
          ],
        }),
      ],
    ];
    for (const [reason, input] of cases) {
      expect(computeDueWork(input, duringHours).jobs, `${reason} during hours`).toHaveLength(1);
      const closed = computeDueWork(input, afterHours);
      expect(closed.jobs, `${reason} after hours`).toEqual([]);
      expect(closed.skipped[0]).toMatchObject({ reason });
    }
  });

  it("keys a run by the task's revision, so repeated ticks are one job", () => {
    const first = computeDueWork(snapshot({ tasks: [task()] }), duringHours);
    const again = computeDueWork(snapshot({ tasks: [task()] }), duringHours);
    expect(first.jobs[0]?.idempotencyKey).toBe(again.jobs[0]?.idempotencyKey);

    const moved = computeDueWork(snapshot({ tasks: [task({ revision: 2 })] }), duringHours);
    expect(moved.jobs[0]?.idempotencyKey).not.toBe(first.jobs[0]?.idempotencyKey);
  });
});

describe("computeDueWork: reviews", () => {
  // Two changes can share a millisecond, so the key must not be time-based.
  const bob = "emp-bob" as EmployeeId;
  const withReviewer = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
    ...snapshot(),
    employees: [
      { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
      { id: bob, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
    ],
    ...overrides,
  });

  it("asks the reviewer to review, not the author to work", () => {
    const due = computeDueWork(
      withReviewer({ tasks: [task({ status: "in_review", reviewerIds: [bob] })] }),
      duringHours,
    );
    expect(due.jobs.map((j) => j.kind)).toEqual([AGENT_REVIEW_JOB]);
    expect(due.jobs[0]).toMatchObject({ employeeId: bob });
    expect(due.jobs[0]?.payload).toMatchObject({ taskId: "task-1" });
  });

  it("leaves a review with no named reviewer to the human it belongs to", () => {
    const due = computeDueWork(
      withReviewer({ tasks: [task({ status: "in_review", reviewerIds: [] })] }),
      duringHours,
    );
    expect(due.jobs).toEqual([]);
  });

  it("asks the first reviewer who is actually available", () => {
    const paused = withReviewer({
      tasks: [task({ status: "in_review", reviewerIds: [bob, ada] })],
      employees: [
        { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
        { id: bob, officeId: office, departmentId: dept, status: "paused", schedule: ALWAYS },
      ],
    });
    expect(computeDueWork(paused, duringHours).jobs[0]).toMatchObject({ employeeId: ada });
  });

  it("holds the review until the reviewer is at work", () => {
    const closed = withReviewer({
      tasks: [task({ status: "in_review", reviewerIds: [bob] })],
      employees: [
        { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
        { id: bob, officeId: office, departmentId: dept, status: "active", schedule: OFFICE_HOURS },
      ],
    });
    expect(computeDueWork(closed, duringHours).jobs).toHaveLength(1);
    const outOfHours = computeDueWork(closed, afterHours);
    expect(outOfHours.jobs).toEqual([]);
    expect(outOfHours.skipped[0]).toMatchObject({ reason: "employee_closed" });
  });

  it("keys a review by the task's revision, so one review is queued once", () => {
    const input = withReviewer({ tasks: [task({ status: "in_review", reviewerIds: [bob] })] });
    const first = computeDueWork(input, duringHours);
    const again = computeDueWork(input, duringHours);
    expect(first.jobs[0]?.idempotencyKey).toBe(again.jobs[0]?.idempotencyKey);
    expect(first.jobs[0]?.idempotencyKey).toMatch(/^agent_review:/);
  });
});

describe("computeDueWork: recurring work", () => {
  const digest = (overrides: Partial<RecurringJob> = {}): RecurringJob => ({
    id: "digest",
    officeId: office,
    cron: "0 9 * * 1-5",
    timezone: "Asia/Nicosia",
    kind: "daily_digest",
    lastRunAt: null,
    ...overrides,
  });

  // 09:00 Nicosia on Monday 2026-09-28 is 06:00 UTC.
  const atNine = new Date("2026-09-28T06:00:30.000Z");

  it("fires an occurrence that has come due and says when it was due", () => {
    const due = computeDueWork(snapshot({ recurring: [digest()] }), atNine);
    expect(due.jobs.map((j) => j.kind)).toEqual(["daily_digest"]);
    expect(due.recurringFired).toEqual([
      { id: "digest", dueAt: new Date("2026-09-28T06:00:00.000Z").getTime() },
    ]);
  });

  it("does not fire a brand new definition outside its own minute", () => {
    const due = computeDueWork(snapshot({ recurring: [digest()] }), duringHours);
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "not_due" });
  });

  it("fires once for a run that was missed for days, not once per missed day", () => {
    const missed = digest({ lastRunAt: new Date("2026-09-23T06:00:00.000Z").getTime() });
    const due = computeDueWork(snapshot({ recurring: [missed] }), atNine);
    expect(due.jobs).toHaveLength(1);
    // The oldest missed occurrence, so nothing is silently forgotten.
    expect(due.recurringFired[0]?.dueAt).toBe(new Date("2026-09-24T06:00:00.000Z").getTime());
  });

  it("does not fire again within the same occurrence", () => {
    const justRan = digest({ lastRunAt: new Date("2026-09-28T06:00:00.000Z").getTime() });
    expect(computeDueWork(snapshot({ recurring: [justRan] }), atNine).jobs).toEqual([]);
  });

  it("holds a due occurrence back while the office is closed", () => {
    const weekend = digest({ cron: "0 9 * * *" });
    const closed = snapshot({
      recurring: [weekend],
      offices: [{ id: office, schedule: OFFICE_HOURS }],
    });
    // Sunday 09:00 Nicosia: due by cron, but the office is shut.
    const due = computeDueWork(closed, new Date("2026-09-27T06:00:30.000Z"));
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "office_closed" });
  });

  it("aims recurring work at an employee when the definition names one", () => {
    const mine = digest({ employeeId: ada, departmentId: dept });
    const due = computeDueWork(snapshot({ recurring: [mine] }), atNine);
    expect(due.jobs[0]).toMatchObject({ employeeId: ada });
  });

  it("reports a broken expression instead of throwing on the tick", () => {
    const due = computeDueWork(snapshot({ recurring: [digest({ cron: "not a cron" })] }), atNine);
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "bad_cron" });
  });

  it("reports a definition for an office that is not there", () => {
    const due = computeDueWork(
      snapshot({ recurring: [digest({ officeId: "office-gone" as OfficeId })] }),
      atNine,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "unknown_office" });
  });
});

describe("enqueueDueWork", () => {
  it("puts due work on the queue and ticks again without duplicating it", async () => {
    const queue = new InProcessJobQueue({}, { now: () => duringHours.getTime() });
    const input = snapshot({ tasks: [task()] });

    const first = await enqueueDueWork(queue, input, duringHours);
    expect(first.enqueued).toBe(1);
    expect((await queue.stats()).pending).toBe(1);

    const second = await enqueueDueWork(queue, input, duringHours);
    expect(second.enqueued).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect((await queue.stats()).pending).toBe(1);
  });
});

describe("ordering work by the level that decided it", () => {
  const keyOf = (snap: SchedulerSnapshot): number =>
    computeDueWork(snap, duringHours).jobs[0]?.priority ?? -1;

  it("gives every job the same key when no level has an opinion", () => {
    const a = keyOf(snapshot({ tasks: [task()] }));
    const b = keyOf(snapshot({ tasks: [task({ id: "task-2" as TaskId })] }));
    expect(a).toBe(b);
  });

  it("carries the department's standing priority into the queue", () => {
    const crunched = keyOf(
      snapshot({
        departments: [{ id: dept, officeId: office, schedule: ALWAYS, priority: "urgent" }],
        tasks: [task({ priority: "low" })],
      }),
    );
    const ordinary = keyOf(snapshot({ tasks: [task({ priority: "urgent" })] }));

    // A crunched department's least important work still outranks an urgent
    // task belonging to a department nobody has prioritised.
    expect(crunched).toBeGreaterThan(ordinary);
  });

  it("carries the office's standing priority, which outranks a department's", () => {
    const fromTheTop = keyOf(
      snapshot({
        offices: [{ id: office, schedule: ALWAYS, priority: "high" }],
        tasks: [task({ priority: "low" })],
      }),
    );
    const fromTheDepartment = keyOf(
      snapshot({
        departments: [{ id: dept, officeId: office, schedule: ALWAYS, priority: "urgent" }],
        tasks: [task({ priority: "urgent" })],
      }),
    );
    expect(fromTheTop).toBeGreaterThan(fromTheDepartment);
  });

  it("carries the employee's own standing priority", () => {
    const yielding = keyOf(
      snapshot({
        employees: [
          {
            id: ada,
            officeId: office,
            departmentId: dept,
            status: "active",
            schedule: ALWAYS,
            priority: "low",
          },
        ],
        tasks: [task()],
      }),
    );
    expect(yielding).toBeLessThan(keyOf(snapshot({ tasks: [task()] })));
  });

  it("treats a level that has set nothing as ordinary, rather than as nothing", () => {
    // Snapshots built before there were levels leave the field out entirely.
    // Absent has to mean normal, or every one of them sinks to the bottom.
    const silent = keyOf(
      snapshot({ offices: [{ id: office, schedule: ALWAYS }], tasks: [task()] }),
    );
    const explicit = keyOf(
      snapshot({
        offices: [{ id: office, schedule: ALWAYS, priority: "normal" }],
        tasks: [task()],
      }),
    );
    expect(silent).toBe(explicit);
  });

  it("ranks a review by the task's department and the reviewer's own standing", () => {
    const reviewer = "emp-grace" as EmployeeId;
    const withReviewer = (priority: TaskPriority): number =>
      computeDueWork(
        snapshot({
          departments: [{ id: dept, officeId: office, schedule: ALWAYS, priority: "high" }],
          employees: [
            { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
            {
              id: reviewer,
              officeId: office,
              departmentId: dept,
              status: "active",
              schedule: ALWAYS,
              priority,
            },
          ],
          tasks: [task({ status: "in_review", reviewerIds: [reviewer] })],
        }),
        duringHours,
      ).jobs[0]?.priority ?? -1;

    expect(withReviewer("high")).toBeGreaterThan(withReviewer("low"));
  });
});

describe("recurring work takes its place in the same order", () => {
  const dueDigest = (overrides: Partial<RecurringJob> = {}): number =>
    computeDueWork(
      snapshot({
        recurring: [
          {
            id: "digest",
            officeId: office,
            departmentId: dept,
            employeeId: ada,
            cron: "0 9 * * *",
            kind: "daily_digest",
            lastRunAt: null,
            ...overrides,
          },
        ],
      }),
      new Date("2026-09-28T09:00:00.000Z"),
    ).jobs[0]?.priority ?? -1;

  it("ranks a recurring job by the same levels as everything else", () => {
    // Not zero: on a raw number it would sink below every ordinary task.
    expect(dueDigest()).toBe(
      computeDueWork(snapshot({ tasks: [task()] }), duringHours).jobs[0]?.priority,
    );
  });

  it("lets a recurring definition ask for a priority of its own", () => {
    expect(dueDigest({ priority: "urgent" })).toBeGreaterThan(dueDigest({ priority: "low" }));
  });

  it("is outranked by the department it belongs to, like any other work", () => {
    const crunched = computeDueWork(
      snapshot({
        departments: [{ id: dept, officeId: office, schedule: ALWAYS, priority: "urgent" }],
        recurring: [
          {
            id: "digest",
            officeId: office,
            departmentId: dept,
            employeeId: ada,
            cron: "0 9 * * *",
            kind: "daily_digest",
            lastRunAt: null,
            priority: "low",
          },
        ],
      }),
      new Date("2026-09-28T09:00:00.000Z"),
    ).jobs[0]?.priority;

    expect(crunched).toBeGreaterThan(dueDigest({ priority: "urgent" }));
  });
});

describe("an office or a room somebody stopped", () => {
  it("passes over every task in a stopped office", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, runState: "paused" }],
      }),
      duringHours,
    );
    expect(due.jobs).toEqual([]);
  });

  it("says it was stopped rather than shut, which are different facts", () => {
    // Closed ends by itself when the hours come round; stopped does not, and a
    // trail that conflates them cannot tell you why nothing is happening.
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, runState: "paused" }],
      }),
      duringHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "office_paused" });
  });

  it("says stopped even when the hours are against it too", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: OFFICE_HOURS, runState: "paused" }],
      }),
      afterHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "office_paused" });
  });

  it("passes over a task in a stopped room, and says which", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        departments: [{ id: dept, officeId: office, schedule: ALWAYS, runState: "paused" }],
      }),
      duringHours,
    );
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "department_paused" });
  });

  it("leaves the rest of the office working when one room is stopped", () => {
    const other = "dept-sales" as DepartmentId;
    const due = computeDueWork(
      snapshot({
        tasks: [task(), task({ id: "task-2" as TaskId, departmentId: other })],
        departments: [
          { id: dept, officeId: office, schedule: ALWAYS, runState: "paused" },
          { id: other, officeId: office, schedule: ALWAYS },
        ],
      }),
      duringHours,
    );
    expect(due.jobs).toHaveLength(1);
    expect(due.jobs[0]?.payload).toMatchObject({ taskId: "task-2" });
  });

  it("holds recurring work back in a stopped office too", () => {
    const due = computeDueWork(
      snapshot({
        recurring: [
          {
            id: "digest",
            officeId: office,
            cron: "0 9 * * 1-5",
            timezone: "Asia/Nicosia",
            kind: "daily_digest",
            lastRunAt: null,
          },
        ],
        offices: [{ id: office, schedule: ALWAYS, runState: "paused" }],
      }),
      // 09:00 Nicosia on Monday: due by cron, and stopped by a person.
      new Date("2026-09-28T06:00:30.000Z"),
    );
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "office_paused" });
  });

  it("works as before when nothing says anything about a switch", () => {
    // Every snapshot built before this existed says nothing, and must run.
    const due = computeDueWork(snapshot({ tasks: [task()] }), duringHours);
    expect(due.jobs).toHaveLength(1);
  });

  it("starts working again the moment it is put back", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, runState: "running" }],
      }),
      duringHours,
    );
    expect(due.jobs).toHaveLength(1);
  });
});

describe("work stopped by a budget rather than by a person", () => {
  const capped = { limitUsd: 10, warnAtUsd: 8, period: "day" as const };

  it("passes over a task when the office is over its budget", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, budget: capped, spentUsd: 10 }],
      }),
      duringHours,
    );
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "office_over_budget" });
  });

  it("says which level stopped it, since that is the first thing anybody asks", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        departments: [
          { id: dept, officeId: office, schedule: ALWAYS, budget: capped, spentUsd: 12 },
        ],
      }),
      duringHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "department_over_budget" });
  });

  it("stops one person without stopping the room", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        employees: [
          {
            id: ada,
            officeId: office,
            departmentId: dept,
            status: "active",
            schedule: ALWAYS,
            budget: capped,
            spentUsd: 10,
          },
        ],
      }),
      duringHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "employee_over_budget" });
  });

  it("keeps working below the limit", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, budget: capped, spentUsd: 9.99 }],
      }),
      duringHours,
    );
    expect(due.jobs).toHaveLength(1);
  });

  it("keeps working at a warning, which is a warning and not a stop", () => {
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: ALWAYS, budget: capped, spentUsd: 8.5 }],
      }),
      duringHours,
    );
    expect(due.jobs).toHaveLength(1);
  });

  it("says a person stopped it rather than a budget, when both are true", () => {
    // A stopped office is stopped whatever it has spent, and "somebody stopped
    // this" is the more useful answer of the two.
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [
          { id: office, schedule: ALWAYS, runState: "paused", budget: capped, spentUsd: 99 },
        ],
      }),
      duringHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "office_paused" });
  });

  it("says over budget rather than shut, when both are true", () => {
    // "Shut until Monday" implies waiting will fix it, and here it will not.
    const due = computeDueWork(
      snapshot({
        tasks: [task()],
        offices: [{ id: office, schedule: OFFICE_HOURS, budget: capped, spentUsd: 10 }],
      }),
      afterHours,
    );
    expect(due.skipped[0]).toMatchObject({ reason: "office_over_budget" });
  });

  it("works as before when no level has a budget", () => {
    expect(computeDueWork(snapshot({ tasks: [task()] }), duringHours).jobs).toHaveLength(1);
  });

  it("works when a budget is set and nothing has been spent", () => {
    const due = computeDueWork(
      snapshot({ tasks: [task()], offices: [{ id: office, schedule: ALWAYS, budget: capped }] }),
      duringHours,
    );
    expect(due.jobs).toHaveLength(1);
  });

  it("holds recurring work back too, so a digest cannot outspend the cap", () => {
    const due = computeDueWork(
      snapshot({
        recurring: [
          {
            id: "digest",
            officeId: office,
            cron: "0 9 * * 1-5",
            timezone: "Asia/Nicosia",
            kind: "daily_digest",
            lastRunAt: null,
          },
        ],
        offices: [{ id: office, schedule: ALWAYS, budget: capped, spentUsd: 10 }],
      }),
      new Date("2026-09-28T06:00:30.000Z"),
    );
    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]).toMatchObject({ reason: "office_over_budget" });
  });
});

describe("computeDueWork: a contest waiting to be judged", () => {
  const grace = "emp-grace" as EmployeeId;
  const other = "dept-design" as DepartmentId;

  const contest = (overrides: Partial<JudgeableContest> = {}): JudgeableContest => ({
    contestId: "contest-1" as ContestId,
    officeId: office,
    departmentId: dept,
    judgeId: grace,
    priority: "normal",
    ...overrides,
  });

  /** Grace judges, and works in another room, as a judge usually does. */
  const withJudge = (overrides: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot =>
    snapshot({
      departments: [
        { id: dept, officeId: office, schedule: ALWAYS },
        { id: other, officeId: office, schedule: ALWAYS },
      ],
      employees: [
        { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
        { id: grace, officeId: office, departmentId: other, status: "active", schedule: ALWAYS },
      ],
      contests: [contest()],
      ...overrides,
    });

  it("asks the judge to decide it", () => {
    const due = computeDueWork(withJudge(), duringHours);
    expect(due.jobs).toHaveLength(1);
    expect(due.jobs[0]?.kind).toBe(AGENT_JUDGE_JOB);
    expect(due.jobs[0]?.employeeId).toBe(grace);
  });

  it("says which contest, so the worker can read its entries", () => {
    const due = computeDueWork(withJudge(), duringHours);
    expect(due.jobs[0]?.payload).toMatchObject({ contestId: "contest-1", departmentId: dept });
  });

  it("queues one job however many ticks see the same contest", async () => {
    const queue = new InProcessJobQueue();
    await enqueueDueWork(queue, withJudge(), duringHours);
    const second = await enqueueDueWork(queue, withJudge(), duringHours);

    expect(second.enqueued).toBe(0);
    expect(second.deduplicated).toBe(1);
  });

  it("waits while the judge's own hours are shut, rather than deciding at 3am", () => {
    // A judge's hours are their own, exactly as a reviewer's are.
    const shut = withJudge({
      employees: [
        { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
        {
          id: grace,
          officeId: office,
          departmentId: other,
          status: "active",
          schedule: OFFICE_HOURS,
        },
      ],
    });
    const due = computeDueWork(shut, afterHours);

    expect(due.jobs).toEqual([]);
    expect(due.skipped).toEqual([{ what: "contest-1", reason: "employee_closed" }]);
  });

  it("does not ask somebody who has been paused", () => {
    const away = withJudge({
      employees: [
        { id: ada, officeId: office, departmentId: dept, status: "active", schedule: ALWAYS },
        { id: grace, officeId: office, departmentId: other, status: "paused", schedule: ALWAYS },
      ],
    });
    expect(computeDueWork(away, duringHours).jobs).toEqual([]);
  });

  it("does not ask while the office is stopped", () => {
    const stopped = withJudge({ offices: [{ id: office, schedule: ALWAYS, runState: "paused" }] });
    expect(computeDueWork(stopped, duringHours).skipped[0]?.reason).toBe("office_paused");
  });

  it("does not spend past a budget to decide a contest", () => {
    // Judging is a call like any other, and an office that has run out has run
    // out — the person can still decide it themselves.
    const broke = withJudge({
      offices: [
        {
          id: office,
          schedule: ALWAYS,
          budget: { limitUsd: 5, warnAtUsd: null, period: "day" },
          spentUsd: 6,
        },
      ],
    });
    expect(computeDueWork(broke, duringHours).skipped[0]?.reason).toBe("office_over_budget");
  });

  it("says so rather than silently skipping a judge who has left", () => {
    const gone = withJudge({ contests: [contest({ judgeId: "emp-nowhere" as EmployeeId })] });
    const due = computeDueWork(gone, duringHours);

    expect(due.jobs).toEqual([]);
    expect(due.skipped[0]?.reason).toBe("unknown_employee");
  });

  it("ranks judging alongside everything else, by the levels it belongs to", () => {
    const urgent = withJudge({ contests: [contest({ priority: "urgent" })] });
    const ordinary = computeDueWork(withJudge(), duringHours).jobs[0]?.priority ?? 0;

    expect(computeDueWork(urgent, duringHours).jobs[0]?.priority).toBeGreaterThan(ordinary);
  });

  it("asks nobody when an office has no contests waiting, which is most ticks", () => {
    expect(computeDueWork(snapshot(), duringHours).jobs).toEqual([]);
  });

  it("schedules an office that predates contests exactly as it did", () => {
    // `contests` absent, not empty: a snapshot built before this existed.
    const { contests, ...old } = snapshot({ tasks: [task()] });
    expect(contests).toBeUndefined();
    expect(computeDueWork(old, duringHours).jobs).toHaveLength(1);
  });
});
