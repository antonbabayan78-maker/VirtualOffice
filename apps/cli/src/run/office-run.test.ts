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

/** A department that will not let a deploy through without a person saying so. */
const GATED_YAML = `
version: 1
office:
  id: office-acme
  name: Acme
departments:
  - id: dept-ops
    name: Operations
    color: "#aa3366"
    position: { x: 0, y: 0 }
    reviewPolicy: { kind: gate, gatedActions: [deploy] }
employees:
  - id: emp-nadia
    department: dept-ops
    name: Nadia
    role: Operations engineer
    color: "#aa3366"
    llm: { provider: anthropic, model: claude-sonnet-5 }
`;

function gatedOffice() {
  return unwrap(importOfficeYaml(GATED_YAML, deps));
}

function deployTask(): Task {
  const config = gatedOffice();
  const base = unwrap(
    createTask(
      {
        officeId: config.office.id,
        departmentId: config.departments[0]?.id ?? ("dept-ops" as never),
        title: "Ship release 4.2",
        assigneeId: config.employees[0]?.id ?? ("emp-nadia" as never),
      },
      { id: () => "task-deploy" as TaskId, now: () => new Date("2026-09-28T09:00:00.000Z") },
    ),
  );
  // The work involves a deploy, which is what this department gates.
  return { ...base, gatedActions: ["deploy"] };
}

describe("work that needs a person", () => {
  it("stops and waits rather than shipping on the agent's word", async () => {
    const result = await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
    });

    expect(result.tasks[0]?.status).toBe("in_review");
    expect(result.done).toBe(0);
    expect(result.effects.some((effect) => effect.type === "request_approval")).toBe(true);
  });

  it("asks the owner about the task, and about what actually needs deciding", async () => {
    const asked: { title: string; gates: readonly string[] }[] = [];
    await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
      decide: (request) => {
        asked.push({ title: request.task.title, gates: request.gates });
        return null;
      },
    });

    expect(asked[0]).toEqual({ title: "Ship release 4.2", gates: ["deploy"] });
  });

  it("finishes the work once the owner approves it", async () => {
    const result = await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
      decide: () => ({ decision: "approved", decidedBy: "anton" }),
    });

    expect(result.tasks[0]?.status).toBe("done");
    expect(result.done).toBe(1);
  });

  it("records who approved it, so the audit log names a person", async () => {
    const result = await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
      decide: () => ({ decision: "approved", decidedBy: "anton" }),
    });

    const reasons = (result.tasks[0]?.history ?? []).map((event) => event.reason);
    expect(reasons.some((reason) => (reason ?? "").includes("anton"))).toBe(true);
  });

  it("sends the work back when the owner says no", async () => {
    let answers = 0;
    const result = await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
      // Refused once, then allowed: the work has to come back round.
      decide: () => {
        answers += 1;
        return answers === 1
          ? { decision: "rejected", decidedBy: "anton", reason: "not on a Friday" }
          : { decision: "approved", decidedBy: "anton" };
      },
    });

    expect(answers).toBe(2);
    expect(result.tasks[0]?.status).toBe("done");
  });

  it("stops asking when the owner is not answering, rather than looping", async () => {
    const result = await runOffice({
      config: gatedOffice(),
      tasks: [deployTask()],
      provider: agreeable(),
      decide: () => null,
      maxTicks: 10,
    });

    expect(result.tasks[0]?.status).toBe("in_review");
    expect(result.ticks).toBeLessThanOrEqual(10);
  });
});
