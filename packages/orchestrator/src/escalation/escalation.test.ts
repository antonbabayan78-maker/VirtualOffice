import { describe, expect, it } from "vitest";
import {
  createTask,
  unwrap,
  type Connection,
  type ConnectionId,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@vo/core";
import {
  DEFAULT_ESCALATION_RULES,
  escalateTask,
  MAX_ESCALATION_HOPS,
  checkNoProgress,
  resolveEscalationTarget,
  staleTasks,
  type EscalationEmployee,
} from "./escalation.js";

const office = "office-acme" as OfficeId;
const eng = "dept-eng" as DepartmentId;
const ops = "dept-ops" as DepartmentId;
const exec = "dept-exec" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const boss = "emp-boss" as EmployeeId;
const chief = "emp-chief" as EmployeeId;

const employee = (
  id: EmployeeId,
  overrides: Partial<EscalationEmployee> = {},
): EscalationEmployee => ({
  id,
  departmentId: eng,
  supervisorId: null,
  status: "active",
  ...overrides,
});

const edge = (fromId: DepartmentId, toId: DepartmentId): Connection => ({
  id: `conn-${fromId}-${toId}` as ConnectionId,
  officeId: office,
  fromId,
  toId,
  kind: "escalates_to",
  enabled: true,
  rules: {},
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const graph = (
  employees: readonly EscalationEmployee[] = [],
  connections: readonly Connection[] = [],
) => ({ employees, connections });

describe("resolveEscalationTarget", () => {
  it("goes to the assignee's supervisor first", () => {
    const people = [employee(ada, { supervisorId: boss }), employee(boss)];
    expect(resolveEscalationTarget(graph(people), { employeeId: ada, departmentId: eng })).toEqual({
      kind: "employee",
      employeeId: boss,
      hops: 1,
    });
  });

  it("climbs past a supervisor who is not available", () => {
    const people = [
      employee(ada, { supervisorId: boss }),
      employee(boss, { status: "terminated", supervisorId: chief }),
      employee(chief),
    ];
    expect(resolveEscalationTarget(graph(people), { employeeId: ada, departmentId: eng })).toEqual({
      kind: "employee",
      employeeId: chief,
      hops: 2,
    });
  });

  it("follows the department's escalation edge when nobody is above the assignee", () => {
    const people = [employee(ada)];
    const target = resolveEscalationTarget(graph(people, [edge(eng, ops)]), {
      employeeId: ada,
      departmentId: eng,
    });
    expect(target).toEqual({ kind: "department", departmentId: ops, hops: 1 });
  });

  it("follows the edges as far as they go", () => {
    const connections = [edge(eng, ops), edge(ops, exec)];
    const target = resolveEscalationTarget(graph([employee(ada)], connections), {
      employeeId: ada,
      departmentId: eng,
    });
    expect(target).toEqual({ kind: "department", departmentId: exec, hops: 2 });
  });

  it("takes the same edge every time when a department has several", () => {
    const connections = [edge(eng, ops), edge(eng, exec)];
    const first = resolveEscalationTarget(graph([employee(ada)], connections), {
      employeeId: ada,
      departmentId: eng,
    });
    const shuffled = resolveEscalationTarget(graph([employee(ada)], [...connections].reverse()), {
      employeeId: ada,
      departmentId: eng,
    });
    expect(first).toEqual(shuffled);
  });

  it("ignores connections that are not escalation edges", () => {
    const reports: Connection = { ...edge(eng, ops), kind: "reports_to" };
    const target = resolveEscalationTarget(graph([employee(ada)], [reports]), {
      employeeId: ada,
      departmentId: eng,
    });
    expect(target).toEqual({ kind: "owner", hops: 0 });
  });

  it("lands on the owner when there is nobody and no edge", () => {
    expect(
      resolveEscalationTarget(graph([employee(ada)]), { employeeId: ada, departmentId: eng }),
    ).toEqual({ kind: "owner", hops: 0 });
  });

  it("lands on the owner for an unassigned task with no edge", () => {
    expect(resolveEscalationTarget(graph(), { employeeId: null, departmentId: eng })).toEqual({
      kind: "owner",
      hops: 0,
    });
  });

  it("stops at the owner rather than going round a cycle", () => {
    // Core forbids cycles, so this can only come from corrupt data — it must not hang.
    const connections = [edge(eng, ops), edge(ops, eng)];
    const target = resolveEscalationTarget(graph([employee(ada)], connections), {
      employeeId: ada,
      departmentId: eng,
    });
    expect(target.kind).toBe("owner");
  });

  it("stops climbing a supervisor chain that loops", () => {
    const people = [
      employee(ada, { supervisorId: boss, status: "paused" }),
      employee(boss, { supervisorId: ada, status: "paused" }),
    ];
    const target = resolveEscalationTarget(graph(people), { employeeId: ada, departmentId: eng });
    expect(target.kind).toBe("owner");
  });

  it("gives up after a sensible number of hops", () => {
    expect(MAX_ESCALATION_HOPS).toBeGreaterThan(1);
    const people: EscalationEmployee[] = [];
    for (let i = 0; i <= MAX_ESCALATION_HOPS + 2; i++) {
      people.push(
        employee(`emp-${String(i)}` as EmployeeId, {
          supervisorId: `emp-${String(i + 1)}` as EmployeeId,
          status: i === 0 ? "active" : "paused",
        }),
      );
    }
    const target = resolveEscalationTarget(graph(people), {
      employeeId: "emp-0" as EmployeeId,
      departmentId: eng,
    });
    expect(target.kind).toBe("owner");
  });
});

describe("checkNoProgress", () => {
  const t0 = new Date("2026-09-28T09:00:00.000Z");
  const make = (status: TaskStatus, lastEventAt = t0): Task => {
    const created = unwrap(
      createTask(
        { officeId: office, departmentId: eng, title: "Ship it", assigneeId: ada },
        { id: () => "task-1" as TaskId, now: () => lastEventAt },
      ),
    );
    return { ...created, status };
  };

  it("does nothing when the office has set no limit", () => {
    const stale = new Date(t0.getTime() + 30 * 86_400_000);
    expect(checkNoProgress(make("in_progress"), DEFAULT_ESCALATION_RULES, stale)).toBeNull();
  });

  it("fires once a task has sat still for longer than the limit", () => {
    const rules = { noProgressMs: 3_600_000 };
    const task = make("in_progress");
    expect(checkNoProgress(task, rules, new Date(t0.getTime() + 3_599_999))).toBeNull();
    expect(checkNoProgress(task, rules, new Date(t0.getTime() + 3_600_000))).toEqual({
      kind: "no_progress",
      idleMs: 3_600_000,
      limitMs: 3_600_000,
    });
  });

  it("measures from the last thing that happened, not from creation", () => {
    const rules = { noProgressMs: 3_600_000 };
    const task = make("in_progress");
    const busy: Task = {
      ...task,
      history: [
        ...task.history,
        {
          at: new Date(t0.getTime() + 3_000_000),
          from: "assigned",
          to: "in_progress",
          actorId: ada,
          reason: null,
        },
      ],
    };
    expect(checkNoProgress(busy, rules, new Date(t0.getTime() + 3_700_000))).toBeNull();
  });

  it("watches work in progress, in review and blocked", () => {
    const rules = { noProgressMs: 1_000 };
    const late = new Date(t0.getTime() + 10_000);
    for (const status of [
      "assigned",
      "in_progress",
      "in_review",
      "changes_requested",
      "blocked",
    ] as TaskStatus[]) {
      expect(checkNoProgress(make(status), rules, late), status).not.toBeNull();
    }
  });

  it("leaves alone what nobody is waiting on", () => {
    const rules = { noProgressMs: 1_000 };
    const late = new Date(t0.getTime() + 10_000);
    for (const status of [
      "backlog",
      "approved",
      "done",
      "cancelled",
      "escalated",
      "transferred",
    ] as TaskStatus[]) {
      expect(checkNoProgress(make(status), rules, late), status).toBeNull();
    }
  });

  it("picks the stuck tasks out of a list", () => {
    const rules = { noProgressMs: 1_000 };
    const late = new Date(t0.getTime() + 10_000);
    const fresh = {
      ...make("in_progress"),
      id: "task-2" as TaskId,
      history: [
        { at: late, from: null, to: "in_progress" as TaskStatus, actorId: ada, reason: null },
      ],
    };
    const found = staleTasks([make("in_progress"), fresh, make("done")], rules, late);
    expect(found.map((f) => f.task.id)).toEqual(["task-1"]);
    expect(found[0]?.trigger.kind).toBe("no_progress");
  });
});

describe("escalateTask", () => {
  const t0 = new Date("2026-09-28T09:00:00.000Z");
  const reviewing = (): Task => {
    const created = unwrap(
      createTask(
        { officeId: office, departmentId: eng, title: "Ship it", assigneeId: ada },
        { id: () => "task-1" as TaskId, now: () => t0 },
      ),
    );
    return { ...created, status: "in_review" };
  };
  const trigger = { kind: "no_progress", idleMs: 7_200_000, limitMs: 3_600_000 } as const;

  it("moves the task to escalated and names who it went to", () => {
    const outcome = unwrap(
      escalateTask(
        reviewing(),
        trigger,
        { type: "cancel", reason: "unused" },
        {
          policy: { kind: "manager", maxIterations: 3 },
          now: new Date(t0.getTime() + 7_200_000),
          escalationGraph: graph([employee(ada, { supervisorId: boss }), employee(boss)]),
        },
      ),
    );
    expect(outcome.task.status).toBe("escalated");
    expect(outcome.effects[0]).toMatchObject({
      type: "escalate",
      to: { kind: "employee", employeeId: boss },
    });
    expect(outcome.task.history.at(-1)?.reason).toMatch(/no progress/);
  });

  it("escalates to the owner when the office has drawn no path", () => {
    const outcome = unwrap(
      escalateTask(
        reviewing(),
        trigger,
        { type: "cancel", reason: "unused" },
        {
          policy: { kind: "manager", maxIterations: 3 },
          now: t0,
        },
      ),
    );
    expect(outcome.effects[0]).toMatchObject({ type: "escalate", to: { kind: "owner" } });
    expect(outcome.effects[1]).toMatchObject({ audience: "owner" });
  });

  it("tells the supervisor, not the owner, when a person is taking it on", () => {
    const outcome = unwrap(
      escalateTask(
        reviewing(),
        trigger,
        { type: "cancel", reason: "unused" },
        {
          policy: { kind: "manager", maxIterations: 3 },
          now: t0,
          escalationGraph: graph([employee(ada, { supervisorId: boss }), employee(boss)]),
        },
      ),
    );
    expect(outcome.effects[1]).toMatchObject({ audience: "supervisor" });
  });

  it("refuses to escalate work that is already finished", () => {
    const done: Task = { ...reviewing(), status: "done" };
    const result = escalateTask(
      done,
      trigger,
      { type: "cancel", reason: "unused" },
      {
        policy: { kind: "manager", maxIterations: 3 },
        now: t0,
      },
    );
    expect(result.ok).toBe(false);
  });
});
