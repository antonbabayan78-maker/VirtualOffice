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
      http.get(`${BASE}/offices/office-1/connectors`, () => HttpResponse.json({ items: [] })),
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
      http.get(`${BASE}/offices/office-1/connectors`, () => HttpResponse.json({ items: [] })),
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
      http.get(`${BASE}/offices/office-1/connectors`, () => HttpResponse.json({ items: [] })),
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
      http.get(`${BASE}/offices/office-1/connectors`, () => HttpResponse.json({ items: [] })),
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

describe("saying which entry won a contest", () => {
  const winner = {
    id: "task-1",
    officeId: "office-1",
    departmentId: "dept-eng",
    assigneeId: "emp-ada",
    title: "Draft the launch note",
    status: "done",
    priority: "normal",
    contestId: "contest-1",
    won: {
      reason: "tighter, and it kept the detail",
      decidedBy: "emp-grace",
      decidedAt: "2026-10-01T09:00:00.000Z",
    },
    history: [],
  };

  it("brings back the entry, marked as the one that won", async () => {
    server.use(http.post(`${BASE}/tasks/task-1/win`, () => HttpResponse.json(winner)));

    const result = await client().recordContestWin("task-1", { reason: "tighter" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.won?.reason).toBe("tighter, and it kept the detail");
  });

  it("turns when it was decided back into a date", async () => {
    // Nested inside the verdict, which is the one date `reviveTask` would
    // otherwise hand on as the string it arrived as.
    server.use(http.post(`${BASE}/tasks/task-1/win`, () => HttpResponse.json(winner)));
    const result = await client().recordContestWin("task-1", { reason: "tighter" });
    if (result.ok) expect(result.value.won?.decidedAt).toBeInstanceOf(Date);
  });

  it("leaves a task nobody has decided about with no verdict", async () => {
    server.use(
      http.post(`${BASE}/tasks/task-1/win`, () => HttpResponse.json({ ...winner, won: null })),
    );
    const result = await client().recordContestWin("task-1", { reason: "tighter" });
    if (result.ok) expect(result.value.won).toBeNull();
  });

  it("sends the reason, and who decided when an employee did", async () => {
    let sent: unknown = null;
    server.use(
      http.post(`${BASE}/tasks/task-1/win`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(winner);
      }),
    );

    await client().recordContestWin("task-1", { reason: "tighter", decidedBy: "emp-grace" });
    expect(sent).toEqual({ reason: "tighter", decidedBy: "emp-grace" });
  });

  it("says a person decided when nobody is named, rather than sending a null", async () => {
    let sent: unknown = null;
    server.use(
      http.post(`${BASE}/tasks/task-1/win`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(winner);
      }),
    );

    await client().recordContestWin("task-1", { reason: "tighter" });
    expect(sent).toEqual({ reason: "tighter" });
  });

  it("says a verdict the office refused was refused", async () => {
    server.use(
      http.post(`${BASE}/tasks/task-1/win`, () =>
        HttpResponse.json(
          { errors: [{ path: "contest", message: 'already decided: "Iris" won it' }] },
          { status: 400 },
        ),
      ),
    );

    const result = await client().recordContestWin("task-1", { reason: "on reflection" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "validation") {
      expect(result.errors[0]?.message).toMatch(/already decided/);
    } else {
      throw new Error("expected the office to refuse a second verdict");
    }
  });
});

