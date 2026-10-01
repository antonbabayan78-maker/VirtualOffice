import { describe, expect, it } from "vitest";
import { rehearsalProvider, type LlmProvider } from "@vo/llm";
import type { ApiClient } from "@vo/api-client";
import type { DepartmentId, EmployeeId, OfficeId, TaskId } from "@vo/core";
import { createOfficeWorker, meteredProvider } from "./office-worker.js";

const config = {
  baseUrl: "http://office.test",
  token: "sk-owner",
  officeId: "office-1",
  dryRun: true,
  apiKey: undefined,
  tickMs: 10,
  batchSize: 2,
};

describe("putting a worker together", () => {
  it("builds one that can tick", () => {
    const worker = createOfficeWorker({ config, provider: rehearsalProvider() });
    expect(typeof worker.tick).toBe("function");
  });

  it("does nothing at all when the office cannot be reached, and says why", async () => {
    // Nothing is listening on that address, which is the honest version of a
    // server that is down: the tick must survive it.
    const problems: string[] = [];
    const worker = createOfficeWorker({
      config,
      provider: rehearsalProvider(),
      onProblem: (message) => problems.push(message),
    });

    const report = await worker.tick();
    expect(report.enqueued).toBe(0);
    expect(report.failed).toBe(0);
    expect(problems.join(" ")).toMatch(/could not read office/);
  });
});

