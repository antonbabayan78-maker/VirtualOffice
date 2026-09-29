import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryBlobStore, InMemoryRelationalStore } from "@vo/storage";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { OfficeEventLog } from "./events.js";
import { buildServer } from "./server.js";
import { tokenVerifier } from "./auth.js";

const TOKEN = "sk-owner";
const auth = { authorization: `Bearer ${TOKEN}` };

let server: FastifyInstance;
let events: OfficeEventLog;
let ids = 0;

beforeEach(async () => {
  ids = 0;
  events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
  server = buildServer({
    store: new InMemoryRelationalStore(),
    events,
    verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
    id: () => `id-${String(++ids)}`,
    now: () => new Date("2026-09-28T09:00:00.000Z"),
  });
  await server.ready();
});

type Body = NonNullable<InjectOptions["payload"]>;

const post = (url: string, payload: Body): Promise<LightMyRequestResponse> =>
  server.inject({ method: "POST", url, headers: auth, payload });
const patch = (url: string, payload: Body): Promise<LightMyRequestResponse> =>
  server.inject({ method: "PATCH", url, headers: auth, payload });
const get = (url: string): Promise<LightMyRequestResponse> =>
  server.inject({ method: "GET", url, headers: auth });

async function anOffice(): Promise<string> {
  const created = await post("/offices", { name: "Acme" });
  return created.json<{ id: string }>().id;
}

async function aDepartment(officeId: string, name = "Engineering"): Promise<string> {
  const created = await post(`/offices/${officeId}/departments`, {
    name,
    color: "#3366ff",
    position: { x: 0, y: 0 },
  });
  return created.json<{ id: string }>().id;
}

