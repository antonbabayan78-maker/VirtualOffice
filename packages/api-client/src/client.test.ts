// This package runs in node, which is also where its AbortController and fetch
// agree with each other. Under jsdom they do not: a signal made there is
// refused as "not an AbortSignal", though in a browser both are native.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import { createApiClient } from "./client.js";

const BASE = "http://office.test";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const client = (timeoutMs = 1_000) =>
  createApiClient({ baseUrl: BASE, token: "sk-owner", timeoutMs });

const department = {
  id: "dept-eng",
  officeId: "office-1",
  name: "Engineering",
  color: "#3366ff",
  icon: null,
  position: { x: 0, y: 0 },
  size: { width: 480, height: 320 },
  config: {},
  reviewPolicy: { kind: "manager", maxIterations: 3 },
  schedule: { kind: "always" },
  createdAt: "2026-09-28T09:00:00.000Z",
};

describe("loading an office", () => {
  it("brings back the office with its departments and people", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ id: "office-1", name: "Acme", schedule: { kind: "always" } }),
      ),
      http.get(`${BASE}/offices/office-1/departments`, () =>
        HttpResponse.json({ items: [department] }),
      ),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () => HttpResponse.json({ items: [] })),
    );

    const result = await client().loadOffice("office-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.office.name).toBe("Acme");
      expect(result.value.departments[0]?.name).toBe("Engineering");
    }
  });

  it("brings back how the departments are connected, so the canvas can draw it", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ id: "office-1", name: "Acme" }),
      ),
      http.get(`${BASE}/offices/office-1/departments`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () =>
        HttpResponse.json({
          items: [
            {
              id: "conn-1",
              officeId: "office-1",
              fromId: "dept-eng",
              toId: "dept-sales",
              kind: "handoff",
              rules: {},
              createdAt: "2026-09-28T09:00:00.000Z",
            },
          ],
        }),
      ),
    );

    const result = await client().loadOffice("office-1");
    if (result.ok) {
      expect(result.value.connections[0]).toMatchObject({ fromId: "dept-eng", kind: "handoff" });
      expect(result.value.connections[0]?.createdAt).toBeInstanceOf(Date);
    } else {
      throw new Error("expected the office to load");
    }
  });

  it("turns the dates back into dates, not strings that look like them", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ id: "office-1", name: "Acme", schedule: { kind: "always" } }),
      ),
      http.get(`${BASE}/offices/office-1/departments`, () =>
        HttpResponse.json({ items: [department] }),
      ),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () => HttpResponse.json({ items: [] })),
    );

    const result = await client().loadOffice("office-1");
    if (!result.ok) throw new Error("expected the office to load");
    expect(result.value.departments[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("sends the token, since the API turns anyone else away", async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/offices/office-1`, ({ request }) => {
        seen = request.headers.get("authorization");
        return HttpResponse.json({ id: "office-1", name: "Acme", schedule: { kind: "always" } });
      }),
      http.get(`${BASE}/offices/office-1/departments`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () => HttpResponse.json({ items: [] })),
    );

    await client().loadOffice("office-1");
    expect(seen).toBe("Bearer sk-owner");
  });

  it("reports an office that is not there rather than pretending", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ error: "office not found" }, { status: 404 }),
      ),
    );
    const result = await client().loadOffice("office-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });
});

describe("saving a change", () => {
  it("sends the change and brings back what the office now holds", async () => {
    server.use(
      http.patch(`${BASE}/departments/dept-eng`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({ ...department, name: body.name });
      }),
    );

    const result = await client().patchDepartment("dept-eng", { name: "Platform" }, 7);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Platform");
  });

  it("says what it was working from, so the office can refuse a clash", async () => {
    let seen: string | null = null;
    server.use(
      http.patch(`${BASE}/departments/dept-eng`, ({ request }) => {
        seen = request.headers.get("x-vo-since-offset");
        return HttpResponse.json(department);
      }),
    );
    await client().patchDepartment("dept-eng", { name: "Platform" }, 7);
    expect(seen).toBe("7");
  });

  it("brings back what the office refused, field by field", async () => {
    server.use(
      http.patch(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json(
          { errors: [{ path: "name", message: "must not be empty" }] },
          { status: 400 },
        ),
      ),
    );

    const result = await client().patchDepartment("dept-eng", { name: "" }, 7);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "validation") {
      expect(result.errors[0]).toEqual({ path: "name", message: "must not be empty" });
    }
  });

  it("brings back what somebody else wrote when there is a clash", async () => {
    server.use(
      http.patch(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json(
          { error: "changed since you loaded it", current: { ...department, name: "Platform" } },
          { status: 409 },
        ),
      ),
    );

    const result = await client().patchDepartment("dept-eng", { name: "Infrastructure" }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "conflict") {
      expect(result.current.name).toBe("Platform");
      expect(result.current.createdAt).toBeInstanceOf(Date);
    }
  });

  it("gives up on a save that never answers, rather than waiting forever", async () => {
    server.use(
      http.patch(`${BASE}/departments/dept-eng`, async () => {
        await delay(500);
        return HttpResponse.json(department);
      }),
    );

    const result = await client(30).patchDepartment("dept-eng", { name: "Platform" }, 7);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "transport") {
      expect(result.message).toMatch(/too long|timed out/i);
    } else {
      throw new Error("expected the save to time out");
    }
  });

  it("reports a network that is simply not there", async () => {
    server.use(http.patch(`${BASE}/departments/dept-eng`, () => HttpResponse.error()));
    const result = await client().patchDepartment("dept-eng", { name: "Platform" }, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });
});

describe("telling the office what an agent did", () => {
  const task = {
    id: "task-1",
    officeId: "office-1",
    departmentId: "dept-eng",
    assigneeId: "emp-ada",
    title: "Write the parser",
    status: "in_review",
    priority: "normal",
    reviewerIds: ["emp-grace"],
    approvals: [],
    stage: null,
    gatedActions: [],
    history: [{ type: "submitted", at: "2026-09-28T09:00:00.000Z" }],
  };

  it("hands the event over and brings back where the task got to", async () => {
    server.use(http.post(`${BASE}/tasks/task-1/events`, () => HttpResponse.json(task)));

    const result = await client().postTaskEvent("task-1", { type: "submit", actorId: "emp-ada" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe("in_review");
  });

  it("sends the event as the body, since that is what the office reads", async () => {
    let sent: unknown = null;
    server.use(
      http.post(`${BASE}/tasks/task-1/events`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(task);
      }),
    );

    await client().postTaskEvent("task-1", { type: "approve", actorId: "emp-grace" });
    expect(sent).toEqual({ type: "approve", actorId: "emp-grace" });
  });

  it("turns the task's history back into dates", async () => {
    server.use(http.post(`${BASE}/tasks/task-1/events`, () => HttpResponse.json(task)));
    const result = await client().postTaskEvent("task-1", { type: "submit", actorId: "emp-ada" });
    if (result.ok) expect(result.value.history[0]?.at).toBeInstanceOf(Date);
  });

  it("says an event the office refused was refused, rather than swallowing it", async () => {
    server.use(
      http.post(`${BASE}/tasks/task-1/events`, () =>
        HttpResponse.json(
          { errors: [{ path: "type", message: "a task in done cannot be submitted" }] },
          { status: 400 },
        ),
      ),
    );

    const result = await client().postTaskEvent("task-1", { type: "submit", actorId: "emp-ada" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "validation") {
      expect(result.errors[0]?.message).toMatch(/cannot be submitted/);
    } else {
      throw new Error("expected the office to refuse the event");
    }
  });

  it("reports an office it could not reach, so a worker can retry", async () => {
    server.use(http.post(`${BASE}/tasks/task-1/events`, () => HttpResponse.error()));
    const result = await client().postTaskEvent("task-1", { type: "submit", actorId: "emp-ada" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });
});