describe("changing the office itself", () => {
  const office = {
    id: "office-1",
    name: "Acme",
    schedule: { kind: "always" },
    priority: "normal",
    configVersion: 1,
    createdAt: "2026-09-28T09:00:00.000Z",
  };

  it("brings one back on its own", async () => {
    server.use(http.get(`${BASE}/offices/office-1`, () => HttpResponse.json(office)));
    const result = await client().getOffice("office-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Acme");
  });

  it("turns its date back into a date", async () => {
    server.use(http.get(`${BASE}/offices/office-1`, () => HttpResponse.json(office)));
    const result = await client().getOffice("office-1");
    if (result.ok) expect(result.value.createdAt).toBeInstanceOf(Date);
  });

  it("sends a change, and says where the office ended up", async () => {
    server.use(
      http.patch(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ ...office, priority: "urgent" }),
      ),
    );
    const result = await client().patchOffice("office-1", { priority: "urgent" }, 3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.priority).toBe("urgent");
  });

  it("says what it has seen, so the office can spot a stale change", async () => {
    let seen: string | null = null;
    server.use(
      http.patch(`${BASE}/offices/office-1`, ({ request }) => {
        seen = request.headers.get("x-vo-since-offset");
        return HttpResponse.json(office);
      }),
    );
    await client().patchOffice("office-1", { name: "Acme Robotics" }, 7);
    expect(seen).toBe("7");
  });

  it("reports a change the office refused", async () => {
    server.use(
      http.patch(`${BASE}/offices/office-1`, () =>
        HttpResponse.json(
          { errors: [{ path: "priority", message: "must be one of…" }] },
          { status: 400 },
        ),
      ),
    );
    const result = await client().patchOffice("office-1", { priority: "asap" }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("validation");
  });
});

describe("fields an older office does not send", () => {
  it("gives a task the empty lists it is typed as having", async () => {
    // The client casts JSON to a Task; an office that predates a field would
    // otherwise hand back something that lies about its own shape.
    server.use(
      http.get(`${BASE}/tasks/task-1`, () =>
        HttpResponse.json({ id: "task-1", title: "Old", history: [] }),
      ),
    );
    const result = await client().getTask("task-1");
    if (result.ok) {
      expect(result.value.acceptanceCriteria).toEqual([]);
      expect(result.value.route).toEqual([]);
      expect(result.value.artifacts).toEqual([]);
    } else {
      throw new Error("expected the task to load");
    }
  });

  it("gives a department the empty definition of done it is typed as having", async () => {
    server.use(
      http.get(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json({ id: "dept-eng", name: "Engineering" }),
      ),
    );
    const result = await client().getDepartment("dept-eng");
    if (result.ok) expect(result.value.definitionOfDone).toEqual([]);
  });

  it("gives a department the empty bench list it is typed as having", async () => {
    // Every department stored before benches existed says nothing about them,
    // and the canvas maps over this without checking.
    server.use(
      http.get(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json({ id: "dept-eng", name: "Engineering" }),
      ),
    );
    const result = await client().getDepartment("dept-eng");
    if (result.ok) expect(result.value.benches).toEqual([]);
  });

  it("leaves what the office did send alone", async () => {
    server.use(
      http.get(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json({ id: "dept-eng", definitionOfDone: ["has tests"] }),
      ),
    );
    const result = await client().getDepartment("dept-eng");
    if (result.ok) expect(result.value.definitionOfDone).toEqual(["has tests"]);
  });
});