describe("a worker that measures what it spends", () => {
  /** A provider that answers once, reporting tokens the way a real one does. */
  const scripted = (): LlmProvider => ({
    id: "anthropic",
    stream: () => {
      throw new Error("this provider is not streamed here");
    },
    complete: () =>
      Promise.resolve({
        id: "msg-1",
        model: "claude-sonnet-5",
        content: [{ type: "text" as const, text: "done" }],
        stopReason: "end_turn" as const,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
  });

  const attribution = {
    officeId: "office-1" as OfficeId,
    departmentId: "dept-design" as DepartmentId,
    employeeId: "emp-iris" as EmployeeId,
    taskId: "task-1" as TaskId,
  };

  const apiThat = (recordUsage: ApiClient["recordUsage"]): ApiClient =>
    ({ recordUsage }) as unknown as ApiClient;

  it("records one event per model call", async () => {
    // The gap this task exists to close: llmAgentTurn has always taken a
    // wrapProvider hook and the CLI has always used it, while the worker passed
    // the raw provider — so a worker measured nothing at all.
    const sent: Record<string, unknown>[] = [];
    const wrap = meteredProvider(
      apiThat((_officeId, event) => {
        sent.push(event);
        return Promise.resolve({ ok: true as const, value: {} as never });
      }),
    );

    await wrap(scripted(), attribution).complete({ model: "claude-sonnet-5", messages: [] });
    expect(sent).toHaveLength(1);
  });

  it("says which office, person and piece of work the spend belongs to", async () => {
    // "The office cost $40 today" is not actionable; this attribution is the
    // whole reason the event exists.
    const sent: Record<string, unknown>[] = [];
    const wrap = meteredProvider(
      apiThat((_officeId, event) => {
        sent.push(event);
        return Promise.resolve({ ok: true as const, value: {} as never });
      }),
    );

    await wrap(scripted(), attribution).complete({ model: "claude-sonnet-5", messages: [] });
    expect(sent[0]?.["attribution"]).toMatchObject({
      officeId: "office-1",
      employeeId: "emp-iris",
      taskId: "task-1",
    });
  });

  it("carries the model and what it used", async () => {
    const sent: Record<string, unknown>[] = [];
    const wrap = meteredProvider(
      apiThat((_officeId, event) => {
        sent.push(event);
        return Promise.resolve({ ok: true as const, value: {} as never });
      }),
    );

    await wrap(scripted(), attribution).complete({ model: "claude-sonnet-5", messages: [] });
    expect(sent[0]?.["model"]).toBe("claude-sonnet-5");
    expect(sent[0]?.["usage"]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("gives the model its answer back untouched", async () => {
    const wrap = meteredProvider(
      apiThat(() => Promise.resolve({ ok: true as const, value: {} as never })),
    );
    const answer = await wrap(scripted(), attribution).complete({
      model: "claude-sonnet-5",
    } as never);

    expect(answer.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("still answers when the office cannot be told what it cost", async () => {
    // Metering never fails the work it measures.
    const problems: string[] = [];
    const wrap = meteredProvider(
      apiThat(() => Promise.reject(new Error("socket hang up"))),
      (message) => problems.push(message),
    );

    const answer = await wrap(scripted(), attribution).complete({
      model: "claude-sonnet-5",
    } as never);
    expect(answer.stopReason).toBe("end_turn");
    expect(problems).toHaveLength(1);
  });
});

describe("a worker actually wired to meter", () => {
  /**
   * An office that answers just enough for one job to run: one department, one
   * person, one assigned task, and a record of every usage post it receives.
   */
  function anOffice() {
    const posted: { url: string; body: unknown }[] = [];
    const at = "2026-10-01T09:00:00.000Z";
    const department = {
      id: "dept-design",
      officeId: "office-1",
      name: "Design",
      schedule: { kind: "always" },
      runState: "running",
      reviewPolicy: { kind: "direct" },
      priority: "normal",
      benches: [],
      toolGrants: [],
      definitionOfDone: [],
      createdAt: at,
    };
    const employee = {
      id: "emp-iris",
      officeId: "office-1",
      departmentId: "dept-design",
      name: "Iris",
      role: "Designer",
      status: "active",
      priority: "normal",
      llm: { provider: "anthropic", model: "claude-sonnet-5", fallbacks: [] },
      skillIds: [],
      toolGrants: [],
      schedule: null,
      createdAt: at,
      statusChangedAt: at,
    };
    const task = {
      id: "task-1",
      officeId: "office-1",
      departmentId: "dept-design",
      assigneeId: "emp-iris",
      title: "Draw the export screen",
      brief: "",
      status: "assigned",
      priority: "normal",
      reviewerIds: [],
      approvals: [],
      benchId: null,
      history: [{ at, to: "assigned" }],
      acceptanceCriteria: [],
      route: [],
      artifacts: [],
      dependsOn: [],
      gatedActions: [],
      stage: null,
    };

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/usage")) {
        posted.push({ url, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") });
        return json({ id: "usage-1" }, 201);
      }
      // Singular first: /employees/emp-iris is one person, not a list.
      if (url.endsWith("/employees/emp-iris")) return json(employee);
      if (url.endsWith("/departments/dept-design")) return json(department);
      if (url.endsWith("/tasks/task-1")) return json(task);
      if (url.includes("/departments")) return json({ items: [department] });
      if (url.includes("/employees")) return json({ items: [employee] });
      if (url.includes("/tasks") && method === "GET") return json({ items: [task] });
      if (url.includes("/connectors")) return json({ items: [] });
      if (url.includes("/connections")) return json({ items: [] });
      if (url.includes("/documents")) return json({ items: [] });
      if (url.includes("/events")) return json(task);
      if (url.endsWith("/offices/office-1")) {
        return json({
          id: "office-1",
          name: "Acme",
          schedule: { kind: "always" },
          priority: "normal",
          runState: "running",
          configVersion: 1,
          createdAt: at,
        });
      }
      return json({ items: [] });
    }) as unknown as typeof globalThis.fetch;

    return { fetch, posted };
  }

  it("posts what a job cost, without anybody wiring it up by hand", async () => {
    // The assertion that would have caught the real bug: meteredProvider being
    // correct says nothing about the worker using it.
    const office = anOffice();
    const worker = createOfficeWorker({
      config,
      provider: rehearsalProvider(),
      fetch: office.fetch,
    });

    await worker.tick();
    expect(office.posted.length).toBeGreaterThan(0);
  });

  it("attributes the spend to the office, the person and the work", async () => {
    const office = anOffice();
    const worker = createOfficeWorker({
      config,
      provider: rehearsalProvider(),
      fetch: office.fetch,
    });

    await worker.tick();

    const event = office.posted[0]?.body as Record<string, unknown>;
    expect(event["attribution"]).toMatchObject({
      officeId: "office-1",
      employeeId: "emp-iris",
      taskId: "task-1",
    });
  });
});

describe("a worker that can decide a shootout", () => {
  /**
   * An office with one contest whose answers are both in, a bench that names a
   * judge, and a record of every verdict and usage post it receives.
   */
  function aContest() {
    const verdicts: { url: string; body: unknown }[] = [];
    const posted: { url: string; body: unknown }[] = [];
    const at = "2026-10-01T09:00:00.000Z";
    const bench = {
      id: "bench-draft",
      name: "Drafting",
      memberIds: ["emp-iris", "emp-theo"],
      strategy: "shootout",
      judgeId: "emp-grace",
    };
    const department = {
      id: "dept-design",
      officeId: "office-1",
      name: "Design",
      schedule: { kind: "always" },
      runState: "running",
      reviewPolicy: { kind: "direct" },
      priority: "normal",
      benches: [bench],
      toolGrants: [],
      definitionOfDone: [],
      createdAt: at,
    };
    const person = (id: string, name: string, model: string, departmentId = "dept-design") => ({
      id,
      officeId: "office-1",
      departmentId,
      name,
      role: "Designer",
      status: "active",
      priority: "normal",
      llm: { provider: "anthropic", model, fallbacks: [] },
      skillIds: [],
      toolGrants: [],
      schedule: null,
      createdAt: at,
      statusChangedAt: at,
    });
    const employees = [
      person("emp-iris", "Iris", "claude-sonnet-5"),
      person("emp-theo", "Theo", "claude-opus-5"),
      person("emp-grace", "Grace", "claude-opus-5", "dept-lead"),
    ];
    const entry = (id: string, assigneeId: string) => ({
      id,
      officeId: "office-1",
      departmentId: "dept-design",
      assigneeId,
      title: "Draft the launch note",
      brief: "",
      status: "done",
      priority: "normal",
      reviewerIds: [],
      approvals: [],
      benchId: "bench-draft",
      contestId: "contest-1",
      won: null,
      history: [{ at, to: "done" }],
      acceptanceCriteria: [],
      route: [],
      artifacts: [],
      dependsOn: [],
      gatedActions: [],
      stage: null,
    });
    const tasks = [entry("task-a", "emp-iris"), entry("task-b", "emp-theo")];

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown;
      if (method === "POST" && url.includes("/win")) {
        verdicts.push({ url, body });
        return json({ ...tasks[0], won: body }, 200);
      }
      if (method === "POST" && url.includes("/usage")) {
        posted.push({ url, body });
        return json({ id: "usage-1" }, 201);
      }
      if (url.endsWith("/employees/emp-grace")) return json(employees[2]);
      if (url.endsWith("/departments/dept-design")) return json(department);
      if (url.includes("/documents/") && url.includes("/body")) {
        return new Response("a draft of the launch note", { status: 200 });
      }
      if (url.includes("/documents")) {
        const owner = /ownerId=([^&]+)/.exec(url)?.[1] ?? "task-a";
        return json({
          items: [
            {
              id: `doc-${owner}`,
              officeId: "office-1",
              name: `${owner}.md`,
              mediaType: "text/markdown",
              ownerKind: "task",
              ownerId: owner,
              tray: "out",
              size: 24,
              blobRef: `blob-${owner}`,
              addedBy: null,
              addedAt: at,
            },
          ],
        });
      }
      if (url.includes("/departments")) return json({ items: [department] });
      if (url.includes("/employees")) return json({ items: employees });
      if (url.includes("/tasks") && method === "GET") return json({ items: tasks });
      if (url.includes("/connectors")) return json({ items: [] });
      if (url.includes("/connections")) return json({ items: [] });
      if (url.endsWith("/offices/office-1")) {
        return json({
          id: "office-1",
          name: "Acme",
          schedule: { kind: "always" },
          priority: "normal",
          runState: "running",
          configVersion: 1,
          createdAt: at,
        });
      }
      return json({ items: [] });
    }) as unknown as typeof globalThis.fetch;

    return { fetch, verdicts, posted };
  }

  it("decides a contest nobody was watching, end to end", async () => {
    // The assertion that would catch a worker built without a judge: the turn
    // being correct says nothing about the worker using it.
    const office = aContest();
    const worker = createOfficeWorker({
      config,
      provider: rehearsalProvider(),
      fetch: office.fetch,
    });

    const report = await worker.tick();
    expect(report.enqueued).toBe(1);
    expect(report.failed).toBe(0);
    expect(office.verdicts).toHaveLength(1);
  });

  it("records who decided it, so the canvas does not call it a person's doing", async () => {
    const office = aContest();
    await createOfficeWorker({ config, provider: rehearsalProvider(), fetch: office.fetch }).tick();

    expect(office.verdicts[0]?.body).toMatchObject({ decidedBy: "emp-grace" });
  });

  it("charges the judging to the judge and the contest, not to a task", async () => {
    const office = aContest();
    await createOfficeWorker({ config, provider: rehearsalProvider(), fetch: office.fetch }).tick();

    const event = office.posted[0]?.body as Record<string, unknown>;
    expect(event["attribution"]).toMatchObject({
      officeId: "office-1",
      employeeId: "emp-grace",
      contestId: "contest-1",
    });
    expect((event["attribution"] as Record<string, unknown>)["taskId"]).toBeUndefined();
  });
});
