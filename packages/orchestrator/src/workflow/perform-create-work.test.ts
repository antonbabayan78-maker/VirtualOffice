import { describe, expect, it } from "vitest";
import { unwrap, type DepartmentId, type EmployeeId, type OfficeId, type TaskId } from "@vo/core";
import {
  chooseRecipient,
  performCreateWork,
  type CreateWorkEffect,
} from "./perform-create-work.js";
import type { PeerCandidate } from "./workflow-types.js";

const officeId = "office-1" as OfficeId;
const design = "dept-design" as DepartmentId;
const deps = { id: () => "task-new" as TaskId, now: () => new Date("2026-09-28T09:00:00Z") };

const effect = (overrides: Partial<CreateWorkEffect> = {}): CreateWorkEffect => ({
  type: "create_work",
  because: "handoff",
  connectionId: "conn-1" as never,
  toDepartmentId: design,
  title: "Draw the export screen",
  brief: "Handed on from Product.",
  artifacts: ["the brief"],
  priority: "high",
  route: ["dept-product" as DepartmentId],
  assign: { kind: "anyone" },
  ...overrides,
});

const person = (id: string, overrides: Partial<PeerCandidate> = {}): PeerCandidate => ({
  id: id as EmployeeId,
  status: "active",
  skillIds: [],
  openTasks: 0,
  ...overrides,
});

describe("choosing who takes handed-on work", () => {
  it("takes the person the connection names", () => {
    const chosen = chooseRecipient(effect({ assign: { kind: "named", employeeId: "emp-theo" } }), [
      person("emp-iris"),
      person("emp-theo"),
    ]);
    expect(chosen).toBe("emp-theo");
  });

  it("gives it to somebody else when the person named has left", () => {
    // The department still has the work to do; a name that no longer answers is
    // not a reason to drop it.
    const chosen = chooseRecipient(effect({ assign: { kind: "named", employeeId: "emp-gone" } }), [
      person("emp-iris"),
    ]);
    expect(chosen).toBe("emp-iris");
  });

  it("never gives it to somebody who is not active", () => {
    const chosen = chooseRecipient(effect({ assign: { kind: "named", employeeId: "emp-theo" } }), [
      person("emp-theo", { status: "paused" }),
      person("emp-iris"),
    ]);
    expect(chosen).toBe("emp-iris");
  });

  it("matches the skill the connection asked for", () => {
    const chosen = chooseRecipient(effect({ assign: { kind: "skill", skill: "visual" } }), [
      person("emp-iris"),
      person("emp-theo", { skillIds: ["visual"] }),
    ]);
    expect(chosen).toBe("emp-theo");
  });

  it("prefers whoever has least on when the skill is a draw", () => {
    const chosen = chooseRecipient(effect({ assign: { kind: "skill", skill: "visual" } }), [
      person("emp-iris", { skillIds: ["visual"], openTasks: 4 }),
      person("emp-theo", { skillIds: ["visual"], openTasks: 1 }),
    ]);
    expect(chosen).toBe("emp-theo");
  });

  it("gives it to whoever is freest when the connection says nothing", () => {
    const chosen = chooseRecipient(effect(), [
      person("emp-iris", { openTasks: 3 }),
      person("emp-theo", { openTasks: 0 }),
    ]);
    expect(chosen).toBe("emp-theo");
  });

  it("says nobody when the department is empty", () => {
    expect(chooseRecipient(effect(), [])).toBeNull();
  });

  it("says nobody when everybody there has gone", () => {
    expect(chooseRecipient(effect(), [person("emp-iris", { status: "terminated" })])).toBeNull();
  });
});

describe("making the next department's work", () => {
  const placed = (candidates: readonly PeerCandidate[] = [person("emp-theo")]) =>
    unwrap(performCreateWork(effect(), officeId, candidates, deps));

  it("puts it in the department the work was handed to", () => {
    expect(placed().task.departmentId).toBe(design);
  });

  it("carries the work itself across", () => {
    expect(placed().task.artifacts).toEqual(["the brief"]);
  });

  it("carries the route, with the department that handed it on already in it", () => {
    expect(placed().task.route).toEqual(["dept-product"]);
  });

  it("keeps the priority the work had", () => {
    expect(placed().task.priority).toBe("high");
  });

  it("assigns it, so somebody actually picks it up", () => {
    const outcome = placed();
    expect(outcome.assignedTo).toBe("emp-theo");
    expect(outcome.task.status).toBe("assigned");
  });

  it("leaves it in the department's backlog when nobody can take it", () => {
    const outcome = placed([]);
    expect(outcome.assignedTo).toBeNull();
    // Not lost: waiting where whoever runs that department will find it.
    expect(outcome.task.status).toBe("backlog");
  });
});
