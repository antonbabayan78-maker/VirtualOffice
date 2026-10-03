import { describe, expect, it } from "vitest";
import {
  createDepartment,
  createTask,
  unwrap,
  type Department,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type ReviewPolicy,
  type Task,
  type TaskId,
} from "@vo/core";
import { gatesAwaiting, whatIsWaiting } from "./awaiting.js";
import type { HeldCall } from "./workflow-types.js";

const officeId = "office-1" as OfficeId;
const ada = "emp-ada" as EmployeeId;
const t0 = new Date("2026-10-03T09:00:00Z");

const room = (id: string, policy: ReviewPolicy): Department => ({
  ...unwrap(
    createDepartment({ officeId, name: id, color: "#3366ff", position: { x: 0, y: 0 } }, [], {
      id: () => id as DepartmentId,
      now: () => t0,
    }),
  ),
  reviewPolicy: policy,
});

const gate = (...gatedActions: readonly string[]): ReviewPolicy =>
  ({ kind: "gate", gatedActions }) as unknown as ReviewPolicy;

const work = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...unwrap(
    createTask(
      { officeId, departmentId: "dept-post" as DepartmentId, title: `work ${id}`, assigneeId: ada },
      { id: () => id as TaskId, now: () => t0 },
    ),
  ),
  ...overrides,
});

const held = (key: string, name = "post__send_email"): HeldCall => ({
  key,
  name,
  gates: ["external_send"],
  detail: `tool "${name}" (external_send)`,
  input: { to: "customer@acme.test" },
});

const nothingHeld = new Map<string, readonly HeldCall[]>();

describe("what a department holds of this work", () => {
  it("is the overlap: what it gates, and what the work actually involved", () => {
    const task = work("task-1", { gatedActions: ["external_send", "delete"] });

    expect(gatesAwaiting(task, gate("deploy", "external_send"))).toEqual(["external_send"]);
  });

  it("is nothing for a department that reviews another way", () => {
    const task = work("task-1", { gatedActions: ["external_send"] });

    expect(gatesAwaiting(task, { kind: "manager", maxIterations: 3 })).toEqual([]);
  });

  it("is nothing when the work involved none of what it gates", () => {
    expect(gatesAwaiting(work("task-1"), gate("deploy"))).toEqual([]);
  });

  it("keeps the department's own order, which is how it is read out", () => {
    const task = work("task-1", { gatedActions: ["delete", "deploy"] });

    expect(gatesAwaiting(task, gate("deploy", "delete"))).toEqual(["deploy", "delete"]);
  });
});

describe("what an office is waiting on a person for", () => {
  const post = room("dept-post", gate("external_send"));

  it("says nothing about an office where nothing is waiting", () => {
    const busy = [work("task-1", { status: "in_progress" }), work("task-2", { status: "done" })];

    expect(whatIsWaiting(busy, [post], nothingHeld)).toEqual([]);
  });

  it("lists finished work a department holds for a person", () => {
    const task = work("task-1", { status: "in_review", gatedActions: ["external_send"] });

    const waiting = whatIsWaiting([task], [post], nothingHeld);

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "review",
      taskId: "task-1",
      title: "work task-1",
      departmentId: "dept-post",
      assigneeId: ada,
      gates: ["external_send"],
    });
  });

  it("leaves finished work alone when a reviewer is the one deciding", () => {
    const task = work("task-1", { status: "in_review", gatedActions: ["external_send"] });

    expect(
      whatIsWaiting([task], [room("dept-post", { kind: "manager" } as ReviewPolicy)], nothingHeld),
    ).toEqual([]);
  });

  it("leaves finished work alone when the work involved nothing the room holds", () => {
    const task = work("task-1", { status: "in_review" });

    expect(whatIsWaiting([task], [post], nothingHeld)).toEqual([]);
  });

  it("lists a held call, with the arguments that are the thing being decided", () => {
    const task = work("task-1", { status: "blocked" });

    const waiting = whatIsWaiting([task], [post], new Map([["task-1", [held("call-1")]]]));

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "call",
      taskId: "task-1",
      key: "call-1",
      name: "post__send_email",
      input: { to: "customer@acme.test" },
      gates: ["external_send"],
    });
  });

  it("lists every call a run is holding, because each is answered on its own", () => {
    const task = work("task-1", { status: "blocked" });

    const waiting = whatIsWaiting(
      [task],
      [post],
      new Map([["task-1", [held("call-1"), held("call-2", "post__delete_all")]]]),
    );

    expect(waiting.map((one) => one.kind === "call" && one.key)).toEqual(["call-1", "call-2"]);
  });

  it("lists work that stopped for another reason, which is not a decision", () => {
    const task = work("task-1", {
      status: "blocked",
      history: [
        { at: t0, from: "in_progress", to: "blocked", actorId: ada, reason: "waiting on the data" },
      ],
    });

    expect(whatIsWaiting([task], [post], nothingHeld)[0]).toMatchObject({
      kind: "stopped",
      status: "blocked",
      reason: "waiting on the data",
    });
  });

  it("lists work escalated to the owner", () => {
    const task = work("task-1", { status: "escalated" });

    expect(whatIsWaiting([task], [post], nothingHeld)[0]).toMatchObject({
      kind: "stopped",
      status: "escalated",
    });
  });

  it("says nothing of a reason when the office recorded none", () => {
    expect(
      whatIsWaiting([work("task-1", { status: "escalated" })], [post], nothingHeld)[0],
    ).toMatchObject({ reason: null });
  });

  it("puts the oldest first, since that is the one to answer", () => {
    const old = work("task-old", {
      status: "escalated",
      updatedAt: new Date("2026-10-01T09:00:00Z"),
    });
    const recent = work("task-new", {
      status: "escalated",
      updatedAt: new Date("2026-10-03T09:00:00Z"),
    });

    const waiting = whatIsWaiting([recent, old], [post], nothingHeld);

    expect(waiting.map((one) => one.taskId)).toEqual(["task-old", "task-new"]);
  });

  it("says when each one started waiting, which is how long it has been", () => {
    const task = work("task-1", {
      status: "escalated",
      updatedAt: new Date("2026-10-02T11:00:00Z"),
    });

    expect(whatIsWaiting([task], [post], nothingHeld)[0]?.since).toEqual(
      new Date("2026-10-02T11:00:00Z"),
    );
  });

  it("still lists a stopped task whose department has gone", () => {
    // A room can be closed down while its work waits; the work is still there
    // and somebody still has to deal with it.
    const task = work("task-1", { status: "escalated" });

    expect(whatIsWaiting([task], [], nothingHeld)).toHaveLength(1);
  });

  it("cannot hold finished work for a department it cannot read", () => {
    const task = work("task-1", { status: "in_review", gatedActions: ["external_send"] });

    expect(whatIsWaiting([task], [], nothingHeld)).toEqual([]);
  });
});