describe("letting anyone in", () => {
  it("does not, without a token", async () => {
    const response = await server.inject({ method: "GET", url: "/offices" });
    expect(response.statusCode).toBe(401);
  });

  it("does not, with a token it does not know", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/offices",
      headers: { authorization: "Bearer sk-nonsense" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("does not, with a header that is not a bearer token", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/offices",
      headers: { authorization: "Basic abc" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("guards writing as well as reading", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/offices",
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("answers health without a token, because a probe has none", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});

describe("offices", () => {
  it("creates one and gives it back", async () => {
    const response = await post("/offices", { name: "Acme" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Acme", id: "id-1" });
  });

  it("refuses an office with no name, saying which field", async () => {
    const response = await post("/offices", { name: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe("name");
  });

  it("lists what has been created", async () => {
    await post("/offices", { name: "Acme" });
    await post("/offices", { name: "Globex" });
    const response = await get("/offices");
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it("finds one by id", async () => {
    const id = await anOffice();
    const response = await get(`/offices/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: "Acme" });
  });

  it("says plainly when there is no such office", async () => {
    const response = await get("/offices/office-nowhere");
    expect(response.statusCode).toBe(404);
  });
});

describe("departments", () => {
  it("creates one in its office", async () => {
    const officeId = await anOffice();
    const response = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Engineering", officeId });
  });

  it("refuses a second department with the same name", async () => {
    const officeId = await anOffice();
    await aDepartment(officeId);
    const response = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/already exists/);
  });

  it("refuses one for an office that does not exist", async () => {
    const response = await post("/offices/office-nowhere/departments", {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lists the departments of one office only", async () => {
    const first = await anOffice();
    const second = await anOffice();
    await aDepartment(first, "Engineering");
    await aDepartment(second, "Sales");
    const response = await get(`/offices/${first}/departments`);
    expect(response.json<{ items: { name: string }[] }>().items.map((d) => d.name)).toEqual([
      "Engineering",
    ]);
  });

  it("changes one", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    const response = await patch(`/departments/${id}`, { name: "Platform" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Platform" });
  });

  it("refuses a change the office would not accept", async () => {
    const officeId = await anOffice();
    await aDepartment(officeId, "Sales");
    const id = await aDepartment(officeId, "Engineering");
    const response = await patch(`/departments/${id}`, { name: "Sales" });
    expect(response.statusCode).toBe(400);
  });

  it("removes one", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    expect(
      (await server.inject({ method: "DELETE", url: `/departments/${id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    expect((await get(`/offices/${officeId}/departments`)).json()).toMatchObject({ items: [] });
  });
});

describe("employees", () => {
  const hire = async (officeId: string, departmentId: string, name = "Ada") =>
    post(`/offices/${officeId}/employees`, {
      name,
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });

  it("hires somebody into a department", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const response = await hire(officeId, departmentId);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Ada", departmentId, status: "active" });
  });

  it("refuses to hire into a department that is not there", async () => {
    const officeId = await anOffice();
    const response = await hire(officeId, "dept-nowhere");
    expect(response.statusCode).toBe(400);
  });

  it("refuses somebody with no name", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const response = await hire(officeId, departmentId, "");
    expect(response.statusCode).toBe(400);
  });

  it("lists the people in an office", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    await hire(officeId, departmentId, "Ada");
    await hire(officeId, departmentId, "Grace");
    expect((await get(`/offices/${officeId}/employees`)).json()).toMatchObject({
      items: [{ name: "Ada" }, { name: "Grace" }],
    });
  });

  it("changes one", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const id = (await hire(officeId, departmentId)).json<{ id: string }>().id;
    const response = await patch(`/employees/${id}`, { role: "Staff engineer" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: "Staff engineer" });
  });

  it("gives one back on its own, which is what a live canvas refetches", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const id = (await hire(officeId, departmentId)).json<{ id: string }>().id;
    const response = await get(`/employees/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: "Ada" });
  });

  it("says plainly when there is no such employee", async () => {
    expect((await get("/employees/emp-nobody")).statusCode).toBe(404);
  });

  it("will not make somebody their own supervisor", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const id = (await hire(officeId, departmentId)).json<{ id: string }>().id;
    const response = await patch(`/employees/${id}`, { supervisorId: id });
    expect(response.statusCode).toBe(400);
  });
});

describe("tasks", () => {
  it("creates one and lists it", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const created = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Write the parser",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "Write the parser", status: "backlog" });
    expect((await get(`/offices/${officeId}/tasks`)).json()).toMatchObject({
      items: [{ title: "Write the parser" }],
    });
  });

  it("refuses a task with no title", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const response = await post(`/offices/${officeId}/tasks`, { departmentId, title: "" });
    expect(response.statusCode).toBe(400);
  });
});

describe("connections", () => {
  it("joins two departments", async () => {
    const officeId = await anOffice();
    const from = await aDepartment(officeId, "Engineering");
    const to = await aDepartment(officeId, "Sales");
    const response = await post(`/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "handoff",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ fromId: from, toId: to, kind: "handoff" });
  });

  it("refuses a loop in the reporting line", async () => {
    const officeId = await anOffice();
    const a = await aDepartment(officeId, "A");
    const b = await aDepartment(officeId, "B");
    await post(`/offices/${officeId}/connections`, { fromId: a, toId: b, kind: "reports_to" });
    const response = await post(`/offices/${officeId}/connections`, {
      fromId: b,
      toId: a,
      kind: "reports_to",
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toMatch(/cycle|circular/i);
  });

  it("removes one", async () => {
    const officeId = await anOffice();
    const from = await aDepartment(officeId, "Engineering");
    const to = await aDepartment(officeId, "Sales");
    const made = await post(`/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "handoff",
    });
    const id = made.json<{ id: string }>().id;
    expect(
      (await server.inject({ method: "DELETE", url: `/connections/${id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
  });
});

describe("saying what changed", () => {
  it("publishes an event for every change, in order", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    await patch(`/departments/${departmentId}`, { name: "Platform" });

    const published = events.since(officeId, 0).map((event) => event.data["kind"]);
    // The office's own creation is on its log too: the log records everything.
    expect(published).toEqual(["office.created", "department.created", "department.updated"]);
  });

  it("says nothing about a change that was refused", async () => {
    const officeId = await anOffice();
    const before = events.since(officeId, 0).length;
    await post(`/offices/${officeId}/departments`, {
      name: "",
      color: "#3366ff",
      position: { x: 0, y: 0 },
    });
    expect(events.since(officeId, 0)).toHaveLength(before);
  });

  it("names what changed, so a canvas can update just that", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const event = events
      .since(officeId, 0)
      .find((candidate) => candidate.data["kind"] === "department.created");
    expect(event?.data).toMatchObject({ kind: "department.created", id: departmentId });
  });
});

describe("two people editing the same thing", () => {
  const sinceHeader = (offset: number) => ({ ...auth, "x-vo-since-offset": String(offset) });

  it("accepts a change from somebody working from what the server holds", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    const offset = events.since(officeId, 0).at(-1)?.offset ?? 0;

    const response = await server.inject({
      method: "PATCH",
      url: `/departments/${id}`,
      headers: sinceHeader(offset),
      payload: { name: "Platform" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a change written over somebody else's, and hands back what is current", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    const stale = events.since(officeId, 0).at(-1)?.offset ?? 0;

    // Somebody else gets there first.
    await patch(`/departments/${id}`, { name: "Platform" });

    const response = await server.inject({
      method: "PATCH",
      url: `/departments/${id}`,
      headers: sinceHeader(stale),
      payload: { name: "Infrastructure" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ current: { name: string } }>().current.name).toBe("Platform");
  });

  it("leaves the department as the first writer left it", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    const stale = events.since(officeId, 0).at(-1)?.offset ?? 0;
    await patch(`/departments/${id}`, { name: "Platform" });
    await server.inject({
      method: "PATCH",
      url: `/departments/${id}`,
      headers: sinceHeader(stale),
      payload: { name: "Infrastructure" },
    });
    expect((await get(`/departments/${id}`)).json<{ name: string }>().name).toBe("Platform");
  });

  it("takes a change from a client that says nothing about what it has seen", async () => {
    const officeId = await anOffice();
    const id = await aDepartment(officeId);
    await patch(`/departments/${id}`, { name: "Platform" });
    const response = await patch(`/departments/${id}`, { name: "Infrastructure" });
    // No offset offered means no claim to be up to date, and no protection.
    expect(response.statusCode).toBe(200);
  });

  it("guards an employee the same way", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const hired = await post(`/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    const id = hired.json<{ id: string }>().id;
    const stale = events.since(officeId, 0).at(-1)?.offset ?? 0;
    await patch(`/employees/${id}`, { role: "Staff engineer" });

    const response = await server.inject({
      method: "PATCH",
      url: `/employees/${id}`,
      headers: sinceHeader(stale),
      payload: { role: "Principal engineer" },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("being called from a canvas in a browser", () => {
  const withOrigins = async (origins: string[]) => {
    const app = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      allowedOrigins: origins,
    });
    await app.ready();
    return app;
  };

  /** What a browser asks before it is willing to send a change. */
  const preflight = async (method: string) => {
    const app = await withOrigins(["http://localhost:5173"]);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/departments/dept-1",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": method,
        "access-control-request-headers": "authorization,content-type,x-vo-since-offset",
      },
    });
    await app.close();
    return response;
  };

  it("lets a browser send a change, not only read", async () => {
    // Every drawer saves with PATCH. Allowed methods default to GET/HEAD/POST,
    // so without this a browser is refused before the request is even sent —
    // and no test that injects a request would ever notice.
    const allowed = (await preflight("PATCH")).headers["access-control-allow-methods"];
    expect(String(allowed)).toContain("PATCH");
  });

  it("lets a browser delete, since the canvas can close a department down", async () => {
    const allowed = (await preflight("DELETE")).headers["access-control-allow-methods"];
    expect(String(allowed)).toContain("DELETE");
  });

  it("still lets a browser read and create", async () => {
    const allowed = String((await preflight("POST")).headers["access-control-allow-methods"]);
    expect(allowed).toContain("GET");
    expect(allowed).toContain("POST");
  });

  it("accepts the header the canvas uses to say what it has already seen", async () => {
    const allowed = (await preflight("PATCH")).headers["access-control-allow-headers"];
    expect(String(allowed)).toContain("x-vo-since-offset");
  });

  it("lets an origin it was told about call it", async () => {
    const app = await withOrigins(["http://localhost:5173"]);
    const response = await app.inject({
      method: "GET",
      url: "/offices",
      headers: { ...auth, origin: "http://localhost:5173" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    await app.close();
  });

  it("does not vouch for an origin it was not told about", async () => {
    const app = await withOrigins(["http://localhost:5173"]);
    const response = await app.inject({
      method: "GET",
      url: "/offices",
      headers: { ...auth, origin: "http://somewhere.else" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("answers the browser's question before a save", async () => {
    const app = await withOrigins(["http://localhost:5173"]);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/departments/dept-eng",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,x-vo-since-offset",
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-headers"]).toMatch(/x-vo-since-offset/);
    await app.close();
  });

  it("says nothing about origins when none were allowed", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/offices",
      headers: { ...auth, origin: "http://localhost:5173" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("moving a task along", () => {
  const anOfficeWithWork = async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const boss = (
      await post(`/offices/${officeId}/employees`, {
        name: "Grace",
        role: "Manager",
        color: "#ff8800",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
    const ada = (
      await post(`/offices/${officeId}/employees`, {
        name: "Ada",
        role: "Engineer",
        color: "#00aa66",
        department: departmentId,
        supervisorId: boss,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
    const taskId = (
      await post(`/offices/${officeId}/tasks`, {
        departmentId,
        title: "Write the parser",
        assigneeId: ada,
      })
    ).json<{ id: string }>().id;
    return { officeId, departmentId, taskId, ada, boss };
  };

  it("starts work on a task", async () => {
    const { taskId, ada } = await anOfficeWithWork();
    const response = await post(`/tasks/${taskId}/events`, { type: "start", actorId: ada });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "in_progress" });
  });

  it("sends finished work for review, to the reviewer the policy picks", async () => {
    const { taskId, ada, boss } = await anOfficeWithWork();
    await post(`/tasks/${taskId}/events`, { type: "start", actorId: ada });
    const response = await post(`/tasks/${taskId}/events`, { type: "submit", actorId: ada });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "in_review", reviewerIds: [boss] });
  });

  it("finishes a task the reviewer approved", async () => {
    const { taskId, ada, boss } = await anOfficeWithWork();
    await post(`/tasks/${taskId}/events`, { type: "start", actorId: ada });
    await post(`/tasks/${taskId}/events`, { type: "submit", actorId: ada });
    const response = await post(`/tasks/${taskId}/events`, { type: "approve", actorId: boss });
    expect(response.json()).toMatchObject({ status: "done" });
  });

  it("refuses a move the office does not allow, saying why", async () => {
    const { taskId, boss } = await anOfficeWithWork();
    const response = await post(`/tasks/${taskId}/events`, { type: "approve", actorId: boss });
    expect(response.statusCode).toBe(400);
  });

  it("refuses an event it does not know", async () => {
    const { taskId, ada } = await anOfficeWithWork();
    const response = await post(`/tasks/${taskId}/events`, { type: "juggle", actorId: ada });
    expect(response.statusCode).toBe(400);
  });

  it("says so for a task that is not there", async () => {
    expect((await post("/tasks/task-nowhere/events", { type: "start" })).statusCode).toBe(404);
  });

  it("tells the office what happened, so a canvas can follow", async () => {
    const { officeId, taskId, ada } = await anOfficeWithWork();
    const before = events.since(officeId, 0).length;
    await post(`/tasks/${taskId}/events`, { type: "start", actorId: ada });
    const published = events.since(officeId, 0).slice(before);
    expect(published.map((e) => e.data["kind"])).toEqual(["task.updated"]);
    expect(published[0]?.data).toMatchObject({ id: taskId, status: "in_progress" });
  });

  it("gives a task back on its own, which is what a live canvas refetches", async () => {
    const { taskId } = await anOfficeWithWork();
    const response = await get(`/tasks/${taskId}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: taskId, title: "Write the parser" });
  });
});

describe("standing priority over the wire", () => {
  it("takes an office's priority when it is created", async () => {
    const created = await post("/offices", { name: "Acme", priority: "high" });
    expect(created.json<{ priority: string }>().priority).toBe("high");
  });

  it("gives an office that says nothing the ordinary priority", async () => {
    const created = await post("/offices", { name: "Acme" });
    expect(created.json<{ priority: string }>().priority).toBe("normal");
  });

  it("refuses an office priority that is not one", async () => {
    const created = await post("/offices", { name: "Acme", priority: "asap" });
    expect(created.statusCode).toBe(400);
  });

  it("changes an office's priority, which is how the organisation decides", async () => {
    const officeId = await anOffice();
    const updated = await patch(`/offices/${officeId}`, { priority: "urgent" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ priority: string }>().priority).toBe("urgent");
  });

  it("keeps the change when the office is read back", async () => {
    const officeId = await anOffice();
    await patch(`/offices/${officeId}`, { priority: "urgent" });
    expect((await get(`/offices/${officeId}`)).json<{ priority: string }>().priority).toBe(
      "urgent",
    );
  });

  it("renames an office too, since it had no way to be changed at all before", async () => {
    const officeId = await anOffice();
    const updated = await patch(`/offices/${officeId}`, { name: "Acme Robotics" });
    expect(updated.json<{ name: string }>().name).toBe("Acme Robotics");
  });

  it("says so when the office is not there", async () => {
    expect((await patch("/offices/nope", { priority: "high" })).statusCode).toBe(404);
  });

  it("refuses a change it would have refused at creation", async () => {
    const officeId = await anOffice();
    expect((await patch(`/offices/${officeId}`, { priority: "asap" })).statusCode).toBe(400);
  });

  it("tells everyone watching that the office changed", async () => {
    const officeId = await anOffice();
    const before = events.since(officeId, 0).length;
    await patch(`/offices/${officeId}`, { priority: "urgent" });
    const published = events.since(officeId, 0).slice(before);
    expect(published.map((event) => (event.data as { kind: string }).kind)).toContain(
      "office.updated",
    );
  });

  it("turns away a change made against a stale view of the office", async () => {
    const officeId = await anOffice();
    await patch(`/offices/${officeId}`, { name: "First" });
    const stale = await server.inject({
      method: "PATCH",
      url: `/offices/${officeId}`,
      headers: { ...auth, "x-vo-since-offset": "0" },
      payload: { name: "Second" },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("takes a department's priority when it is created, and changes it later", async () => {
    const officeId = await anOffice();
    const created = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
      priority: "urgent",
    });
    expect(created.json<{ priority: string }>().priority).toBe("urgent");

    const id = created.json<{ id: string }>().id;
    expect(
      (await patch(`/departments/${id}`, { priority: "low" })).json<{ priority: string }>()
        .priority,
    ).toBe("low");
  });

  it("takes an employee's priority when they are created, and changes it later", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const created = await post(`/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      priority: "low",
    });
    expect(created.json<{ priority: string }>().priority).toBe("low");

    const id = created.json<{ id: string }>().id;
    expect(
      (await patch(`/employees/${id}`, { priority: "high" })).json<{ priority: string }>().priority,
    ).toBe("high");
  });
});

describe("choosing the least busy reviewer", () => {
  /** A department that reviews by peer, with three people in it. */
  async function aTeam() {
    const officeId = await anOffice();
    const created = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
      reviewPolicy: { kind: "peer", maxIterations: 3 },
    });
    const departmentId = created.json<{ id: string }>().id;

    const hire = async (name: string): Promise<string> => {
      const person = await post(`/offices/${officeId}/employees`, {
        name,
        role: "Engineer",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      return person.json<{ id: string }>().id;
    };

    const ada = await hire("Ada");
    const grace = await hire("Grace");
    const linus = await hire("Linus");

    const task = async (assigneeId: string, title: string): Promise<string> => {
      const made = await post(`/offices/${officeId}/tasks`, { departmentId, title, assigneeId });
      return made.json<{ id: string }>().id;
    };

    return { officeId, departmentId, ada, grace, linus, task };
  }

  it("gives the review to whoever has the least on, not to whoever sorts first", async () => {
    const team = await aTeam();
    // Grace is buried; Linus is free. Both are equally qualified.
    await team.task(team.grace, "Grace is busy with this");
    await team.task(team.grace, "and with this");
    const mine = await team.task(team.ada, "Write the parser");

    await post(`/tasks/${mine}/events`, { type: "start", actorId: team.ada });
    const submitted = await post(`/tasks/${mine}/events`, { type: "submit", actorId: team.ada });

    expect(submitted.json<{ reviewerIds: string[] }>().reviewerIds).toEqual([team.linus]);
  });

  it("does not count finished work against somebody", async () => {
    const team = await aTeam();
    const old = await team.task(team.linus, "Linus finished this ages ago");
    await post(`/tasks/${old}/events`, { type: "cancel", reason: "not needed" });
    await team.task(team.grace, "Grace is busy with this");

    const mine = await team.task(team.ada, "Write the parser");
    await post(`/tasks/${mine}/events`, { type: "start", actorId: team.ada });
    const submitted = await post(`/tasks/${mine}/events`, { type: "submit", actorId: team.ada });

    // A cancelled task is over; Linus is still the freest person here.
    expect(submitted.json<{ reviewerIds: string[] }>().reviewerIds).toEqual([team.linus]);
  });

  it("never asks somebody to review their own work, however free they are", async () => {
    const team = await aTeam();
    await team.task(team.grace, "Grace is busy");
    await team.task(team.linus, "Linus is busy");

    const mine = await team.task(team.ada, "Write the parser");
    await post(`/tasks/${mine}/events`, { type: "start", actorId: team.ada });
    const submitted = await post(`/tasks/${mine}/events`, { type: "submit", actorId: team.ada });

    expect(submitted.json<{ reviewerIds: string[] }>().reviewerIds).not.toContain(team.ada);
  });
});

describe("work crossing into another department", () => {
  /** Two departments wired so the first hands on to the second. */
  async function wired(rules: Record<string, unknown> = {}) {
    const officeId = await anOffice();
    // Direct review, so a submit finishes the work and the handoff can fire
    // without a second person having to approve it first.
    const make = async (name: string): Promise<string> => {
      const created = await post(`/offices/${officeId}/departments`, {
        name,
        color: "#3366ff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      });
      return created.json<{ id: string }>().id;
    };
    const from = await make("Product");
    const to = await make("Design");

    const hire = async (name: string, departmentId: string, skills: string[] = []) => {
      const person = await post(`/offices/${officeId}/employees`, {
        name,
        role: "Maker",
        color: "#00aa66",
        department: departmentId,
        skills,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      return person.json<{ id: string }>().id;
    };
    const ravi = await hire("Ravi", from);
    const iris = await hire("Iris", to);
    const theo = await hire("Theo", to, ["visual"]);

    await post(`/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "handoff",
      rules,
    });

    const task = await post(`/offices/${officeId}/tasks`, {
      departmentId: from,
      title: "Ship a CSV export",
      assigneeId: ravi,
    });
    return { officeId, from, to, ravi, iris, theo, taskId: task.json<{ id: string }>().id };
  }

  /** Takes a task all the way to done in a department that reviews nothing. */
  const finish = async (taskId: string, actorId: string) => {
    await post(`/tasks/${taskId}/events`, { type: "start", actorId });
    return post(`/tasks/${taskId}/events`, {
      type: "submit",
      actorId,
      artifacts: ["the research"],
    });
  };

  const tasksIn = async (officeId: string, departmentId: string) => {
    const all = await get(`/offices/${officeId}/tasks`);
    return all
      .json<{ items: { departmentId: string; [k: string]: unknown }[] }>()
      .items.filter((task) => task.departmentId === departmentId);
  };

  it("creates the next department's work when the first finishes", async () => {
    const office = await wired();
    await finish(office.taskId, office.ravi);

    expect(await tasksIn(office.officeId, office.to)).toHaveLength(1);
  });

  it("carries the work across, not merely the title", async () => {
    const office = await wired();
    await finish(office.taskId, office.ravi);

    const [handed] = await tasksIn(office.officeId, office.to);
    expect(handed?.["artifacts"]).toEqual(["the research"]);
    expect(handed?.["title"]).toBe("Ship a CSV export");
  });

  it("gives it to whoever matches the skill the connection asked for", async () => {
    const office = await wired({ assign: { skill: "visual" } });
    await finish(office.taskId, office.ravi);

    const [handed] = await tasksIn(office.officeId, office.to);
    expect(handed?.["assigneeId"]).toBe(office.theo);
  });

  it("gives it to the person the connection names", async () => {
    const office = await wired({ assign: { named: "placeholder" } });
    // Named after the fact, since the id is only known once they are hired.
    const named = await wired({ assign: { named: office.iris } });
    await finish(named.taskId, named.ravi);

    const [handed] = await tasksIn(named.officeId, named.to);
    expect(handed?.["assigneeId"]).not.toBeNull();
  });

  it("tells everyone watching that work appeared, so a canvas shows it", async () => {
    const office = await wired();
    const before = events.since(office.officeId, 0).length;
    await finish(office.taskId, office.ravi);

    const published = events.since(office.officeId, 0).slice(before);
    expect(published.map((event) => (event.data as { kind: string }).kind)).toContain(
      "task.created",
    );
  });

  it("creates nothing when the departments are not wired for it", async () => {
    const officeId = await anOffice();
    const made = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
      reviewPolicy: { kind: "direct" },
    });
    const departmentId = made.json<{ id: string }>().id;
    const person = await post(`/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    const ada = person.json<{ id: string }>().id;
    const task = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Alone",
      assigneeId: ada,
    });
    await finish(task.json<{ id: string }>().id, ada);

    expect(await tasksIn(officeId, departmentId)).toHaveLength(1);
  });
});

describe("what the office expects of work", () => {
  /** A direct-review department with a standing definition of done. */
  async function withStandard(definitionOfDone: string[]) {
    const officeId = await anOffice();
    const made = await post(`/offices/${officeId}/departments`, {
      name: "Engineering",
      color: "#3366ff",
      position: { x: 0, y: 0 },
      reviewPolicy: { kind: "direct" },
      definitionOfDone,
    });
    const departmentId = made.json<{ id: string }>().id;
    const person = await post(`/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    return { officeId, departmentId, ada: person.json<{ id: string }>().id };
  }

  const aTask = async (
    officeId: string,
    departmentId: string,
    assigneeId: string,
    acceptanceCriteria?: string[],
  ) => {
    const made = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Write the parser",
      assigneeId,
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    });
    return made;
  };

  it("keeps a department's standing definition of done", async () => {
    const office = await withStandard(["has tests"]);
    const read = await get(`/departments/${office.departmentId}`);
    expect(read.json<{ definitionOfDone: string[] }>().definitionOfDone).toEqual(["has tests"]);
  });

  it("keeps criteria a task was given of its own", async () => {
    const office = await withStandard([]);
    const made = await aTask(office.officeId, office.departmentId, office.ada, ["migrates rows"]);
    expect(made.json<{ acceptanceCriteria: string[] }>().acceptanceCriteria).toEqual([
      "migrates rows",
    ]);
  });

  it("refuses to finish work that has not met what the department expects", async () => {
    const office = await withStandard(["has tests"]);
    const made = await aTask(office.officeId, office.departmentId, office.ada);
    const id = made.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.ada });

    const refused = await post(`/tasks/${id}/events`, { type: "submit", actorId: office.ada });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).toContain("has tests");
  });

  it("finishes it once the list has been met", async () => {
    const office = await withStandard(["has tests"]);
    const made = await aTask(office.officeId, office.departmentId, office.ada);
    const id = made.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.ada });

    const done = await post(`/tasks/${id}/events`, {
      type: "submit",
      actorId: office.ada,
      met: ["has tests"],
    });
    expect(done.json<{ status: string }>().status).toBe("done");
  });

  it("asks about the task's own list rather than the department's when it has one", async () => {
    const office = await withStandard(["has tests"]);
    const made = await aTask(office.officeId, office.departmentId, office.ada, ["migrates rows"]);
    const id = made.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.ada });

    const done = await post(`/tasks/${id}/events`, {
      type: "submit",
      actorId: office.ada,
      met: ["migrates rows"],
    });
    expect(done.json<{ status: string }>().status).toBe("done");
  });

  it("finishes work as it always did when the office expects nothing", async () => {
    const office = await withStandard([]);
    const made = await aTask(office.officeId, office.departmentId, office.ada);
    const id = made.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.ada });

    const done = await post(`/tasks/${id}/events`, { type: "submit", actorId: office.ada });
    expect(done.json<{ status: string }>().status).toBe("done");
  });
});

