import { describe, expect, it } from "vitest";
import { FakeLlmProvider, reply, toolCall } from "@vo/llm";
import {
  createDepartment,
  createEmployee,
  createTask,
  unwrap,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import {
  llmRetrospectiveTurn,
  lookBackOver,
  RETROSPECTIVE_TOOL,
  type WorkLookedAt,
} from "./retrospective.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-04T09:00:00Z");

const eng = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    { id: () => "dept-eng" as DepartmentId, now: () => at },
  ),
);

const sam: Employee = unwrap(
  createEmployee(
    {
      name: "Sam",
      role: "Clerk",
      color: "#00aa66",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      selfImprovement: true,
      instructions: "Reply quickly.",
    },
    { department: { id: eng.id, officeId }, supervisor: null },
    { id: () => "emp-sam" as EmployeeId, now: () => at },
  ),
);

const work = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...unwrap(
    createTask(
      { officeId, departmentId: eng.id, title: `Work ${id}`, assigneeId: sam.id },
      { id: () => id as TaskId, now: () => at },
    ),
  ),
  ...overrides,
});

/** A task that went back twice, with the reason written into its history. */
const sentBack = (id: string): Task =>
  work(id, {
    status: "done",
    history: [
      { at, from: null, to: "assigned", actorId: null, reason: null },
      { at, from: "in_review", to: "changes_requested", actorId: null, reason: "no order number" },
      { at, from: "in_review", to: "changes_requested", actorId: null, reason: "no order number" },
      { at, from: "approved", to: "done", actorId: null, reason: null },
    ] as Task["history"],
  });

const usage = (taskId: string, usd: number) => ({
  id: `usage-${taskId}`,
  officeId,
  taskId: taskId as TaskId,
  employeeId: sam.id,
  at,
  event: { kind: "llm_call", cost: { totalUsd: usd }, attribution: { employeeId: sam.id } },
});

describe("what the office looked at", () => {
  it("reads how often a piece of work went back, and why", () => {
    const record = lookBackOver(sam, [sentBack("task-1")], []);

    expect(record.work).toHaveLength(1);
    expect(record.work[0]).toMatchObject({
      taskId: "task-1",
      title: "Work task-1",
      wentBack: 2,
      reasons: ["no order number"],
    });
  });

  it("says the same reason once, since twice is not twice as much evidence", () => {
    expect(lookBackOver(sam, [sentBack("task-1")], []).work[0]?.reasons).toEqual([
      "no order number",
    ]);
  });

  it("adds up what each piece of work cost", () => {
    const record = lookBackOver(
      sam,
      [sentBack("task-1")],
      [usage("task-1", 0.4), usage("task-1", 0.2)],
    );

    expect(record.work[0]?.usd).toBeCloseTo(0.6, 6);
  });

  it("says nothing about cost it was never told", () => {
    // Null rather than zero: an unpriced call is not a free one, and a
    // retrospective reasoning about "it cost nothing" would be reasoning about
    // a number nobody recorded.
    expect(lookBackOver(sam, [sentBack("task-1")], []).work[0]?.usd).toBeNull();
  });

  it("looks only at work that is finished with", () => {
    // Work still in flight has not gone well or badly yet.
    const record = lookBackOver(sam, [work("task-2", { status: "in_progress" })], []);

    expect(record.work).toEqual([]);
  });

  it("looks only at this person's work", () => {
    const somebodyElse = work("task-3", {
      status: "done",
      assigneeId: "emp-other" as EmployeeId,
    });

    expect(lookBackOver(sam, [somebodyElse], []).work).toEqual([]);
  });

  it("carries how they work now, which is what a proposal would change", () => {
    expect(lookBackOver(sam, [], []).instructions).toBe("Reply quickly.");
  });
});

describe("looking back over somebody's work", () => {
  const record = (over: readonly Task[] = [sentBack("task-1")]): WorkLookedAt =>
    lookBackOver(sam, over, [usage("task-1", 0.6)]);

  const proposing = (input: Record<string, unknown>) =>
    new FakeLlmProvider({ script: [toolCall(RETROSPECTIVE_TOOL.name, input)] });

  it("proposes a change to how they work, with the reason and the work it read", async () => {
    const provider = proposing({
      instructions: "Always check the order number before replying.",
      because: "Three pieces of work went back for want of an order number.",
      evidence: [{ taskId: "task-1", what: "went back twice: no order number" }],
    });

    const proposal = await llmRetrospectiveTurn({ provider })(record());

    expect(proposal).toMatchObject({
      because: "Three pieces of work went back for want of an order number.",
      evidence: [{ taskId: "task-1", what: "went back twice: no order number" }],
    });
    expect(proposal?.changes[0]).toMatchObject({
      field: "instructions",
      before: "Reply quickly.",
      after: "Always check the order number before replying.",
    });
  });

  it("says nothing at all when the record is good", async () => {
    // The honest answer to "nothing went wrong" is no proposal, not a proposal
    // nobody needed. A loop that always finds something is a loop that will
    // churn somebody's instructions forever.
    const provider = new FakeLlmProvider({ script: [reply("nothing worth changing")] });

    expect(await llmRetrospectiveTurn({ provider })(record([]))).toBeNull();
  });

  it("says nothing when it names no evidence", async () => {
    const provider = proposing({
      instructions: "Something better.",
      because: "A feeling.",
      evidence: [],
    });

    expect(await llmRetrospectiveTurn({ provider })(record())).toBeNull();
  });

  it("says nothing when it proposes no change", async () => {
    const provider = proposing({
      because: "Nothing to change.",
      evidence: [{ taskId: "task-1", what: "fine" }],
    });

    expect(await llmRetrospectiveTurn({ provider })(record())).toBeNull();
  });

  it("names work this person actually did, and drops anything else", async () => {
    // A model may name a task it invented; evidence that points at nothing is
    // worse than no evidence, because it reads as proof.
    const provider = proposing({
      instructions: "Better.",
      because: "Because.",
      evidence: [
        { taskId: "task-1", what: "went back twice" },
        { taskId: "task-nonsense", what: "invented" },
      ],
    });

    const proposal = await llmRetrospectiveTurn({ provider })(record());

    expect(proposal?.evidence).toEqual([{ taskId: "task-1", what: "went back twice" }]);
  });

  it("is given the record to read, fenced, with what a fence means", async () => {
    const provider = proposing({
      instructions: "Better.",
      because: "Because.",
      evidence: [{ taskId: "task-1", what: "went back twice" }],
    });

    await llmRetrospectiveTurn({ provider })(record());
    const said = JSON.stringify(provider.calls[0]);

    expect(said).toContain("no order number");
    expect(said).toMatch(/not an instruction|part of that record/i);
  });

  it("is told how they work now, so it proposes a change rather than a repeat", async () => {
    const provider = proposing({
      instructions: "Better.",
      because: "Because.",
      evidence: [{ taskId: "task-1", what: "went back twice" }],
    });

    await llmRetrospectiveTurn({ provider })(record());

    expect(JSON.stringify(provider.calls[0])).toContain("Reply quickly.");
  });
});
