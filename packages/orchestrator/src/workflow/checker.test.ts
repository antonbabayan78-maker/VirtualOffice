import { describe, expect, it } from "vitest";
import type { Connection, ConnectionId, DepartmentId, EmployeeId, OfficeId, Task } from "@vo/core";
import { checkerFor, signedOffBy } from "./checker.js";
import type { PeerCandidate, WorkflowContext } from "./workflow-types.js";

const officeId = "office-1" as OfficeId;
const engineering = "dept-engineering" as DepartmentId;
const operations = "dept-operations" as DepartmentId;
const nadia = "emp-nadia" as EmployeeId;
const ada = "emp-ada" as EmployeeId;
const at = new Date("2026-09-29T09:00:00Z");

const reviews = (overrides: Partial<Connection> = {}): Connection => ({
  id: "conn-check" as ConnectionId,
  officeId,
  fromId: operations,
  toId: engineering,
  kind: "reviews",
  enabled: true,
  rules: {},
  createdAt: at,
  ...overrides,
});

const person = (id: EmployeeId, departmentId: DepartmentId): PeerCandidate => ({
  id,
  departmentId,
  status: "active",
  skillIds: [],
  openTasks: 0,
});

const context = (
  connections: readonly Connection[],
  colleagues: readonly PeerCandidate[] = [person(nadia, operations), person(ada, engineering)],
): WorkflowContext => ({
  policy: { kind: "direct" },
  now: at,
  colleagues,
  escalationGraph: { employees: [], connections },
});

const task = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "task-1",
    officeId,
    departmentId: engineering,
    title: "Build the export endpoint",
    status: "in_review",
    checkedBy: [],
    ...overrides,
  }) as Task;

describe("whether somebody else still has to look at this", () => {
  it("names the department that checks this one's work", () => {
    expect(checkerFor(task(), context([reviews()]))?.departmentId).toBe(operations);
  });

  it("names somebody there to do the checking", () => {
    expect(checkerFor(task(), context([reviews()]))?.reviewerId).toBe(nadia);
  });

  it("asks nobody when no department checks this one", () => {
    expect(checkerFor(task(), context([]))).toBeNull();
  });

  it("asks nobody once that department has already signed off", () => {
    expect(checkerFor(task({ checkedBy: [operations] }), context([reviews()]))).toBeNull();
  });

  it("asks nobody when the arrow is switched off", () => {
    expect(checkerFor(task(), context([reviews({ enabled: false })]))).toBeNull();
  });

  it("asks nobody when the arrow points at a different department", () => {
    const elsewhere = reviews({ toId: "dept-design" as DepartmentId });
    expect(checkerFor(task(), context([elsewhere]))).toBeNull();
  });

  it("ignores an arrow of another kind between the same pair", () => {
    expect(checkerFor(task(), context([reviews({ kind: "handoff" })]))).toBeNull();
  });

  it("asks nobody when the checking department has nobody in it", () => {
    // Work cannot wait forever on a department that does not exist; it goes
    // through rather than stalling where nobody will ever look.
    expect(checkerFor(task(), context([reviews()], [person(ada, engineering)]))).toBeNull();
  });

  it("never asks somebody to check their own department's work", () => {
    const itself = reviews({ fromId: engineering });
    expect(checkerFor(task(), context([itself]))).toBeNull();
  });

  it("takes the checkers one at a time, so a queue of them is answered in order", () => {
    const design = "dept-design" as DepartmentId;
    const second = reviews({ id: "conn-2" as ConnectionId, fromId: design });
    const colleagues = [
      person(nadia, operations),
      person("emp-iris" as EmployeeId, design),
      person(ada, engineering),
    ];
    const first = checkerFor(task(), context([reviews(), second], colleagues));
    expect(first?.departmentId).toBe(operations);

    const next = checkerFor(
      task({ checkedBy: [operations] }),
      context([reviews(), second], colleagues),
    );
    expect(next?.departmentId).toBe(design);
  });

  it("prefers whoever in the checking department has least on", () => {
    const busy = { ...person(nadia, operations), openTasks: 5 };
    const free = person("emp-otto" as EmployeeId, operations);
    expect(checkerFor(task(), context([reviews()], [busy, free]))?.reviewerId).toBe("emp-otto");
  });
});

describe("recording that a department has looked at it", () => {
  it("signs when the approver belongs to a department that checks this one", () => {
    const signed = signedOffBy(task(), nadia, context([reviews()]));
    expect(signed).toEqual([operations]);
  });

  it("does not sign for somebody from the department that did the work", () => {
    expect(signedOffBy(task(), ada, context([reviews()]))).toEqual([]);
  });

  it("keeps signatures it already had", () => {
    const design = "dept-design" as DepartmentId;
    const already = task({ checkedBy: [design] });
    expect(signedOffBy(already, nadia, context([reviews()]))).toEqual([design, operations]);
  });

  it("does not sign twice for the same department", () => {
    const already = task({ checkedBy: [operations] });
    expect(signedOffBy(already, nadia, context([reviews()]))).toEqual([operations]);
  });

  it("signs nothing when nobody was acting", () => {
    expect(signedOffBy(task(), null, context([reviews()]))).toEqual([]);
  });
});
