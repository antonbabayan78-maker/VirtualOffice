import { describe, expect, it } from "vitest";
import { FakeLlmProvider, reply, toolCall, type CompletionRequest } from "@vo/llm";
import { createTask, importOfficeYaml, unwrap, type Task, type TaskId } from "@vo/core";
import { runOffice } from "./office-run.js";

/** Two employees: Ada writes, Boss reviews. The department reviews by manager. */
const OFFICE_YAML = `
version: 1
office:
  id: office-acme
  name: Acme
departments:
  - id: dept-eng
    name: Engineering
    color: "#3366ff"
    position: { x: 0, y: 0 }
    reviewPolicy: { kind: manager, maxIterations: 3 }
employees:
  - id: emp-boss
    department: dept-eng
    name: Boss
    role: Engineering manager
    color: "#ff8800"
    llm: { provider: anthropic, model: claude-sonnet-5 }
  - id: emp-ada
    department: dept-eng
    name: Ada
    role: Engineer
    color: "#00aa66"
    supervisor: emp-boss
    llm: { provider: anthropic, model: claude-sonnet-5 }
`;

const deps = { id: () => "generated", now: () => new Date("2026-09-28T09:00:00.000Z") };

function office() {
  return unwrap(importOfficeYaml(OFFICE_YAML, deps));
}

function brief(): Task {
  return unwrap(
    createTask(
      {
        officeId: office().office.id,
        departmentId: office().departments[0]?.id ?? ("dept-eng" as never),
        title: "Write the parser",
        assigneeId: office().employees.find((e) => e.name === "Ada")?.id ?? ("emp-ada" as never),
      },
      { id: () => "task-1" as TaskId, now: () => new Date("2026-09-28T09:00:00.000Z") },
    ),
  );
}

const isReview = (request: CompletionRequest): boolean =>
  (request.tools ?? []).some((tool) => tool.name === "review_verdict");

/** Ada submits; Boss approves. */
const agreeable = () =>
  new FakeLlmProvider({
    id: "anthropic",
    handler: (request) =>
      isReview(request)
        ? toolCall("review_verdict", { approved: true, reason: "reads well" })
        : toolCall("submit_work", { summary: "parser written" }),
  });

describe("runOffice", () => {
  it("carries a task from assigned to done through a manager review", async () => {
    const result = await runOffice({ config: office(), tasks: [brief()], provider: agreeable() });

    const task = result.tasks[0];
    expect(task?.status).toBe("done");
    expect(task?.history.map((h) => h.to)).toEqual([
      "assigned",
      "in_progress",
      "in_review",
      "approved",
      "done",
    ]);
    expect(result.done).toBe(1);
  });

  it("gives the work to Ada and the review to her manager", async () => {
    const result = await runOffice({ config: office(), tasks: [brief()], provider: agreeable() });
    const task = result.tasks[0];
    expect(task?.assigneeId).toBe("emp-ada");
    // The manager policy picked the supervisor named in the office file.
    expect(task?.history.find((h) => h.to === "approved")?.actorId).toBe("emp-boss");
  });

  it("meters every call, attributed to the employee who made it", async () => {
    const result = await runOffice({ config: office(), tasks: [brief()], provider: agreeable() });

    expect(result.usage.length).toBeGreaterThanOrEqual(2);
    const employees = new Set(result.usage.map((event) => event.attribution.employeeId));
    expect(employees).toEqual(new Set(["emp-ada", "emp-boss"]));
    for (const event of result.usage) {
      expect(event.attribution.officeId).toBe("office-acme");
      expect(event.attribution.taskId).toBe("task-1");
      if (event.kind === "llm_call") expect(event.cost?.totalUsd).toBeGreaterThan(0);
    }
  });

  it("sends the work back when the manager asks for changes, then finishes it", async () => {
    let reviews = 0;
    const fussy = new FakeLlmProvider({
      id: "anthropic",
      handler: (request) => {
        if (!isReview(request)) return toolCall("submit_work", { summary: "a draft" });
        reviews += 1;
        return reviews === 1
          ? toolCall("review_verdict", { approved: false, reason: "no tests" })
          : toolCall("review_verdict", { approved: true, reason: "better" });
      },
    });

    const result = await runOffice({ config: office(), tasks: [brief()], provider: fussy });
    const task = result.tasks[0];
    expect(task?.status).toBe("done");
    expect(task?.history.filter((h) => h.to === "changes_requested")).toHaveLength(1);
    expect(task?.history.find((h) => h.to === "changes_requested")?.reason).toBe("no tests");
    expect(reviews).toBe(2);
  });

  it("escalates instead of looping when the manager never approves", async () => {
    const never = new FakeLlmProvider({
      id: "anthropic",
      handler: (request) =>
        isReview(request)
          ? toolCall("review_verdict", { approved: false, reason: "still no" })
          : toolCall("submit_work", { summary: "a draft" }),
    });

    const result = await runOffice({ config: office(), tasks: [brief()], provider: never });
    expect(result.tasks[0]?.status).toBe("escalated");
    expect(result.effects.some((e) => e.type === "escalate")).toBe(true);
  });

  it("stops when the office has nothing left to do", async () => {
    const result = await runOffice({ config: office(), tasks: [brief()], provider: agreeable() });
    // Far fewer than the cap: the run ends because the office went quiet.
    expect(result.ticks).toBeLessThan(10);
  });

  it("does nothing at all for an office with no work", async () => {
    const provider = agreeable();
    const result = await runOffice({ config: office(), tasks: [], provider });
    expect(result.ticks).toBe(1);
    expect(result.usage).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("leaves work alone while its department is outside working hours", async () => {
    const closed = importOfficeYaml(
      OFFICE_YAML.replace(
        "    reviewPolicy: { kind: manager, maxIterations: 3 }",
        `    reviewPolicy: { kind: manager, maxIterations: 3 }
    schedule:
      kind: windows
      timezone: UTC
      windows:
        - days: [mon]
          start: "09:00"
          end: "17:00"`,
      ),
      deps,
    );
    const provider = agreeable();
    // A Sunday.
    const result = await runOffice({
      config: unwrap(closed),
      tasks: [brief()],
      provider,
      now: () => new Date("2026-09-27T10:00:00.000Z"),
    });
    expect(result.tasks[0]?.status).toBe("assigned");
    expect(provider.calls).toHaveLength(0);
  });

  it("gives up rather than running forever if the office never settles", async () => {
    const chatty = new FakeLlmProvider({ id: "anthropic", handler: () => reply("thinking") });
    const result = await runOffice({
      config: office(),
      tasks: [brief()],
      provider: chatty,
      maxTicks: 3,
    });
    expect(result.ticks).toBe(3);
    expect(result.tasks[0]?.status).not.toBe("done");
  });
});
