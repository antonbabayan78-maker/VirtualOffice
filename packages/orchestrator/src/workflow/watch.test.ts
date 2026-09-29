import { describe, expect, it } from "vitest";
import type {
  Connection,
  ConnectionId,
  DepartmentId,
  DocumentId,
  OfficeId,
  TaskStatus,
} from "@vo/core";
import { momentOf, watchEffects } from "./watch.js";
import type { WorkflowContext, WorkflowEffect } from "./workflow-types.js";

const officeId = "office-1" as OfficeId;
const engineering = "dept-engineering" as DepartmentId;
const operations = "dept-operations" as DepartmentId;
const at = new Date("2026-09-29T09:00:00Z");

const watcher = (
  rules: Record<string, unknown>,
  overrides: Partial<Connection> = {},
): Connection => ({
  id: "conn-watch" as ConnectionId,
  officeId,
  fromId: operations,
  toId: engineering,
  kind: "watches",
  enabled: true,
  rules,
  createdAt: at,
  ...overrides,
});

const context = (connections: readonly Connection[]): WorkflowContext => ({
  policy: { kind: "direct" },
  now: at,
  escalationGraph: { employees: [], connections },
});

const task = (status: TaskStatus, overrides: Record<string, unknown> = {}) =>
  ({
    id: "task-1",
    officeId,
    departmentId: engineering,
    title: "Build the export endpoint",
    status,
    priority: "normal",
    artifacts: [],
    route: [],
    ...overrides,
  }) as never;

const fired = (
  from: TaskStatus,
  to: TaskStatus,
  connections: readonly Connection[],
  effects: readonly WorkflowEffect[] = [],
) => watchEffects(task(from), task(to), effects, context(connections));

describe("recognising the moment a task just passed through", () => {
  it("knows work starting", () => {
    expect(momentOf(task("assigned"), task("in_progress"), [])).toBe("work_started");
  });

  it("knows work finishing", () => {
    expect(momentOf(task("in_review"), task("done"), [])).toBe("work_finished");
  });

  it("knows work going wrong, whether it stalled or was sent upward", () => {
    expect(momentOf(task("in_progress"), task("blocked"), [])).toBe("work_went_wrong");
    expect(momentOf(task("in_review"), task("escalated"), [])).toBe("work_went_wrong");
  });

  it("knows a person being asked to decide", () => {
    const asked: WorkflowEffect[] = [
      { type: "request_approval", gates: ["deploy"], summary: "needs a decision" },
    ];
    expect(momentOf(task("in_progress"), task("in_review"), asked)).toBe("decision_wanted");
  });

  it("knows an ordinary move is not a moment at all", () => {
    expect(momentOf(task("assigned"), task("in_review"), [])).toBeNull();
  });

  it("does not call standing still a moment", () => {
    expect(momentOf(task("in_progress"), task("in_progress"), [])).toBeNull();
  });
});

describe("a department watching another", () => {
  const raised = (effects: readonly WorkflowEffect[]) =>
    effects.filter((effect) => effect.type === "create_work");

  it("raises work when the moment it watches for happens", () => {
    const effects = fired("in_review", "done", [watcher({ for: ["work_finished"] })]);
    expect(raised(effects)).toHaveLength(1);
  });

  it("raises it in the watching department, not the watched one", () => {
    const [effect] = raised(fired("in_review", "done", [watcher({ for: ["work_finished"] })]));
    expect(effect).toMatchObject({ toDepartmentId: operations });
  });

  it("says it was raised by watching, not handed on", () => {
    const [effect] = raised(fired("in_review", "done", [watcher({ for: ["work_finished"] })]));
    expect(effect).toMatchObject({ because: "watching" });
  });

  it("stays quiet at a moment it was not pointed at", () => {
    expect(raised(fired("assigned", "in_progress", [watcher({ for: ["work_finished"] })]))).toEqual(
      [],
    );
  });

  it("stays quiet about a department it is not watching", () => {
    const elsewhere = watcher(
      { for: ["work_finished"] },
      {
        toId: "dept-design" as DepartmentId,
      },
    );
    expect(raised(fired("in_review", "done", [elsewhere]))).toEqual([]);
  });

  it("stays quiet when the arrow is switched off", () => {
    const off = watcher({ for: ["work_finished"] }, { enabled: false });
    expect(raised(fired("in_review", "done", [off]))).toEqual([]);
  });

  it("stays quiet when the arrow points the other way", () => {
    const backwards = watcher(
      { for: ["work_finished"] },
      {
        fromId: engineering,
        toId: operations,
      },
    );
    expect(raised(fired("in_review", "done", [backwards]))).toEqual([]);
  });

  it("stays quiet when the arrow is not a watching one", () => {
    const handoff = watcher({ for: ["work_finished"] }, { kind: "handoff" });
    expect(raised(fired("in_review", "done", [handoff]))).toEqual([]);
  });

  it("says in the brief what it noticed, since nobody asked for this work", () => {
    const [effect] = raised(fired("in_review", "done", [watcher({ for: ["work_finished"] })]));
    if (effect?.type === "create_work") {
      expect(effect.brief).toContain("Build the export endpoint");
      expect(effect.title).toMatch(/finished|done/i);
    }
  });

  it("carries what the connection said about who should take it", () => {
    const pointed = watcher({ for: ["work_finished"], assign: { skill: "legal" } });
    const [effect] = raised(fired("in_review", "done", [pointed]));
    expect(effect).toMatchObject({ assign: { kind: "skill", skill: "legal" } });
  });

  it("does not carry the work itself across, since this is separate work", () => {
    // A watcher is not handed the artifacts; it is told something happened.
    const [effect] = raised(fired("in_review", "done", [watcher({ for: ["work_finished"] })]));
    expect(effect).toMatchObject({ artifacts: [] });
  });

  it("does not carry the documents either, however many the work produced", () => {
    // The same rule as the artifacts, and it needs saying separately: a handoff
    // carries documents now, and a watcher reading the same context must not.
    const context: WorkflowContext = {
      policy: { kind: "direct" },
      now: at,
      documents: ["doc-brief" as DocumentId],
      escalationGraph: { employees: [], connections: [watcher({ for: ["work_finished"] })] },
    };
    const [effect] = raised(watchEffects(task("in_review"), task("done"), [], context));

    expect(effect).toMatchObject({ documents: [] });
  });

  it("lets several departments watch the same thing", () => {
    const legal = watcher(
      { for: ["work_finished"] },
      {
        id: "conn-legal" as ConnectionId,
        fromId: "dept-legal" as DepartmentId,
      },
    );
    expect(
      raised(fired("in_review", "done", [watcher({ for: ["work_finished"] }), legal])),
    ).toHaveLength(2);
  });

  it("raises nothing at all in an office that has drawn no watching arrows", () => {
    expect(fired("in_review", "done", [])).toEqual([]);
  });
});