describe("changing an arrow", () => {
  const arrow = {
    id: "conn-1",
    officeId: "office-1",
    fromId: "dept-ops",
    toId: "dept-eng",
    kind: "watches",
    enabled: true,
    rules: { for: ["work_went_wrong"] },
    createdAt: "2026-09-29T09:00:00.000Z",
  };

  it("sends a change, and says where the arrow ended up", async () => {
    server.use(
      http.patch(`${BASE}/connections/conn-1`, () =>
        HttpResponse.json({ ...arrow, enabled: false }),
      ),
    );
    const result = await client().patchConnection("conn-1", { enabled: false }, 4);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(false);
      expect(result.value.createdAt).toBeInstanceOf(Date);
    }
  });

  it("says what it has seen, so the office can spot a stale change", async () => {
    let seen: string | null = null;
    server.use(
      http.patch(`${BASE}/connections/conn-1`, ({ request }) => {
        seen = request.headers.get("x-vo-since-offset");
        return HttpResponse.json(arrow);
      }),
    );
    await client().patchConnection("conn-1", { enabled: false }, 9);
    expect(seen).toBe("9");
  });

  it("reports a change the office refused", async () => {
    server.use(
      http.patch(`${BASE}/connections/conn-1`, () =>
        HttpResponse.json(
          { errors: [{ path: "rules.for", message: "no such moment" }] },
          { status: 400 },
        ),
      ),
    );
    const result = await client().patchConnection("conn-1", { rules: { for: ["never"] } }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("validation");
  });

  it("gives an arrow the switch it is typed as having", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () => HttpResponse.json({ id: "office-1", name: "A" })),
      http.get(`${BASE}/offices/office-1/departments`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connectors`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () =>
        // An office that predates the switch simply does not send it.
        HttpResponse.json({ items: [{ id: "conn-1", kind: "handoff", rules: {} }] }),
      ),
    );
    const result = await client().loadOffice("office-1");
    if (result.ok) expect(result.value.connections[0]?.enabled).toBe(true);
  });
});

const documentRow = {
  id: "doc-1",
  officeId: "office-1",
  ownerKind: "employee",
  ownerId: "emp-ada",
  tray: "in",
  name: "brief.md",
  mediaType: "text/markdown",
  size: 8,
  blobRef: "office-1/documents/doc-1",
  addedBy: null,
  addedAt: "2026-09-29T09:00:00.000Z",
};

describe("documents", () => {
  it("lists what an office is holding, with real dates", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1/documents`, () =>
        HttpResponse.json({ items: [documentRow] }),
      ),
    );

    const result = await client().listDocuments("office-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.name).toBe("brief.md");
      expect(result.value[0]?.addedAt).toBeInstanceOf(Date);
    }
  });

  it("fetches one document, which is what a canvas does when told one arrived", async () => {
    server.use(http.get(`${BASE}/documents/doc-1`, () => HttpResponse.json(documentRow)));

    const result = await client().getDocument("doc-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.addedAt).toBeInstanceOf(Date);
  });

  it("asks for one tray when told which", async () => {
    let asked = "";
    server.use(
      http.get(`${BASE}/offices/office-1/documents`, ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({ items: [] });
      }),
    );

    await client().listDocuments("office-1", {
      ownerKind: "employee",
      ownerId: "emp-ada",
      tray: "out",
    });
    expect(asked).toBe("?ownerKind=employee&ownerId=emp-ada&tray=out");
  });

  it("escapes an owner id rather than pasting it into a query", async () => {
    let asked = "";
    server.use(
      http.get(`${BASE}/offices/office-1/documents`, ({ request }) => {
        asked = new URL(request.url).searchParams.get("ownerId") ?? "";
        return HttpResponse.json({ items: [] });
      }),
    );

    await client().listDocuments("office-1", {
      ownerKind: "task",
      ownerId: "a&b=c",
      tray: "in",
    });
    expect(asked).toBe("a&b=c");
  });

  it("sends a document as base64 and gets the filed document back", async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/offices/office-1/documents`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(documentRow, { status: 201 });
      }),
    );

    const result = await client().uploadDocument("office-1", {
      ownerKind: "employee",
      ownerId: "emp-ada",
      tray: "in",
      name: "brief.md",
      mediaType: "text/markdown",
      body: new TextEncoder().encode("# Brief\n"),
    });

    expect(sent["contentBase64"]).toBe(Buffer.from("# Brief\n").toString("base64"));
    expect(sent["name"]).toBe("brief.md");
    expect(result.ok).toBe(true);
  });

  it("encodes bytes that are not text, and does not choke on a large one", async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/offices/office-1/documents`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(documentRow, { status: 201 });
      }),
    );

    // Spreading a megabyte into String.fromCharCode overflows the stack, which
    // is exactly the size of document this is for.
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    await client().uploadDocument("office-1", {
      ownerKind: "task",
      ownerId: "task-1",
      tray: "out",
      name: "dump.bin",
      body: big,
    });

    expect(sent["contentBase64"]).toBe(Buffer.from(big).toString("base64"));
  });

  it("says which field an office refused", async () => {
    server.use(
      http.post(`${BASE}/offices/office-1/documents`, () =>
        HttpResponse.json(
          { errors: [{ path: "name", message: "must be a file name" }] },
          { status: 400 },
        ),
      ),
    );

    const result = await client().uploadDocument("office-1", {
      ownerKind: "employee",
      ownerId: "emp-ada",
      tray: "in",
      name: "../x",
      body: new Uint8Array(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "validation") {
      expect(result.errors[0]?.path).toBe("name");
    }
  });

  it("brings a body back as bytes, not as text somebody has to decode", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    server.use(
      http.get(`${BASE}/documents/doc-1/content`, () =>
        HttpResponse.arrayBuffer(png.buffer, {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    );

    const result = await client().downloadDocument("doc-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(png);
  });

  it("reports a body the office has not got", async () => {
    server.use(
      http.get(`${BASE}/documents/doc-1/content`, () =>
        HttpResponse.json({ error: "document not found" }, { status: 404 }),
      ),
    );

    const result = await client().downloadDocument("doc-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("transport");
  });

  it("takes a document off a desk without claiming to send JSON", async () => {
    // A request with no body must not say it has one: a strict server refuses
    // "content-type: application/json" with nothing after it, and answers 400.
    let contentType: string | null = "not asked";
    server.use(
      http.delete(`${BASE}/documents/doc-1`, ({ request }) => {
        contentType = request.headers.get("content-type");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await client().deleteDocument("doc-1");
    expect(contentType).toBeNull();
  });

  it("takes a document off a desk, which answers with nothing at all", async () => {
    server.use(
      http.delete(`${BASE}/documents/doc-1`, () => new HttpResponse(null, { status: 204 })),
    );

    // An empty body is this route working, not this route failing.
    const result = await client().deleteDocument("doc-1");
    expect(result.ok).toBe(true);
  });

  it("reports a document that was already gone", async () => {
    server.use(
      http.delete(`${BASE}/documents/doc-1`, () =>
        HttpResponse.json({ error: "document not found" }, { status: 404 }),
      ),
    );

    const result = await client().deleteDocument("doc-1");
    expect(result.ok).toBe(false);
  });
});

const connectorRow = {
  id: "conn-web",
  officeId: "office-1",
  kind: "web",
  name: "design-web",
  config: { hosts: ["help.figma.com"] },
  secretRef: null,
  tools: ["fetch_url"],
  enabled: true,
  createdAt: "2026-09-30T09:00:00.000Z",
};

describe("connectors", () => {
  it("lists what an office can reach, with real dates", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1/connectors`, () =>
        HttpResponse.json({ items: [connectorRow] }),
      ),
    );

    const result = await client().listConnectors("office-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.name).toBe("design-web");
      expect(result.value[0]?.createdAt).toBeInstanceOf(Date);
    }
  });

  it("promises the lists its type promises, for an office that predates them", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1/connectors`, () =>
        HttpResponse.json({ items: [{ ...connectorRow, tools: undefined, enabled: undefined }] }),
      ),
    );

    const result = await client().listConnectors("office-1");
    if (!result.ok) throw new Error("expected this list to load");
    expect(result.value[0]?.tools).toEqual([]);
    // An arrow that says nothing about being off is on; so is a connector.
    expect(result.value[0]?.enabled).toBe(true);
  });

  it("adds one", async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/offices/office-1/connectors`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(connectorRow, { status: 201 });
      }),
    );

    await client().createConnector("office-1", {
      kind: "web",
      name: "design-web",
      tools: ["fetch_url"],
      config: { hosts: ["help.figma.com"] },
    });
    expect(sent).toMatchObject({ kind: "web", name: "design-web", tools: ["fetch_url"] });
  });

  it("switches one off, saying what it was working from", async () => {
    let offset: string | null = null;
    server.use(
      http.patch(`${BASE}/connectors/conn-web`, ({ request }) => {
        offset = request.headers.get("x-vo-since-offset");
        return HttpResponse.json({ ...connectorRow, enabled: false });
      }),
    );

    const result = await client().patchConnector("conn-web", { enabled: false }, 9);
    expect(offset).toBe("9");
    if (result.ok) expect(result.value.enabled).toBe(false);
  });

  it("removes one", async () => {
    server.use(
      http.delete(`${BASE}/connectors/conn-web`, () => new HttpResponse(null, { status: 204 })),
    );
    expect((await client().deleteConnector("conn-web")).ok).toBe(true);
  });

  it("brings connectors back with the rest of the office", async () => {
    server.use(
      http.get(`${BASE}/offices/office-1`, () =>
        HttpResponse.json({ id: "office-1", name: "Acme", schedule: { kind: "always" } }),
      ),
      http.get(`${BASE}/offices/office-1/departments`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/employees`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/tasks`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connections`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/offices/office-1/connectors`, () =>
        HttpResponse.json({ items: [connectorRow] }),
      ),
    );

    const result = await client().loadOffice("office-1");
    if (!result.ok) throw new Error("expected this office to load");
    expect(result.value.connectors.map((one) => one.name)).toEqual(["design-web"]);
  });
});

describe("stopping and starting work from a client", () => {
  it("asks the office to stop, and says where", async () => {
    let seen: { url: string; body: unknown } | null = null;
    server.use(
      http.put(`${BASE}/offices/office-acme/run-state`, async ({ request }) => {
        seen = { url: request.url, body: await request.json() };
        return HttpResponse.json({ id: "office-acme", runState: "paused" });
      }),
    );

    const result = await client().setOfficeRunState("office-acme", "paused");
    expect(result.ok && result.value.runState).toBe("paused");
    expect(seen).toMatchObject({ body: { runState: "paused" } });
  });

  it("asks a room to stop", async () => {
    server.use(
      http.put(`${BASE}/departments/dept-eng/run-state`, () =>
        HttpResponse.json({ id: "dept-eng", runState: "paused" }),
      ),
    );
    const result = await client().setDepartmentRunState("dept-eng", "paused");
    expect(result.ok && result.value.runState).toBe("paused");
  });

  it("pauses a person", async () => {
    let body: unknown = null;
    server.use(
      http.put(`${BASE}/employees/emp-ada/status`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "emp-ada", status: "paused" });
      }),
    );

    const result = await client().setEmployeeStatus("emp-ada", "paused");
    expect(result.ok && result.value.status).toBe("paused");
    expect(body).toEqual({ status: "paused" });
  });

  it("brings back what the office refused rather than swallowing it", async () => {
    server.use(
      http.put(`${BASE}/employees/emp-ada/status`, () =>
        HttpResponse.json(
          { errors: [{ path: "status", message: "employee is terminated" }] },
          { status: 400 },
        ),
      ),
    );
    const result = await client().setEmployeeStatus("emp-ada", "active");
    expect(result.ok).toBe(false);
  });

  it("calls an office that says nothing about a switch running", async () => {
    // Every office stored before this existed says nothing, and is running.
    server.use(
      http.get(`${BASE}/offices/office-acme`, () =>
        HttpResponse.json({ id: "office-acme", name: "Acme" }),
      ),
    );
    const result = await client().getOffice("office-acme");
    expect(result.ok && result.value.runState).toBe("running");
  });

  it("calls a department that says nothing about a switch running too", async () => {
    server.use(
      http.get(`${BASE}/departments/dept-eng`, () =>
        HttpResponse.json({ id: "dept-eng", name: "Engineering" }),
      ),
    );
    const result = await client().getDepartment("dept-eng");
    expect(result.ok && result.value.runState).toBe("running");
  });

  it("leaves a stopped one stopped", async () => {
    server.use(
      http.get(`${BASE}/offices/office-acme`, () =>
        HttpResponse.json({ id: "office-acme", runState: "paused" }),
      ),
    );
    const result = await client().getOffice("office-acme");
    expect(result.ok && result.value.runState).toBe("paused");
  });
});

describe("telling the office what a call cost", () => {
  const event = {
    id: "ev-1",
    kind: "llm_call",
    at: Date.parse("2026-10-01T09:00:00Z"),
    attribution: { officeId: "office-acme", taskId: "task-1", employeeId: "emp-iris" },
    durationMs: 1200,
    ok: true,
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { inputTokens: 100, outputTokens: 50 },
    cost: { totalUsd: 0.004 },
    streamed: false,
  };

  it("posts the event as it stands", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${BASE}/offices/office-acme/usage`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: "usage-1" }, { status: 201 });
      }),
    );

    const result = await client().recordUsage("office-acme", event);
    expect(result.ok).toBe(true);
    expect(body).toEqual(event);
  });

  it("reads back what a piece of work cost", async () => {
    let asked = "";
    server.use(
      http.get(`${BASE}/offices/office-acme/usage`, ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({
          items: [
            { id: "usage-1", officeId: "office-acme", taskId: "task-1", at: event.at, event },
          ],
        });
      }),
    );

    const result = await client().listUsage("office-acme", "task-1");
    expect(asked).toContain("taskId=task-1");
    expect(result.ok && result.value[0]?.taskId).toBe("task-1");
  });

  it("turns the moment back into a date", async () => {
    // It arrives as a string over JSON, and anything comparing or formatting it
    // would be working with text that looks like a date.
    server.use(
      http.get(`${BASE}/offices/office-acme/usage`, () =>
        HttpResponse.json({
          items: [
            {
              id: "usage-1",
              officeId: "office-acme",
              at: "2026-10-01T09:00:00.000Z",
              event,
            },
          ],
        }),
      ),
    );

    const result = await client().listUsage("office-acme");
    expect(result.ok && result.value[0]?.at).toBeInstanceOf(Date);
  });

  it("asks for the whole office when no piece of work is named", async () => {
    let asked = "";
    server.use(
      http.get(`${BASE}/offices/office-acme/usage`, ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({ items: [] });
      }),
    );

    await client().listUsage("office-acme");
    expect(asked).not.toContain("taskId");
  });
});