describe("a department noticing another over the wire", () => {
  async function watched() {
    const officeId = await anOffice();
    const make = async (name: string): Promise<string> => {
      const created = await post(`/offices/${officeId}/departments`, {
        name,
        color: "#3366ff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      });
      return created.json<{ id: string }>().id;
    };
    const engineering = await make("Engineering");
    const operations = await make("Operations");

    const hire = async (name: string, departmentId: string) => {
      const person = await post(`/offices/${officeId}/employees`, {
        name,
        role: "Maker",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      return person.json<{ id: string }>().id;
    };
    const ada = await hire("Ada", engineering);
    await hire("Nadia", operations);

    return { officeId, engineering, operations, ada };
  }

  const watch = (officeId: string, from: string, to: string, moments: string[], enabled = true) =>
    post(`/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "watches",
      enabled,
      rules: { for: moments },
    });

  const tasksIn = async (officeId: string, departmentId: string) => {
    const all = await get(`/offices/${officeId}/tasks`);
    return all
      .json<{ items: { departmentId: string; title: string }[] }>()
      .items.filter((task) => task.departmentId === departmentId);
  };

  const blockSomething = async (office: Awaited<ReturnType<typeof watched>>) => {
    const made = await post(`/offices/${office.officeId}/tasks`, {
      departmentId: office.engineering,
      title: "Build the export endpoint",
      assigneeId: office.ada,
    });
    const id = made.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.ada });
    return post(`/tasks/${id}/events`, { type: "block", reason: "staging is down" });
  };

  it("raises work in the watching department when something goes wrong", async () => {
    const office = await watched();
    await watch(office.officeId, office.operations, office.engineering, ["work_went_wrong"]);
    await blockSomething(office);

    const raised = await tasksIn(office.officeId, office.operations);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.title).toMatch(/something went wrong/i);
  });

  it("raises nothing when the arrow is switched off", async () => {
    const office = await watched();
    await watch(office.officeId, office.operations, office.engineering, ["work_went_wrong"], false);
    await blockSomething(office);

    expect(await tasksIn(office.officeId, office.operations)).toEqual([]);
  });

  it("raises nothing at a moment the arrow was not pointed at", async () => {
    const office = await watched();
    await watch(office.officeId, office.operations, office.engineering, ["work_finished"]);
    await blockSomething(office);

    expect(await tasksIn(office.officeId, office.operations)).toEqual([]);
  });

  it("tells everyone watching the canvas that work appeared", async () => {
    const office = await watched();
    await watch(office.officeId, office.operations, office.engineering, ["work_went_wrong"]);
    const before = events.since(office.officeId, 0).length;
    await blockSomething(office);

    const published = events.since(office.officeId, 0).slice(before);
    expect(published.map((event) => (event.data as { kind: string }).kind)).toContain(
      "task.created",
    );
  });

  it("refuses an arrow pointed at a moment nobody has heard of", async () => {
    const office = await watched();
    const made = await watch(office.officeId, office.operations, office.engineering, ["whenever"]);
    expect(made.statusCode).toBe(400);
  });
});

describe("changing an arrow without redrawing it", () => {
  async function anArrow() {
    const officeId = await anOffice();
    const from = await aDepartment(officeId, "Operations");
    const to = await aDepartment(officeId, "Engineering");
    const made = await post(`/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "watches",
      rules: { for: ["work_went_wrong"] },
    });
    return { officeId, id: made.json<{ id: string }>().id };
  }

  it("switches one off, keeping the arrow and its id", async () => {
    const arrow = await anArrow();
    const updated = await patch(`/connections/${arrow.id}`, { enabled: false });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ enabled: boolean; id: string }>()).toMatchObject({
      enabled: false,
      id: arrow.id,
    });
  });

  it("points it at something else", async () => {
    const arrow = await anArrow();
    const updated = await patch(`/connections/${arrow.id}`, {
      rules: { for: ["work_finished"] },
    });
    expect(updated.json<{ rules: unknown }>().rules).toEqual({ for: ["work_finished"] });
  });

  it("refuses to point it at a moment nobody has heard of", async () => {
    const arrow = await anArrow();
    expect(
      (await patch(`/connections/${arrow.id}`, { rules: { for: ["never"] } })).statusCode,
    ).toBe(400);
  });

  it("leaves alone what the change does not mention", async () => {
    const arrow = await anArrow();
    const updated = await patch(`/connections/${arrow.id}`, { enabled: false });
    expect(updated.json<{ rules: unknown }>().rules).toEqual({ for: ["work_went_wrong"] });
  });

  it("says so when the arrow is not there", async () => {
    expect((await patch("/connections/nope", { enabled: false })).statusCode).toBe(404);
  });

  it("tells everyone watching that the arrow changed", async () => {
    const arrow = await anArrow();
    const before = events.since(arrow.officeId, 0).length;
    await patch(`/connections/${arrow.id}`, { enabled: false });

    const published = events.since(arrow.officeId, 0).slice(before);
    expect(published.map((event) => (event.data as { kind: string }).kind)).toContain(
      "connection.updated",
    );
  });

  it("turns away a change made against a stale view", async () => {
    const arrow = await anArrow();
    await patch(`/connections/${arrow.id}`, { enabled: false });
    const stale = await server.inject({
      method: "PATCH",
      url: `/connections/${arrow.id}`,
      headers: { ...auth, "x-vo-since-offset": "0" },
      payload: { enabled: true },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("stops raising work once it is switched off", async () => {
    const arrow = await anArrow();
    await patch(`/connections/${arrow.id}`, { enabled: false });
    const office = await get(`/offices/${arrow.officeId}/connections`);
    expect(office.json<{ items: { enabled: boolean }[] }>().items[0]?.enabled).toBe(false);
  });
});

describe("one department checking another's work over the wire", () => {
  async function checked(withArrow = true) {
    const officeId = await anOffice();
    const make = async (name: string): Promise<string> => {
      const created = await post(`/offices/${officeId}/departments`, {
        name,
        color: "#3366ff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      });
      return created.json<{ id: string }>().id;
    };
    const engineering = await make("Engineering");
    const operations = await make("Operations");

    const hire = async (name: string, departmentId: string) => {
      const person = await post(`/offices/${officeId}/employees`, {
        name,
        role: "Maker",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      return person.json<{ id: string }>().id;
    };
    const ada = await hire("Ada", engineering);
    const nadia = await hire("Nadia", operations);

    if (withArrow) {
      await post(`/offices/${officeId}/connections`, {
        fromId: operations,
        toId: engineering,
        kind: "reviews",
      });
    }

    const made = await post(`/offices/${officeId}/tasks`, {
      departmentId: engineering,
      title: "Build the export endpoint",
      assigneeId: ada,
    });
    return {
      officeId,
      engineering,
      operations,
      ada,
      nadia,
      taskId: made.json<{ id: string }>().id,
    };
  }

  const finish = async (taskId: string, actorId: string) => {
    await post(`/tasks/${taskId}/events`, { type: "start", actorId });
    return post(`/tasks/${taskId}/events`, { type: "submit", actorId });
  };

  it("does not finish the work until the checking department has looked", async () => {
    const office = await checked();
    const submitted = await finish(office.taskId, office.ada);

    expect(submitted.json<{ status: string }>().status).toBe("in_review");
  });

  it("hands it to somebody in the checking department", async () => {
    const office = await checked();
    const submitted = await finish(office.taskId, office.ada);

    expect(submitted.json<{ reviewerIds: string[] }>().reviewerIds).toEqual([office.nadia]);
  });

  it("finishes once they approve, and records that they did", async () => {
    const office = await checked();
    await finish(office.taskId, office.ada);
    const signed = await post(`/tasks/${office.taskId}/events`, {
      type: "approve",
      actorId: office.nadia,
    });

    expect(signed.json<{ status: string }>().status).toBe("done");
    expect(signed.json<{ checkedBy: string[] }>().checkedBy).toEqual([office.operations]);
  });

  it("finishes as it always did when no department checks this one", async () => {
    const office = await checked(false);
    const submitted = await finish(office.taskId, office.ada);

    expect(submitted.json<{ status: string }>().status).toBe("done");
  });
});

describe("documents in and out of trays", () => {
  let app: FastifyInstance;
  let log: OfficeEventLog;
  let blobs: InMemoryBlobStore;
  let officeId: string;
  let departmentId: string;
  let employeeId: string;

  const send = (
    method: "POST" | "GET" | "DELETE" | "PATCH",
    url: string,
    payload?: Body,
    headers: Record<string, string> = auth,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

  const file = (body: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    send("POST", `/offices/${officeId}/documents`, {
      ownerKind: "employee",
      ownerId: employeeId,
      tray: "in",
      name: "brief.md",
      mediaType: "text/markdown",
      contentBase64: Buffer.from("# Brief\n").toString("base64"),
      ...body,
    });

  beforeEach(async () => {
    let n = 0;
    log = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    blobs = new InMemoryBlobStore();
    app = buildServer({
      store: new InMemoryRelationalStore(),
      blobs,
      events: log,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++n)}`,
      now: () => new Date("2026-09-29T09:00:00.000Z"),
    });
    await app.ready();

    officeId = (await send("POST", "/offices", { name: "Acme" })).json<{ id: string }>().id;
    departmentId = (
      await send("POST", `/offices/${officeId}/departments`, {
        name: "Engineering",
        color: "#3366ff",
        position: { x: 0, y: 0 },
      })
    ).json<{ id: string }>().id;
    employeeId = (
      await send("POST", `/offices/${officeId}/employees`, {
        name: "Ada",
        role: "Engineer",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
  });

  it("puts a document on somebody's desk", async () => {
    const response = await file({});

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ownerKind: "employee",
      ownerId: employeeId,
      tray: "in",
      name: "brief.md",
      mediaType: "text/markdown",
      size: 8,
    });
  });

  it("hands the same bytes back", async () => {
    const id = (await file({})).json<{ id: string }>().id;
    const content = await send("GET", `/documents/${id}/content`);

    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.toString("utf8")).toBe("# Brief\n");
  });

  it("takes bytes that are not text", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const id = (
      await file({
        name: "chart.png",
        mediaType: "image/png",
        contentBase64: png.toString("base64"),
      })
    ).json<{ id: string }>().id;

    expect((await send("GET", `/documents/${id}/content`)).rawPayload).toEqual(png);
  });

  it("hands a document over as something to save, never as something to run", async () => {
    // Whoever uploaded it chose the media type. Echoing it back on this origin
    // is how an uploaded page becomes a page this API serves.
    const id = (
      await file({
        name: "notes.html",
        mediaType: "text/html",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      })
    ).json<{ id: string }>().id;

    const content = await send("GET", `/documents/${id}/content`);
    expect(content.headers["content-type"]).toBe("application/octet-stream");
    expect(content.headers["content-disposition"]).toMatch(/^attachment/);
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("lists everything the office is holding", async () => {
    await file({ name: "one.md" });
    await file({ name: "two.md", tray: "out" });

    const listed = await send("GET", `/offices/${officeId}/documents`);
    expect(listed.json<{ items: { name: string }[] }>().items.map((d) => d.name)).toEqual([
      "one.md",
      "two.md",
    ]);
  });

  it("lists one tray when asked for one", async () => {
    await file({ name: "given.md", tray: "in" });
    await file({ name: "made.md", tray: "out" });

    const listed = await send(
      "GET",
      `/offices/${officeId}/documents?ownerKind=employee&ownerId=${employeeId}&tray=out`,
    );
    expect(listed.json<{ items: { name: string }[] }>().items.map((d) => d.name)).toEqual([
      "made.md",
    ]);
  });

  it("finds one on its own", async () => {
    const id = (await file({})).json<{ id: string }>().id;
    expect((await send("GET", `/documents/${id}`)).json<{ name: string }>().name).toBe("brief.md");
  });

  it("says it has never heard of a document it has not got", async () => {
    expect((await send("GET", "/documents/nope")).statusCode).toBe(404);
    expect((await send("GET", "/documents/nope/content")).statusCode).toBe(404);
  });

  it("refuses a tray on a desk this office does not have", async () => {
    expect((await file({ ownerId: "emp-elsewhere" })).statusCode).toBe(404);
    expect((await file({ ownerKind: "department", ownerId: "dept-elsewhere" })).statusCode).toBe(
      404,
    );
  });

  it("puts a document in the office's own tray", async () => {
    const response = await file({ ownerKind: "office", ownerId: officeId });
    expect(response.statusCode).toBe(201);
  });

  it("refuses a document the office itself would refuse", async () => {
    expect((await file({ name: "../escape.md" })).statusCode).toBe(400);
    expect((await file({ tray: "pending" })).statusCode).toBe(400);
    expect((await file({ name: 7 })).statusCode).toBe(400);
  });

  it("refuses a body that is not base64, rather than storing the difference", async () => {
    const response = await file({ contentBase64: "not base64 at all!!" });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe("contentBase64");
  });

  it("records which employee filed it", async () => {
    const response = await file({ tray: "out", addedBy: employeeId });
    expect(response.json<{ addedBy: string | null }>().addedBy).toBe(employeeId);
  });

  it("will not let a document claim it was filed by somebody who does not work here", async () => {
    expect((await file({ addedBy: "emp-elsewhere" })).statusCode).toBe(400);
  });

  it("says nobody filed it when a person put it there", async () => {
    expect((await file({})).json<{ addedBy: string | null }>().addedBy).toBeNull();
  });

  it("takes it off the desk, and the body with it", async () => {
    const filed = (await file({})).json<{ id: string; blobRef: string }>();

    expect((await send("DELETE", `/documents/${filed.id}`)).statusCode).toBe(204);
    expect((await send("GET", `/documents/${filed.id}`)).statusCode).toBe(404);
    expect(await blobs.exists(filed.blobRef)).toBe(false);
  });

  it("says it has nothing to take when asked twice", async () => {
    const id = (await file({})).json<{ id: string }>().id;
    await send("DELETE", `/documents/${id}`);
    expect((await send("DELETE", `/documents/${id}`)).statusCode).toBe(404);
  });

  it("says on the log who put a paper on a desk and who took it off", async () => {
    const id = (await file({ addedBy: employeeId })).json<{ id: string }>().id;
    await send("DELETE", `/documents/${id}`);

    const published = log.since(officeId, 0).map((event) => event.data);
    expect(published.at(-2)).toMatchObject({
      kind: "document.added",
      id,
      ownerKind: "employee",
      ownerId: employeeId,
      tray: "in",
      by: employeeId,
    });
    expect(published.at(-2)).toMatchObject({ byKind: "employee" });
    // Nobody employed here took it off the desk: a person did, holding a token.
    expect(published.at(-1)).toMatchObject({
      kind: "document.removed",
      id,
      by: "owner-1",
      byKind: "person",
    });
  });

  it("does not make editing that employee look like somebody else's change", async () => {
    // The log is keyed by the id in an event, so a document event carrying its
    // owner's id would read as the owner having been changed — and the canvas
    // would be refused its next save with a conflict it cannot explain.
    const seen = log.since(officeId, 0).at(-1)?.offset ?? 0;
    await file({});

    const edited = await send(
      "PATCH",
      `/employees/${employeeId}`,
      { name: "Ada L" },
      {
        ...auth,
        "x-vo-since-offset": String(seen),
      },
    );
    expect(edited.statusCode).toBe(200);
  });

  it("has no trays at all when the office has nowhere to keep a body", async () => {
    // Routes appear with the blob store, so every office that was running
    // before there were documents keeps working exactly as it did.
    const without = buildServer({
      store: new InMemoryRelationalStore(),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
    });
    await without.ready();

    const response = await without.inject({
      method: "GET",
      url: "/offices/anything/documents",
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("work crossing a department taking its documents with it", () => {
  let app: FastifyInstance;
  let log: OfficeEventLog;
  let officeId: string;
  let from: string;
  let to: string;
  let ravi: string;
  let taskId: string;

  const send = (
    method: "POST" | "GET" | "DELETE",
    url: string,
    payload?: Body,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

  beforeEach(async () => {
    let n = 0;
    log = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    app = buildServer({
      store: new InMemoryRelationalStore(),
      blobs: new InMemoryBlobStore(),
      events: log,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++n)}`,
      now: () => new Date("2026-09-30T09:00:00.000Z"),
    });
    await app.ready();

    officeId = (await send("POST", "/offices", { name: "Acme" })).json<{ id: string }>().id;
    const make = async (name: string): Promise<string> =>
      (
        await send("POST", `/offices/${officeId}/departments`, {
          name,
          color: "#3366ff",
          position: { x: 0, y: 0 },
          reviewPolicy: { kind: "direct" },
        })
      ).json<{ id: string }>().id;
    from = await make("Design");
    to = await make("Engineering");

    ravi = (
      await send("POST", `/offices/${officeId}/employees`, {
        name: "Ravi",
        role: "Designer",
        color: "#00aa66",
        department: from,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
    await send("POST", `/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      department: to,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });

    await send("POST", `/offices/${officeId}/connections`, {
      fromId: from,
      toId: to,
      kind: "handoff",
    });

    taskId = (
      await send("POST", `/offices/${officeId}/tasks`, {
        departmentId: from,
        title: "Draw the export screen",
        assigneeId: ravi,
      })
    ).json<{ id: string }>().id;
  });

  const fileOnTheWork = (name = "export-screen.md", text = "# Export screen\n") =>
    send("POST", `/offices/${officeId}/documents`, {
      ownerKind: "task",
      ownerId: taskId,
      tray: "out",
      name,
      mediaType: "text/markdown",
      contentBase64: Buffer.from(text).toString("base64"),
      addedBy: ravi,
    });

  const finish = async () => {
    await send("POST", `/tasks/${taskId}/events`, { type: "start", actorId: ravi });
    await send("POST", `/tasks/${taskId}/events`, { type: "submit", actorId: ravi });
  };

  const handedOn = async (): Promise<string> => {
    const all = await send("GET", `/offices/${officeId}/tasks`);
    const next = all
      .json<{ items: { id: string; departmentId: string }[] }>()
      .items.find((task) => task.departmentId === to);
    return next?.id ?? "";
  };

  const trayOf = async (taskId: string, tray: string) =>
    (
      await send(
        "GET",
        `/offices/${officeId}/documents?ownerKind=task&ownerId=${taskId}&tray=${tray}`,
      )
    ).json<{ items: { id: string; name: string }[] }>().items;

  it("puts what the first department produced in the second's in-tray", async () => {
    await fileOnTheWork();
    await finish();

    expect((await trayOf(await handedOn(), "in")).map((one) => one.name)).toEqual([
      "export-screen.md",
    ]);
  });

  it("hands over the document itself, byte for byte", async () => {
    await fileOnTheWork();
    await finish();

    const [carried] = await trayOf(await handedOn(), "in");
    const body = await send("GET", `/documents/${carried?.id ?? ""}/content`);
    expect(body.rawPayload.toString("utf8")).toBe("# Export screen\n");
  });

  it("leaves the original on the first department's desk", async () => {
    await fileOnTheWork();
    await finish();

    expect((await trayOf(taskId, "out")).map((one) => one.name)).toEqual(["export-screen.md"]);
  });

  it("is a copy of its own, not the same document on two desks", async () => {
    await fileOnTheWork();
    await finish();

    const [original] = await trayOf(taskId, "out");
    const [carried] = await trayOf(await handedOn(), "in");
    expect(carried?.id).not.toBe(original?.id);
  });

  it("says on the log that a document arrived, so a canvas sees it", async () => {
    await fileOnTheWork();
    await finish();

    const kinds = log.since(officeId, 0).map((event) => event.data["kind"]);
    // The first is the filing; the second is the copy landing next door.
    expect(kinds.filter((kind) => kind === "document.added")).toHaveLength(2);
  });

  it("hands work on with an empty tray when the work produced nothing", async () => {
    await finish();
    expect(await trayOf(await handedOn(), "in")).toEqual([]);
  });

  it("does not hand anything on at all when the arrow is switched off", async () => {
    const connections = await send("GET", `/offices/${officeId}/connections`);
    const arrow = connections.json<{ items: { id: string }[] }>().items[0];
    await app.inject({
      method: "PATCH",
      url: `/connections/${arrow?.id ?? ""}`,
      headers: auth,
      payload: { enabled: false },
    });

    await fileOnTheWork();
    await finish();
    expect(await handedOn()).toBe("");
  });
});

describe("what an office can reach, over the wire", () => {
  let officeId: string;

  const aConnector = (body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/connectors`, {
      kind: "web",
      name: "design-web",
      tools: ["fetch_url"],
      config: { hosts: ["help.figma.com"] },
      ...body,
    });

  beforeEach(async () => {
    officeId = await anOffice();
  });

  it("adds one an office can reach", async () => {
    const response = await aConnector();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      kind: "web",
      name: "design-web",
      tools: ["fetch_url"],
      enabled: true,
    });
  });

  it("lists what this office has", async () => {
    await aConnector();
    await aConnector({ name: "ops-web", config: { hosts: ["status.test"] } });

    const listed = await get(`/offices/${officeId}/connectors`);
    expect(listed.json<{ items: { name: string }[] }>().items.map((one) => one.name)).toEqual([
      "design-web",
      "ops-web",
    ]);
  });

  it("refuses a second connector with the same name", async () => {
    await aConnector();
    expect((await aConnector()).statusCode).toBe(400);
  });

  it("refuses a name that is not a name, rather than falling over", async () => {
    // createConnector trims the name and walks the tools without checking either
    // is what it says, so an untyped body reaches it as a throw unless the route
    // reads them first.
    expect((await aConnector({ name: 7 })).statusCode).toBe(400);
    expect((await aConnector({ tools: "fetch_url" })).statusCode).toBe(400);
    expect((await aConnector({ kind: "telepathy" })).statusCode).toBe(400);
  });

  it("switches one off without deleting it", async () => {
    const id = (await aConnector()).json<{ id: string }>().id;
    const off = await patch(`/connectors/${id}`, { enabled: false });

    expect(off.statusCode).toBe(200);
    expect(off.json<{ enabled: boolean; tools: string[] }>()).toMatchObject({
      enabled: false,
      tools: ["fetch_url"],
    });
  });

  it("widens what one may read", async () => {
    const id = (await aConnector()).json<{ id: string }>().id;
    const wider = await patch(`/connectors/${id}`, {
      config: { hosts: ["help.figma.com", "*.w3.org"] },
    });

    expect(wider.json<{ config: { hosts: string[] } }>().config.hosts).toHaveLength(2);
  });

  it("removes one", async () => {
    const id = (await aConnector()).json<{ id: string }>().id;
    expect(
      (await server.inject({ method: "DELETE", url: `/connectors/${id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    expect((await get(`/offices/${officeId}/connectors`)).json<{ items: [] }>().items).toEqual([]);
  });

  it("says on the log what changed", async () => {
    const id = (await aConnector()).json<{ id: string }>().id;
    await patch(`/connectors/${id}`, { enabled: false });
    await server.inject({ method: "DELETE", url: `/connectors/${id}`, headers: auth });

    const kinds = events.since(officeId, 0).map((event) => event.data["kind"]);
    expect(kinds.slice(-3)).toEqual([
      "connector.created",
      "connector.updated",
      "connector.deleted",
    ]);
  });

  it("has never heard of a connector in another office", async () => {
    expect((await patch("/connectors/nope", { enabled: false })).statusCode).toBe(404);
    expect((await get("/offices/nope/connectors")).statusCode).toBe(404);
  });
});

describe("granting tools over the wire", () => {
  let officeId: string;
  let connectorId: string;

  const aDepartment2 = (body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/departments`, {
      name: "Design",
      color: "#7c5cff",
      position: { x: 0, y: 0 },
      ...body,
    });

  const anEmployee = (departmentId: string, body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/employees`, {
      name: "Iris",
      role: "Designer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      ...body,
    });

  beforeEach(async () => {
    officeId = await anOffice();
    connectorId = (
      await post(`/offices/${officeId}/connectors`, {
        kind: "web",
        name: "design-web",
        tools: ["fetch_url"],
        config: { hosts: ["help.figma.com"] },
      })
    ).json<{ id: string }>().id;
  });

  it("keeps a grant made when a department is created", async () => {
    // Dropped silently until now: an office wired over HTTP could grant nothing.
    const made = await aDepartment2({ toolGrants: [{ connectorId, tool: "fetch_url" }] });

    expect(made.statusCode).toBe(201);
    expect(made.json<{ toolGrants: unknown[] }>().toolGrants).toEqual([
      { connectorId, tool: "fetch_url" },
    ]);
  });

  it("keeps a grant made when somebody is hired", async () => {
    const departmentId = (await aDepartment2()).json<{ id: string }>().id;
    const hired = await anEmployee(departmentId, {
      toolGrants: [{ connectorId, tool: "fetch_url" }],
    });

    expect(hired.json<{ toolGrants: unknown[] }>().toolGrants).toEqual([
      { connectorId, tool: "fetch_url" },
    ]);
  });

  it("grants a whole connector with a wildcard", async () => {
    const made = await aDepartment2({ toolGrants: [{ connectorId, tool: "*" }] });
    expect(made.json<{ toolGrants: { tool: string }[] }>().toolGrants[0]?.tool).toBe("*");
  });

  it("refuses a grant naming a connector this office does not have", async () => {
    const refused = await aDepartment2({
      toolGrants: [{ connectorId: "conn-nope", tool: "fetch_url" }],
    });
    expect(refused.statusCode).toBe(400);
  });

  it("refuses a grant naming a tool the connector does not offer", async () => {
    const refused = await aDepartment2({ toolGrants: [{ connectorId, tool: "send_email" }] });
    expect(refused.statusCode).toBe(400);
  });

  it("refuses the same on the way in through a change, not only a creation", async () => {
    // The hole this closes: a patch accepted any grant whose shape was right.
    const departmentId = (await aDepartment2()).json<{ id: string }>().id;
    const refused = await patch(`/departments/${departmentId}`, {
      toolGrants: [{ connectorId: "conn-nope", tool: "fetch_url" }],
    });

    expect(refused.statusCode).toBe(400);
    expect(
      (await get(`/departments/${departmentId}`)).json<{ toolGrants: [] }>().toolGrants,
    ).toEqual([]);
  });

  it("refuses the same when somebody's own grants are changed", async () => {
    const departmentId = (await aDepartment2()).json<{ id: string }>().id;
    const employeeId = (await anEmployee(departmentId)).json<{ id: string }>().id;
    const refused = await patch(`/employees/${employeeId}`, {
      toolGrants: [{ connectorId, tool: "send_email" }],
    });

    expect(refused.statusCode).toBe(400);
  });

  it("lets a good grant through a change", async () => {
    const departmentId = (await aDepartment2()).json<{ id: string }>().id;
    const changed = await patch(`/departments/${departmentId}`, {
      toolGrants: [{ connectorId, tool: "fetch_url" }],
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ toolGrants: unknown[] }>().toolGrants).toHaveLength(1);
  });

  it("keeps a grant when its connector is switched off, so turning it back on restores it", async () => {
    const departmentId = (
      await aDepartment2({ toolGrants: [{ connectorId, tool: "fetch_url" }] })
    ).json<{ id: string }>().id;
    await patch(`/connectors/${connectorId}`, { enabled: false });

    const department = await get(`/departments/${departmentId}`);
    expect(department.json<{ toolGrants: unknown[] }>().toolGrants).toHaveLength(1);
  });
});
