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
import { HANDED_OVER_PREFIX } from "@vo/orchestrator";
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
/** What the office told this agent the work has to achieve. */
const criteriaAsked = (request: CompletionRequest): readonly string[] => {
  const said = systemText(request.system);
  const at = said.indexOf("This work is done when:");
  if (at === -1) return [];
  return (said.slice(at + "This work is done when:".length).split("\n")[0] ?? "")
    .split("|")
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);
};

function studio(): FakeLlmProvider {
  let scopeReviews = 0;
  return new FakeLlmProvider({
    id: "anthropic",
    handler: (request) => {
      if (!isReview(request)) {
        return toolCall("submit_work", {
          summary: `${speaker(request)}: ${about(request)}`,
          met: criteriaAsked(request),
        });
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
      return toolCall("review_verdict", { approved: true, met: criteriaAsked(request) });
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
    // Every task, including the ones the studio made for itself by handing work
    // on — a count would have to be updated every time the wiring changed.
    expect(result.tasks.every((task) => task.status === "done")).toBe(true);
    expect(result.handoffProblems).toEqual([]);
  });

  it("makes more work than it was given, by handing it on", async () => {
    const result = await run(approveEverything);
    expect(result.tasks.length).toBeGreaterThan(TASKS.length);
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
    // The first approval is the department's own review. Operations checks it
    // afterwards, which is a different thing and asserted separately.
    const approval = (endpoint?.history ?? []).find((event) => event.to === "approved");
    const reviewer = config.employees.find((e) => e.id === approval?.actorId);

    expect(reviewer?.departmentId).toBe("dept-engineering");
    expect(reviewer?.id).not.toBe(person("Ada"));
  });

  it("keeps a department's work inside it, unless an arrow says otherwise", async () => {
    // Departments do their own reviewing. The exception is deliberate and
    // drawn: Operations checks Engineering, so its people act on Engineering's
    // work and nobody else's.
    const checks = config.connections.filter((connection) => connection.kind === "reviews");
    const allowed = new Set(checks.map((connection) => `${connection.fromId}->${connection.toId}`));

    const result = await run(approveEverything);
    for (const task of result.tasks) {
      for (const event of task.history) {
        if (event.actorId === null) continue;
        const acting = departmentOf(event.actorId);
        if (acting === task.departmentId) continue;
        expect(allowed).toContain(`${acting}->${task.departmentId}`);
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
    expect(result.done).toBeGreaterThan(0);
    expect(result.tasks.filter((task) => task.status !== "done")).toHaveLength(1);
  });

  it("bills every call to the person who made it, against the work it was for", async () => {
    const result = await run(approveEverything);
    expect(result.usage.length).toBeGreaterThan(0);
    for (const event of result.usage) {
      const employee = config.employees.find((e) => e.id === event.attribution.employeeId);
      expect(employee).toBeDefined();
      expect(event.attribution.taskId).toBeDefined();

      // Billed to the department whose work it is, not to the person's own.
      // When Operations checks something Engineering built, that check is part
      // of what Engineering's work cost, and a cost per department that said
      // otherwise could not be added up.
      const task = result.tasks.find((candidate) => candidate.id === event.attribution.taskId);
      expect(event.attribution.departmentId).toBe(task?.departmentId);
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

describe("what the studio picks up first", () => {
  /** Who the office asked first, read off the scripted provider's calls. */
  async function firstSpeaker(crunched: string | null, tasks: readonly Task[]): Promise<string> {
    const provider = studio();
    const withCrunch: OfficeConfig =
      crunched === null
        ? config
        : {
            ...config,
            departments: config.departments.map((department) =>
              department.name === crunched ? { ...department, priority: "urgent" } : department,
            ),
          };

    await runOffice({
      config: withCrunch,
      tasks,
      provider,
      decide: approveEverything,
      maxTicks: 60,
    });
    const first = provider.calls[0];
    if (first === undefined) throw new Error("nobody was asked to do anything");
    return speaker(first);
  }

  const urgentInProduct = (): Task => ({
    ...brief("task-rush", "Rush the pricing page", "Ravi"),
    priority: "urgent",
  });
  const trivialInEngineering = (): Task => ({
    ...brief("task-tidy", "Tidy the log format", "Ada"),
    priority: "low",
  });

  it("takes the more urgent task first when no department has been prioritised", async () => {
    expect(await firstSpeaker(null, [trivialInEngineering(), urgentInProduct()])).toBe("Ravi");
  });

  it("puts a crunched department's trivial work ahead of another's urgent work", async () => {
    // Engineering is in crunch: everything it does outranks Product, whatever
    // Product's tasks say about themselves.
    expect(await firstSpeaker("Engineering", [trivialInEngineering(), urgentInProduct()])).toBe(
      "Ada",
    );
  });

  it("leaves the studio's own file neutral, so the template is not in crunch", () => {
    for (const department of config.departments) {
      expect(department.priority, department.name).toBe("normal");
    }
  });
});

describe("who reviews an engineer's work", () => {
  it("is another engineer, chosen because they have the least on", async () => {
    // Engineering reviews by peer. Grace and Kai are buried; Linus is free.
    const busy = [
      { ...brief("task-g1", "Grace is buried", "Grace"), status: "in_progress" as const },
      { ...brief("task-g2", "and buried again", "Grace"), status: "in_progress" as const },
      { ...brief("task-k1", "Kai is buried", "Kai"), status: "in_progress" as const },
    ];
    const mine = brief("task-mine", "Rewrite the query planner", "Ada");

    const result = await runOffice({
      config,
      tasks: [...busy, mine],
      provider: studio(),
      decide: approveEverything,
      maxTicks: 60,
    });

    const done = result.tasks.find((task) => task.id === "task-mine");
    const approval = (done?.history ?? []).find((event) => event.to === "approved");
    expect(approval?.actorId).toBe(person("Linus"));
  });
});

describe("one brief travelling the length of the studio", () => {
  /** Only Product is given anything; everything downstream must make itself. */
  async function theDayAfter() {
    return runOffice({
      config,
      tasks: [brief("task-brief", "Ship a CSV export", "Ravi")],
      provider: studio(),
      decide: approveEverything,
      maxTicks: 60,
      id: (() => {
        let n = 0;
        return () => `handed-${String((n += 1))}`;
      })(),
    });
  }

  const inDepartment = (result: OfficeRunResult, name: string): readonly Task[] => {
    const id = config.departments.find((department) => department.name === name)?.id;
    return result.tasks.filter((task) => task.departmentId === id);
  };

  it("reaches Design without anybody creating the work", async () => {
    expect(inDepartment(await theDayAfter(), "Design")).toHaveLength(1);
  });

  it("reaches Engineering, two departments from where it started", async () => {
    expect(inDepartment(await theDayAfter(), "Engineering")).toHaveLength(1);
  });

  it("reaches Operations, at the far end of the studio", async () => {
    expect(inDepartment(await theDayAfter(), "Operations")).toHaveLength(1);
  });

  it("carries the work along with it, not merely a title", async () => {
    const [handed] = inDepartment(await theDayAfter(), "Design");
    expect(handed?.artifacts.length).toBeGreaterThan(0);
  });

  it("remembers where it has been", async () => {
    const [handed] = inDepartment(await theDayAfter(), "Operations");
    expect(handed?.route.map((id) => name(id))).toEqual(["Product", "Design", "Engineering"]);
  });

  it("gives the work to somebody, so it is not left in a pile", async () => {
    const [handed] = inDepartment(await theDayAfter(), "Design");
    expect(handed?.assigneeId).not.toBeNull();
    expect(departmentOf(handed?.assigneeId ?? ("" as EmployeeId))).toBe(
      config.departments.find((department) => department.name === "Design")?.id,
    );
  });

  it("finishes everything it started", async () => {
    const result = await theDayAfter();
    expect(result.tasks.every((task) => task.status === "done")).toBe(true);
  });
});

/** A department's name, for reading a route out loud. */
function name(departmentId: string): string {
  return (
    config.departments.find((department) => department.id === departmentId)?.name ?? departmentId
  );
}

describe("the studio's own definition of done", () => {
  it("is stated in the file, so the office ships with a standard", () => {
    for (const department of config.departments) {
      expect(department.definitionOfDone.length, department.name).toBeGreaterThan(0);
    }
  });

  /** A studio whose reviewers never mention one particular criterion. */
  function forgetful(missing: string): FakeLlmProvider {
    return new FakeLlmProvider({
      id: "anthropic",
      handler: (request) => {
        const asked = criteriaAsked(request);
        const met = asked.filter((criterion) => criterion !== missing);
        return isReview(request)
          ? toolCall("review_verdict", { approved: true, met })
          : toolCall("submit_work", { summary: `${speaker(request)} did it`, met });
      },
    });
  }

  const oneBrief = (provider: FakeLlmProvider) =>
    runOffice({
      config,
      tasks: [brief("task-scope", "Scope the 4.2 release", "Ravi")],
      provider,
      decide: approveEverything,
      maxTicks: 30,
    });

  it("does not finish work that leaves a criterion unmet, however cheerful the reviewer", async () => {
    const result = await oneBrief(forgetful("success is measurable"));
    // The brief itself, not whatever else the studio raised in response to it.
    const scoping = result.tasks.find((task) => task.id === "task-scope");
    expect(scoping?.status).not.toBe("done");
  });

  it("says which criterion was outstanding, so the next round is actionable", async () => {
    const result = await oneBrief(forgetful("success is measurable"));
    const reasons = result.tasks
      .flatMap((task) => task.history.map((event) => event.reason ?? ""))
      .join(" ");
    expect(reasons).toContain("success is measurable");
  });

  it("escalates rather than going round forever", async () => {
    const result = await oneBrief(forgetful("success is measurable"));
    expect(result.tasks.some((task) => task.status === "escalated")).toBe(true);
  });

  it("finishes once the list is actually met", async () => {
    const result = await oneBrief(studio());
    expect(result.tasks.every((task) => task.status === "done")).toBe(true);
  });
});

describe("Operations watching the studio", () => {
  const operations = () => config.departments.find((d) => d.name === "Operations")?.id;

  it("is wired to watch every other department, and nothing watches it", () => {
    const watching = config.connections.filter((c) => c.kind === "watches");
    expect(watching.map((c) => c.fromId)).toEqual([operations(), operations(), operations()]);
    expect(watching.every((c) => c.toId !== operations())).toBe(true);
  });

  it("raises its own work when something goes wrong elsewhere, which nobody asked it to", async () => {
    // Engineering's reviewer never approves, so the work escalates. Operations
    // is not told; it notices.
    const stubborn = new FakeLlmProvider({
      id: "anthropic",
      handler: (request) =>
        isReview(request)
          ? toolCall("review_verdict", { approved: false, reason: "not good enough" })
          : toolCall("submit_work", {
              summary: `${speaker(request)} did it`,
              met: criteriaAsked(request),
            }),
    });

    const result = await runOffice({
      config,
      tasks: [brief("task-endpoint", "Build the export endpoint", "Ada")],
      provider: stubborn,
      decide: approveEverything,
      maxTicks: 40,
    });

    const inOperations = result.tasks.filter((task) => task.departmentId === operations());
    expect(inOperations.length).toBeGreaterThan(0);
    expect(inOperations[0]?.title).toMatch(/something went wrong/i);
  });

  it("does not slow the studio down on an ordinary day", async () => {
    // Nothing goes wrong, so Operations notices nothing and the day is as it was.
    const result = await run(approveEverything);
    expect(result.tasks.every((task) => task.status === "done")).toBe(true);
    expect(result.tasks.some((task) => task.title.includes("went wrong"))).toBe(false);
  });
});

describe("Operations checking Engineering's work", () => {
  const engineeringTask = () => brief("task-endpoint", "Build the export endpoint", "Ada");

  it("is wired as an arrow, not buried in Engineering's own policy", () => {
    const checks = config.connections.filter((connection) => connection.kind === "reviews");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      fromId: config.departments.find((d) => d.name === "Operations")?.id,
      toId: config.departments.find((d) => d.name === "Engineering")?.id,
    });
  });

  it("takes an Engineering approval and a signature from Operations before it is done", async () => {
    const result = await runOffice({
      config,
      tasks: [engineeringTask()],
      provider: studio(),
      decide: approveEverything,
      maxTicks: 40,
    });

    const endpoint = result.tasks.find((task) => task.id === "task-endpoint");
    expect(endpoint?.status).toBe("done");
    expect(endpoint?.checkedBy).toEqual([
      config.departments.find((d) => d.name === "Operations")?.id,
    ]);
  });

  it("says in the history that it waited on somebody outside the department", async () => {
    const result = await runOffice({
      config,
      tasks: [engineeringTask()],
      provider: studio(),
      decide: approveEverything,
      maxTicks: 40,
    });

    const endpoint = result.tasks.find((task) => task.id === "task-endpoint");
    const reasons = (endpoint?.history ?? []).map((event) => event.reason ?? "").join(" ");
    expect(reasons).toMatch(/checked by/i);
  });

  it("does not finish the work when Operations will not sign it off", async () => {
    // Engineering approves its own work; Operations refuses. The refusal is
    // what a checker is for, and the work goes back rather than shipping.
    const opsSaysNo = new FakeLlmProvider({
      id: "anthropic",
      handler: (request) => {
        if (!isReview(request)) {
          return toolCall("submit_work", {
            summary: `${speaker(request)} did it`,
            met: criteriaAsked(request),
          });
        }
        return speaker(request) === "Nadia"
          ? toolCall("review_verdict", {
              approved: false,
              reason: "the rollback was not rehearsed",
            })
          : toolCall("review_verdict", { approved: true, met: criteriaAsked(request) });
      },
    });

    const result = await runOffice({
      config,
      tasks: [engineeringTask()],
      provider: opsSaysNo,
      decide: approveEverything,
      maxTicks: 40,
    });

    const endpoint = result.tasks.find((task) => task.id === "task-endpoint");
    expect(endpoint?.status).not.toBe("done");
    const reasons = (endpoint?.history ?? []).map((event) => event.reason ?? "").join(" ");
    expect(reasons).toContain("rollback");
  });

  it("leaves departments nobody checks exactly as they were", async () => {
    const result = await runOffice({
      config,
      tasks: [brief("task-screen", "Draw the export screen", "Theo")],
      provider: studio(),
      decide: approveEverything,
      maxTicks: 40,
    });

    const screen = result.tasks.find((task) => task.id === "task-screen");
    expect(screen?.status).toBe("done");
    expect(screen?.checkedBy).toEqual([]);
  });
});

describe("what the studio actually produced", () => {
  /**
   * The office writing things down, rather than describing them.
   *
   * Before this, a day's work left four one-line summaries and nothing else —
   * which is why "is the sample producing an output?" had the answer no. These
   * assertions are on real rows with real bytes, so a summary string cannot
   * make them pass.
   */
  function writingStudio(): FakeLlmProvider {
    // Writes the work down once, then submits — the shape a real turn takes.
    const filed = new Set<string>();
    return new FakeLlmProvider({
      id: "anthropic",
      handler: (request) => {
        if (isReview(request)) {
          return toolCall("review_verdict", { approved: true, met: criteriaAsked(request) });
        }
        const who = speaker(request);
        const what = about(request);
        if (!filed.has(what)) {
          filed.add(what);
          return toolCall("file_document", {
            name: `${what.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
            mediaType: "text/markdown",
            content: `# ${what}\n\nBy ${who}.\n`,
          });
        }
        return toolCall("submit_work", { summary: `${who}: ${what}`, met: criteriaAsked(request) });
      },
    });
  }

  const written = async (): Promise<OfficeRunResult> =>
    runOffice({
      config,
      tasks: TASKS,
      provider: writingStudio(),
      decide: approveEverything,
      maxTicks: 60,
    });

  it("comes out of the day holding documents, not just summaries", async () => {
    const result = await written();
    expect(result.documents.length).toBeGreaterThan(0);
  });

  it("wrote real bytes, which is the whole difference", async () => {
    const result = await written();
    const scoped = result.documents.find((one) => one.document.name.includes("scope"));

    expect(scoped?.text).toContain("# Scope the 4.2 release");
    expect(scoped?.document.size).toBe(scoped?.text.length);
  });

  it("files each document into the out-tray of the work it came from", async () => {
    const result = await written();
    const scoped = result.documents.find((one) => one.document.name.includes("scope"));

    expect(scoped?.document.ownerKind).toBe("task");
    expect(scoped?.document.tray).toBe("out");
    expect(scoped?.document.ownerId).toBe("task-scope");
  });

  it("records which employee wrote each one", async () => {
    const result = await written();
    const scoped = result.documents.find((one) => one.document.name.includes("scope"));
    expect(scoped?.document.addedBy).toBe(person("Ravi"));
  });

  it("still finishes the day's work while writing it down", async () => {
    const result = await written();
    expect(result.done).toBeGreaterThan(0);
  });

  it("produces nothing but summaries when nobody files anything", async () => {
    // The tool is offered, not forced: a turn that writes nothing leaves an
    // empty out-tray rather than a document padded out of the summary.
    const result = await run(approveEverything);
    expect(result.documents).toEqual([]);
  });
});

describe("work carrying its documents next door", () => {
  /**
   * The point of a tray, proved where it has to be true.
   *
   * A document that arrives in a tray nobody reads has not actually travelled,
   * so the assertion is on what Engineering was told, not on a row in a store.
   */
  function handingOver(): { provider: FakeLlmProvider; prompts: string[] } {
    const prompts: string[] = [];
    const filed = new Set<string>();
    const provider = new FakeLlmProvider({
      id: "anthropic",
      handler: (request) => {
        prompts.push(systemText(request.system));
        if (isReview(request)) {
          return toolCall("review_verdict", { approved: true, met: criteriaAsked(request) });
        }
        const what = about(request);
        // Design writes the thing down; everybody else just gets on with it.
        if (departmentOf(person(speaker(request))) === "dept-design" && !filed.has(what)) {
          filed.add(what);
          return toolCall("file_document", {
            name: "export-screen.md",
            mediaType: "text/markdown",
            content: "# Export screen\n\nThree states: idle, exporting, done.\n",
          });
        }
        return toolCall("submit_work", {
          summary: `${speaker(request)}: ${what}`,
          met: criteriaAsked(request),
        });
      },
    });
    return { provider, prompts };
  }

  const day = async () => {
    const { provider, prompts } = handingOver();
    const result = await runOffice({
      config,
      tasks: [brief("task-screen", "Draw the export screen", "Theo")],
      provider,
      decide: approveEverything,
      maxTicks: 60,
    });
    return { result, prompts };
  };

  it("puts Design's document in the tray of the work Engineering was handed", async () => {
    const { result } = await day();
    const handedOn = result.tasks.find((task) => task.departmentId === "dept-engineering");
    const carried = result.documents.filter(
      (one) => one.document.ownerId === handedOn?.id && one.document.tray === "in",
    );

    expect(carried.map((one) => one.document.name)).toEqual(["export-screen.md"]);
  });

  it("shows it to the employee who picks the work up", async () => {
    const { prompts } = await day();
    const engineering = prompts.filter((said) => said.includes("export-screen.md"));

    expect(engineering.length).toBeGreaterThan(0);
    expect(engineering[0]).toContain("Three states: idle, exporting, done.");
  });

  it("tells them it is something they were handed, not something telling them what to do", async () => {
    const { prompts } = await day();
    const handed = prompts.find((said) => said.includes("export-screen.md")) ?? "";
    expect(handed).toContain(HANDED_OVER_PREFIX);
  });

  it("leaves Design holding it too, so the work is not moved off their desk", async () => {
    const { result } = await day();
    const kept = result.documents.filter((one) => one.document.tray === "out");

    expect(kept.map((one) => one.document.ownerId)).toEqual(["task-screen"]);
  });

  it("writes the body once, however many desks are holding it", async () => {
    const { result } = await day();
    const bodies = new Set(result.documents.map((one) => one.document.blobRef));

    expect(result.documents.length).toBeGreaterThan(1);
    expect(bodies.size).toBe(1);
  });
});