describe("asking the office what it has spent", () => {
  it("asks for a period and brings back the totals", async () => {
    let asked = "";
    server.use(
      http.get(`${BASE}/offices/office-acme/spend`, ({ request }) => {
        asked = new URL(request.url).search;
        return HttpResponse.json({
          period: "day",
          since: "2026-10-01T00:00:00.000Z",
          officeUsd: 3.75,
          unpricedCalls: 0,
          byDepartment: { "dept-design": 3.75 },
          byEmployee: { "emp-iris": 2, "emp-theo": 1.75 },
        });
      }),
    );

    const result = await client().officeSpend("office-acme", "day");
    expect(asked).toContain("period=day");
    expect(result.ok && result.value.officeUsd).toBe(3.75);
    expect(result.ok && result.value.byEmployee["emp-iris"]).toBe(2);
  });

  it("brings back the empty maps it is typed as having", async () => {
    // An office that predates a field, or a server that answered thinly, must
    // not hand back something the scheduler reads straight into undefined.
    server.use(
      http.get(`${BASE}/offices/office-acme/spend`, () => HttpResponse.json({ officeUsd: 0 })),
    );

    const result = await client().officeSpend("office-acme", "day");
    expect(result.ok && result.value.byDepartment).toEqual({});
    expect(result.ok && result.value.byEmployee).toEqual({});
  });

  it("says so when the office could not be asked", async () => {
    server.use(http.get(`${BASE}/offices/office-acme/spend`, () => HttpResponse.error()));
    expect((await client().officeSpend("office-acme", "day")).ok).toBe(false);
  });
});
