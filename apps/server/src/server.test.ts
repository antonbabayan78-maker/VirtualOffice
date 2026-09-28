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
