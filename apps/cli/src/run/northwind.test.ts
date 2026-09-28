/**
 * The reference office, end to end.
 *
 * Northwind Studio is the office that ships as a template, so this test runs
 * the file itself rather than a copy: four departments, nine people, four
 * different ideas of what "reviewed" means, and a person holding the last door.
 *
 * It is the whole engine under one test — schedule, queue, agent turn, four
 * review policies, escalation graph and metering — which is a different thing
 * from the policy tests. Those prove each policy is right on its own; this
 * proves an office made of all of them gets work out of the door.
 *
 * No model is called: the provider is scripted, and it answers by reading who
 * is speaking out of the system prompt, exactly as a real one would be told.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, systemText, toolCall, type CompletionRequest } from "@vo/llm";
import {
  createTask,
  importOfficeYaml,
  unwrap,
  type EmployeeId,
  type OfficeConfig,
  type Task,
  type TaskId,
} from "@vo/core";
import { runOffice, type GateDecider, type OfficeRunResult } from "./office-run.js";

const YAML = readFileSync(
  new URL("../../../../examples/northwind-studio.yaml", import.meta.url),
  "utf8",
);
const at = new Date("2026-09-28T09:00:00.000Z");
const config: OfficeConfig = unwrap(
  importOfficeYaml(YAML, { id: () => "generated", now: () => at }),
);

const person = (name: string): EmployeeId => {
  const found = config.employees.find((employee) => employee.name === name);
  if (found === undefined) throw new Error(`no ${name} in the office`);
  return found.id;
};
const departmentOf = (id: EmployeeId): string =>
  config.employees.find((employee) => employee.id === id)?.departmentId ?? "";

function brief(id: string, title: string, assignee: string, gated: string[] = []): Task {
  const assigneeId = person(assignee);
  const base = unwrap(
    createTask(
      {
        officeId: config.office.id,
        departmentId: departmentOf(assigneeId) as never,
        title,
        assigneeId,
      },
      { id: () => id as TaskId, now: () => at },
    ),
  );
  return gated.length === 0 ? base : { ...base, gatedActions: gated as never };
}

const TASKS: readonly Task[] = [
  brief("task-scope", "Scope the 4.2 release", "Ravi"),
  brief("task-screen", "Draw the export screen", "Theo"),
  brief("task-endpoint", "Build the export endpoint", "Ada"),
  brief("task-ship", "Ship release 4.2", "Nadia", ["deploy"]),
];

const isReview = (request: CompletionRequest): boolean =>
  (request.tools ?? []).some((tool) => tool.name === "review_verdict");
/** Who the office told the model it is. */
const speaker = (request: CompletionRequest): string =>
  /You are (\w+),/.exec(systemText(request.system))?.[1] ?? "";
const about = (request: CompletionRequest): string =>
  /Task: (.+)/.exec(systemText(request.system))?.[1]?.trim() ?? "";

/**
 * A studio that works like one: the first scoping is sent back, everything else
 * passes, and nothing is approved that was not asked about.
 */
function studio(): FakeLlmProvider {
  let scopeReviews = 0;
  return new FakeLlmProvider({
    id: "anthropic",
    handler: (request) => {
      if (!isReview(request)) {
        return toolCall("submit_work", { summary: `${speaker(request)}: ${about(request)}` });
      }
      if (about(request) === "Scope the 4.2 release") {
        scopeReviews += 1;
        if (scopeReviews === 1) {
          return toolCall("review_verdict", {
            approved: false,
            reason: "no success measure on the release",
          });
        }
      }
      return toolCall("review_verdict", { approved: true });
    },
  });
}

async function run(decide: GateDecider): Promise<OfficeRunResult> {
  return runOffice({ config, tasks: TASKS, provider: studio(), decide, maxTicks: 60 });
}

const approveEverything = () => ({ decision: "approved" as const, decidedBy: "anton" });

