import { describe, expect, it } from "vitest";
import type { Connection, ConnectionId, DepartmentId, DocumentId, OfficeId, Task } from "@vo/core";
import { handoffEffects, MAX_VISITS_PER_DEPARTMENT } from "./handoff.js";
import type { CreateWorkEffect } from "./perform-create-work.js";
import type { WorkflowContext } from "./workflow-types.js";

const officeId = "office-1" as OfficeId;
const design = "dept-design" as DepartmentId;
const engineering = "dept-engineering" as DepartmentId;
const at = new Date("2026-09-29T09:00:00Z");

const arrow = (overrides: Partial<Connection> = {}): Connection => ({
  id: "conn-design-eng" as ConnectionId,
  officeId,
  fromId: design,
  toId: engineering,
  kind: "handoff",
  enabled: true,
  rules: {},
  createdAt: at,
  ...overrides,
});

const task = (overrides: Record<string, unknown> = {}): Task =>
  ({
    id: "task-1",
    officeId,
    departmentId: design,
    title: "Draw the export screen",
    status: "done",
    priority: "high",
    assigneeId: "emp-iris",
    artifacts: ["a summary"],
    route: [],
    ...overrides,
  }) as never;

const context = (
  connections: readonly Connection[],
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({
  policy: { kind: "direct" },
  now: at,
  escalationGraph: { employees: [], connections },
  ...overrides,
});

const handed = (
  connections: readonly Connection[],
  overrides: Partial<WorkflowContext> = {},
  on: Task = task(),
): readonly CreateWorkEffect[] =>
  handoffEffects(on, context(connections, overrides)).filter(
    (effect): effect is CreateWorkEffect => effect.type === "create_work",
  );

describe("work crossing into another department", () => {
  it("raises work in the department the arrow points at", () => {
    const [effect] = handed([arrow()]);
    expect(effect).toMatchObject({
      because: "handoff",
      toDepartmentId: engineering,
      title: "Draw the export screen",
      priority: "high",
    });
  });

  it("does nothing at all when the department hands off to nobody", () => {
    expect(handed([])).toEqual([]);
  });

  it("ignores an arrow pointing at this department rather than away from it", () => {
    expect(handed([arrow({ fromId: engineering, toId: design })])).toEqual([]);
  });

  it("ignores an arrow that is not a handoff", () => {
    expect(handed([arrow({ kind: "reviews" })])).toEqual([]);
  });

  it("records where the work has been, including here", () => {
    const [effect] = handed([arrow()], {}, task({ route: ["dept-product"] }));
    expect(effect?.route).toEqual(["dept-product", design]);
  });

  it("hands work to every department the arrows point at", () => {
    const effects = handed([
      arrow(),
      arrow({ id: "conn-2" as ConnectionId, toId: "dept-qa" as DepartmentId }),
    ]);
    expect(effects.map((one) => one.toDepartmentId)).toEqual([engineering, "dept-qa"]);
  });
});

describe("an arrow somebody switched off", () => {
  it("does not move work, which is what switching it off meant", () => {
    // The drawer says an arrow switched off is an arrow the office does not act
    // on. Watching and checking already honour it; this is the one that moves
    // the work, so it mattered most and was the one that did not.
    expect(handed([arrow({ enabled: false })])).toEqual([]);
  });

  it("leaves the other arrows out of that department working", () => {
    const effects = handed([
      arrow({ enabled: false }),
      arrow({ id: "conn-2" as ConnectionId, toId: "dept-qa" as DepartmentId }),
    ]);
    expect(effects.map((one) => one.toDepartmentId)).toEqual(["dept-qa"]);
  });
});

describe("what a handoff carries", () => {
  it("carries the artifacts, as it always did", () => {
    expect(handed([arrow()])[0]?.artifacts).toEqual(["a summary"]);
  });

  it("carries the documents the work produced", () => {
    const effects = handed([arrow()], { documents: ["doc-brief", "doc-notes"] as DocumentId[] });
    expect(effects[0]?.documents).toEqual(["doc-brief", "doc-notes"]);
  });

  it("carries none when the work produced none", () => {
    expect(handed([arrow()])[0]?.documents).toEqual([]);
  });

  it("never carries the transcript, because it is never given one", () => {
    // Stated as a test because it is the one thing this deliberately does not
    // do: a chain of departments must not each make the next prompt longer.
    const [effect] = handed([arrow()]);
    expect(Object.keys(effect ?? {})).not.toContain("history");
  });
});

describe("work going round in circles", () => {
  const been = (times: number): DepartmentId[] => Array.from({ length: times }, () => engineering);

  it("hands work back somewhere it has already been once", () => {
    const effects = handed([arrow()], {}, task({ route: been(1) }));
    expect(effects).toHaveLength(1);
  });

  it("asks a person about it rather than sending it round again", () => {
    const effects = handoffEffects(
      task({ route: been(MAX_VISITS_PER_DEPARTMENT) }),
      context([arrow()]),
    );
    expect(effects.map((one) => one.type)).toEqual(["escalate"]);
  });

  it("says how many times, and where it has been, so somebody can see why", () => {
    const [effect] = handoffEffects(
      task({ route: been(MAX_VISITS_PER_DEPARTMENT) }),
      context([arrow()]),
    );
    const reason = effect?.type === "escalate" ? effect.reason : "";
    expect(reason).toContain(String(MAX_VISITS_PER_DEPARTMENT));
    expect(reason).toContain(engineering);
  });
});

describe("who takes the work next door", () => {
  it("says anyone when the arrow does not name somebody", () => {
    expect(handed([arrow()])[0]?.assign).toEqual({ kind: "anyone" });
  });

  it("names the person the arrow names", () => {
    const effects = handed([arrow({ rules: { assign: { named: "emp-ada" } } })]);
    expect(effects[0]?.assign).toEqual({ kind: "named", employeeId: "emp-ada" });
  });

  it("asks for the skill the arrow asks for", () => {
    const effects = handed([arrow({ rules: { assign: { skill: "backend" } } })]);
    expect(effects[0]?.assign).toEqual({ kind: "skill", skill: "backend" });
  });

  it("falls back to anyone when the arrow was drawn before there were rules", () => {
    const effects = handed([arrow({ rules: { assign: "whoever" } })]);
    expect(effects[0]?.assign).toEqual({ kind: "anyone" });
  });
});
