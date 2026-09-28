import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRelationalStore } from "@vo/storage";
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