describe("Northwind Studio, as configured", () => {
  it("is four departments of one to four people", () => {
    expect(config.departments).toHaveLength(4);
    expect(config.employees).toHaveLength(9);
    for (const department of config.departments) {
      const staff = config.employees.filter((e) => e.departmentId === department.id);
      expect(staff.length).toBeGreaterThanOrEqual(1);
      expect(staff.length).toBeLessThanOrEqual(4);
    }
  });

  it("puts somebody in charge of every department", () => {
    for (const department of config.departments) {
      const staff = config.employees.filter((e) => e.departmentId === department.id);
      const leads = staff.filter((e) => e.supervisorId === null);
      expect(leads).toHaveLength(1);
      // Everyone else in the department answers to that person.
      for (const other of staff.filter((e) => e.supervisorId !== null)) {
        expect(other.supervisorId).toBe(leads[0]?.id);
      }
    }
  });

  it("reviews each kind of work in the way that kind of work deserves", () => {
    const policy = (name: string): string =>
      config.departments.find((d) => d.name === name)?.reviewPolicy.kind ?? "";
    expect(policy("Product")).toBe("manager");
    expect(policy("Design")).toBe("manager");
    expect(policy("Engineering")).toBe("peer");
    expect(policy("Operations")).toBe("gate");
  });

  it("wires the departments up the way work actually travels", () => {
    const handoffs = config.connections
      .filter((c) => c.kind === "handoff")
      .map((c) => `${c.fromId}->${c.toId}`);
    expect(handoffs).toEqual([
      "dept-product->dept-design",
      "dept-design->dept-engineering",
      "dept-engineering->dept-operations",
    ]);
    expect(config.connections.some((c) => c.kind === "escalates_to")).toBe(true);
  });
});

describe("a day at Northwind Studio", () => {
  it("gets every piece of work out of the door", async () => {
    const result = await run(approveEverything);
    expect(result.tasks.map((task) => task.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("sends the scoping back once, and approves it on the second pass", async () => {
    const result = await run(approveEverything);
    const scope = result.tasks.find((task) => task.id === "task-scope");
    const statuses = (scope?.history ?? []).map((event) => event.to);

    expect(statuses).toContain("changes_requested");
    // Back round the loop: in review a second time, and then through.
    expect(statuses.filter((status) => status === "in_review")).toHaveLength(2);
    expect(scope?.status).toBe("done");
  });

  it("has the manager review the work of the person who reports to them", async () => {
    const result = await run(approveEverything);
    const scope = result.tasks.find((task) => task.id === "task-scope");
    const approval = (scope?.history ?? []).find((event) => event.to === "approved");

    expect(approval?.actorId).toBe(person("Vera"));
  });

  it("has an engineer's work reviewed by another engineer, never by themselves", async () => {
    const result = await run(approveEverything);
    const endpoint = result.tasks.find((task) => task.id === "task-endpoint");
    const approval = (endpoint?.history ?? []).find((event) => event.to === "approved");
    const reviewer = config.employees.find((e) => e.id === approval?.actorId);

    expect(reviewer?.departmentId).toBe("dept-engineering");
    expect(reviewer?.id).not.toBe(person("Ada"));
  });

  it("does not let a department review another department's work", async () => {
    const result = await run(approveEverything);
    for (const task of result.tasks) {
      for (const event of task.history) {
        if (event.actorId === null) continue;
        expect(departmentOf(event.actorId)).toBe(task.departmentId);
      }
    }
  });

  it("holds the release until a person says so, and names who said it", async () => {
    const result = await run(approveEverything);
    const ship = result.tasks.find((task) => task.id === "task-ship");
    const approval = (ship?.history ?? []).find((event) => event.to === "approved");

    // No employee approved this one: a person did.
    expect(approval?.actorId).toBeNull();
    expect(approval?.reason).toContain("anton");
    expect(result.effects.some((effect) => effect.type === "request_approval")).toBe(true);
  });

  it("ships nothing when nobody is at the desk to approve it", async () => {
    const result = await run(() => null);
    const ship = result.tasks.find((task) => task.id === "task-ship");

    expect(ship?.status).toBe("in_review");
    // The rest of the studio carries on regardless.
    expect(result.done).toBe(3);
  });

  it("bills every call to the person who made it and the department they sit in", async () => {
    const result = await run(approveEverything);
    expect(result.usage.length).toBeGreaterThan(0);
    for (const event of result.usage) {
      const employee = config.employees.find((e) => e.id === event.attribution.employeeId);
      expect(employee).toBeDefined();
      expect(event.attribution.departmentId).toBe(employee?.departmentId);
      expect(event.attribution.taskId).toBeDefined();
    }
  });

  it("charges each department for its own work, so a cost per department is real", async () => {
    const result = await run(approveEverything);
    const departments = new Set(result.usage.map((event) => event.attribution.departmentId));
    expect(departments).toEqual(
      new Set(["dept-product", "dept-design", "dept-engineering", "dept-operations"]),
    );
  });

  it("charges the models the office actually configured, not one default", async () => {
    const result = await run(approveEverything);
    const models = new Set(
      result.usage.flatMap((event) => (event.kind === "llm_call" ? [event.model] : [])),
    );
    expect(models.has("claude-opus-5")).toBe(true);
    expect(models.has("claude-sonnet-5")).toBe(true);
  });

  it("settles rather than running until it is stopped", async () => {
    const result = await run(approveEverything);
    expect(result.ticks).toBeLessThan(60);
  });
});
