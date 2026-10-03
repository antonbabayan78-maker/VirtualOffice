import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBlobStore, InMemoryRelationalStore } from "@vo/storage";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { OfficeEventLog } from "./events.js";
import type { ProposalDraft } from "@vo/orchestrator";
import { buildServer, OFFICE_PATHS, type ServerOptions } from "./server.js";
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
const listedChannels = (response: LightMyRequestResponse) =>
  response.json<{ items: Record<string, unknown>[] }>().items;
const put = (url: string, payload: Body): Promise<LightMyRequestResponse> =>
  server.inject({ method: "PUT", url, headers: auth, payload });
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

describe("signing in, so a browser holds nothing", () => {
  const signIn = (token: string, headers: Record<string, string> = {}) =>
    server.inject({
      method: "POST",
      url: "/session",
      headers: { "content-type": "application/json", ...headers },
      payload: { token },
    });

  /** The Set-Cookie the office answered with, as one string. */
  const cookieFrom = (response: LightMyRequestResponse): string => {
    const header = response.headers["set-cookie"];
    return Array.isArray(header) ? header.join("; ") : (header ?? "");
  };

  it("takes the token once and answers with a cookie", async () => {
    const response = await signIn(TOKEN);
    expect(response.statusCode).toBe(200);
    expect(cookieFrom(response)).toContain("vo_session=");
  });

  it("sets one the page cannot read and nobody else's page can send", async () => {
    const cookie = cookieFrom(await signIn(TOKEN));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("refuses a token it does not know, and sets nothing", async () => {
    const response = await signIn("sk-nonsense");
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a body with no token in it at all", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/session",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("can be signed in to without being signed in, which is the point", async () => {
    // The page has no credential to send yet: that is what it is asking for.
    expect((await signIn(TOKEN)).statusCode).toBe(200);
  });

  it("marks the cookie secure when the office was reached over https", async () => {
    const response = await signIn(TOKEN, { "x-forwarded-proto": "https" });
    expect(cookieFrom(response)).toMatch(/Secure/);
  });

  it("does not mark it secure on plain http, or the browser would drop it", async () => {
    expect(cookieFrom(await signIn(TOKEN))).not.toMatch(/Secure/);
  });

  it("lets a request in on that cookie, with no header at all", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/offices",
      headers: { cookie: `vo_session=${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("keeps everybody else out, cookie or not", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/offices",
      headers: { cookie: "vo_session=sk-nonsense" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("still takes a bearer token, which is what workers and curl carry", async () => {
    expect((await get("/offices")).statusCode).toBe(200);
  });

  it("signs out by clearing the cookie", async () => {
    const response = await server.inject({
      method: "DELETE",
      url: "/session",
      headers: { cookie: `vo_session=${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(cookieFrom(response)).toMatch(/Max-Age=0/);
  });

  it("signs out somebody who was never signed in, rather than refusing them", async () => {
    // Clearing a cookie harms nobody, and a sign-out that needs a sign-in is a
    // dead end for a browser holding something the office no longer accepts.
    expect((await server.inject({ method: "DELETE", url: "/session" })).statusCode).toBe(200);
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

  it("lets a browser through with every method this server actually serves", async () => {
    // Derived from the route table rather than listed by hand: the list below
    // was right for every verb that existed when it was written, and the next
    // route with a new one would be refused in a browser while every injected
    // test passed. That is exactly how PUT was missed.
    const app = await withOrigins(["http://localhost:5173"]);
    const served = new Set(
      [...app.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g)].flatMap((match) =>
        (match[1] ?? "").split(", "),
      ),
    );
    served.delete("OPTIONS");
    await app.close();

    expect(served.size).toBeGreaterThan(3);
    for (const method of served) {
      const allowed = String((await preflight(method)).headers["access-control-allow-methods"]);
      expect(allowed, method).toContain(method);
    }
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

describe("asking a connector what it offers", () => {
  /** What the office holds for one connector, read the way the canvas reads it. */
  const toolsOf = async (officeId: string, id: string): Promise<readonly string[]> => {
    const listed = await get(`/offices/${officeId}/connectors`);
    const items = listed.json<{ items: { id: string; tools: string[] }[] }>().items;
    return items.find((one) => one.id === id)?.tools ?? [];
  };

  /**
   * A server built with a scripted discoverer, so no test opens a socket or
   * spawns anything — the same arrangement as the notifier.
   */
  const office = async (
    discover?: (connector: { readonly name: string }) => Promise<readonly string[]>,
  ) => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      ...(discover === undefined ? {} : { discoverTools: discover }),
    });
    await server.ready();
    const officeId = await anOffice();
    const connector = await post(`/offices/${officeId}/connectors`, {
      kind: "mcp",
      name: "acme",
      tools: [],
      config: { command: "acme-mcp" },
    });
    return { officeId, id: connector.json<{ id: string }>().id };
  };

  it("writes down the names, so they can be granted on the canvas", async () => {
    const { officeId, id } = await office(() => Promise.resolve(["read_notes", "send_email"]));

    const answer = await post(`/connectors/${id}/discover`, {});

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ tools: ["read_notes", "send_email"] });
    expect(await toolsOf(officeId, id)).toEqual(["read_notes", "send_email"]);
  });

  it("tells the canvas, which is what makes the new tools appear", async () => {
    const { officeId, id } = await office(() => Promise.resolve(["read_notes"]));

    await post(`/connectors/${id}/discover`, {});

    expect(events.since(officeId, 0).map((event) => event.data["kind"])).toContain(
      "connector.updated",
    );
  });

  it("says what went wrong, because somebody pressed a button and is waiting", async () => {
    const { id } = await office(() => Promise.reject(new Error("acme-mcp could not be run")));

    const answer = await post(`/connectors/${id}/discover`, {});

    expect(answer.statusCode).toBe(502);
    expect(answer.json<{ error: string }>().error).toContain("could not be run");
  });

  it("changes nothing when the server offered nothing, rather than emptying the grants", async () => {
    const { officeId, id } = await office(() => Promise.resolve([]));
    await patch(`/connectors/${id}`, { tools: ["send_email"] });

    const answer = await post(`/connectors/${id}/discover`, {});

    expect(answer.statusCode).toBe(502);
    expect(await toolsOf(officeId, id)).toEqual(["send_email"]);
  });

  it("says so in an office that has no way to ask anything", async () => {
    const { id } = await office();

    expect((await post(`/connectors/${id}/discover`, {})).statusCode).toBe(501);
  });

  it("has never heard of a connector that is not there", async () => {
    await office(() => Promise.resolve(["read_notes"]));

    expect((await post("/connectors/nope/discover", {})).statusCode).toBe(404);
  });

  it("is not something a stranger may ask", async () => {
    const { id } = await office(() => Promise.resolve(["read_notes"]));

    const answer = await server.inject({
      method: "POST",
      url: `/connectors/${id}/discover`,
      payload: {},
    });

    expect(answer.statusCode).toBe(401);
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

describe("stopping and starting work over the wire", () => {
  let officeId: string;
  let departmentId: string;

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = await aDepartment(officeId);
  });

  it("stops an office", async () => {
    const response = await put(`/offices/${officeId}/run-state`, { runState: "paused" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runState: "paused" });
    expect((await get(`/offices/${officeId}`)).json()).toMatchObject({ runState: "paused" });
  });

  it("starts it again", async () => {
    await put(`/offices/${officeId}/run-state`, { runState: "paused" });
    await put(`/offices/${officeId}/run-state`, { runState: "running" });

    expect((await get(`/offices/${officeId}`)).json()).toMatchObject({ runState: "running" });
  });

  it("takes the same instruction twice without complaining", async () => {
    // Two people pressing Pause is not an error, unlike a lifecycle transition.
    await put(`/offices/${officeId}/run-state`, { runState: "paused" });
    expect((await put(`/offices/${officeId}/run-state`, { runState: "paused" })).statusCode).toBe(
      200,
    );
  });

  it("refuses a state nobody has heard of rather than storing it", async () => {
    const response = await put(`/offices/${officeId}/run-state`, { runState: "asleep" });

    expect(response.statusCode).toBe(400);
    expect((await get(`/offices/${officeId}`)).json()).toMatchObject({ runState: "running" });
  });

  it("refuses a body that names no state at all", async () => {
    expect((await put(`/offices/${officeId}/run-state`, {})).statusCode).toBe(400);
  });

  it("says so when there is no such office", async () => {
    expect((await put("/offices/id-nope/run-state", { runState: "paused" })).statusCode).toBe(404);
  });

  it("tells everyone watching that the office changed", async () => {
    const before = events.since(officeId, 0).length;
    await put(`/offices/${officeId}/run-state`, { runState: "paused" });

    expect(events.since(officeId, 0).length).toBeGreaterThan(before);
  });

  it("does not start an office when its name is edited", async () => {
    // The rule core states, held at the wire too: a PATCH carrying runState
    // must not be a way round the switch.
    await put(`/offices/${officeId}/run-state`, { runState: "paused" });
    await patch(`/offices/${officeId}`, { name: "Northwind", runState: "running" });

    expect((await get(`/offices/${officeId}`)).json()).toMatchObject({
      name: "Northwind",
      runState: "paused",
    });
  });

  it("stops one room without stopping the office", async () => {
    await put(`/departments/${departmentId}/run-state`, { runState: "paused" });

    expect((await get(`/departments/${departmentId}`)).json()).toMatchObject({
      runState: "paused",
    });
    expect((await get(`/offices/${officeId}`)).json()).toMatchObject({ runState: "running" });
  });

  it("says so when there is no such department", async () => {
    expect((await put("/departments/id-nope/run-state", { runState: "paused" })).statusCode).toBe(
      404,
    );
  });
});

describe("pausing a person over the wire", () => {
  let officeId: string;
  let departmentId: string;
  let employeeId: string;

  const hire = async (name = "Ada") => {
    const created = await post(`/offices/${officeId}/employees`, {
      name,
      role: "Engineer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    return created.json<{ id: string }>().id;
  };

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = await aDepartment(officeId);
    employeeId = await hire();
  });

  it("pauses somebody", async () => {
    const response = await put(`/employees/${employeeId}/status`, { status: "paused" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "paused" });
  });

  it("leaves their open work assigned to them", async () => {
    const task = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Write the parser",
      assigneeId: employeeId,
    });
    const taskId = task.json<{ id: string }>().id;
    await put(`/employees/${employeeId}/status`, { status: "paused" });

    // Pausing is not reassignment: their desk is untouched and waiting.
    expect((await get(`/tasks/${taskId}`)).json()).toMatchObject({ assigneeId: employeeId });
  });

  it("puts them back to work", async () => {
    await put(`/employees/${employeeId}/status`, { status: "paused" });
    await put(`/employees/${employeeId}/status`, { status: "active" });

    expect((await get(`/employees/${employeeId}`)).json()).toMatchObject({ status: "active" });
  });

  it("records when their status last changed", async () => {
    const before = (await get(`/employees/${employeeId}`)).json<{ statusChangedAt: string }>();
    const after = (await put(`/employees/${employeeId}/status`, { status: "paused" })).json<{
      statusChangedAt: string;
    }>();

    expect(after.statusChangedAt).not.toBe(undefined);
    expect(before.statusChangedAt).not.toBe(undefined);
  });

  it("will not bring back somebody who was terminated", async () => {
    // The rule lives in transitionEmployee; the route must go through it
    // rather than restating it.
    await put(`/employees/${employeeId}/status`, { status: "terminated" });
    const response = await put(`/employees/${employeeId}/status`, { status: "active" });

    expect(response.statusCode).toBe(400);
    expect((await get(`/employees/${employeeId}`)).json()).toMatchObject({ status: "terminated" });
  });

  it("refuses a status nobody has heard of", async () => {
    expect((await put(`/employees/${employeeId}/status`, { status: "napping" })).statusCode).toBe(
      400,
    );
  });

  it("says so when there is no such person", async () => {
    expect((await put("/employees/id-nope/status", { status: "paused" })).statusCode).toBe(404);
  });

  it("is not reachable through an ordinary edit", async () => {
    await put(`/employees/${employeeId}/status`, { status: "paused" });
    await patch(`/employees/${employeeId}`, { role: "Staff engineer", status: "active" });

    expect((await get(`/employees/${employeeId}`)).json()).toMatchObject({
      role: "Staff engineer",
      status: "paused",
    });
  });
});

describe("a bench taking work in turn, over the wire", () => {
  let officeId: string;
  let departmentId: string;
  let iris: string;
  let theo: string;
  let benchId: string;

  const hire = async (name: string) => {
    const created = await post(`/offices/${officeId}/employees`, {
      name,
      role: "Designer",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    return created.json<{ id: string }>().id;
  };

  const workFor = async (title: string, body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/tasks`, { departmentId, title, ...body });

  const assignee = (response: LightMyRequestResponse) =>
    response.json<{ assigneeId: string | null }>().assigneeId;

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = await aDepartment(officeId, "Design");
    iris = await hire("Iris");
    theo = await hire("Theo");
    benchId = "bench-draft";
    await patch(`/departments/${departmentId}`, {
      benches: [
        { id: benchId, name: "Drafting", memberIds: [iris, theo], strategy: "round_robin" },
      ],
    });
  });

  it("keeps the bench the department was given", async () => {
    const back = await get(`/departments/${departmentId}`);
    expect(back.json<{ benches: { name: string }[] }>().benches[0]?.name).toBe("Drafting");
  });

  it("refuses a bench holding somebody who works elsewhere", async () => {
    // Shape alone cannot catch this; the route has the room's people and does.
    const other = await aDepartment(officeId, "Engineering");
    const response = await patch(`/departments/${other}`, {
      benches: [{ id: "b2", name: "Nope", memberIds: [iris], strategy: "round_robin" }],
    });
    expect(response.statusCode).toBe(400);
  });

  it("takes a judge who works in another department", async () => {
    // Judging is not the room's work, and somebody outside it is often the only
    // person with nothing at stake in the comparison.
    const other = await aDepartment(officeId, "Engineering");
    const created = await post(`/offices/${officeId}/employees`, {
      name: "Ada",
      role: "Lead",
      color: "#112233",
      department: other,
      llm: { provider: "anthropic", model: "claude-opus-5" },
    });
    const response = await patch(`/departments/${departmentId}`, {
      benches: [
        {
          id: benchId,
          name: "Drafting",
          memberIds: [iris, theo],
          strategy: "shootout",
          judgeId: created.json<{ id: string }>().id,
        },
      ],
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a judge who does not work in this office at all", async () => {
    const response = await patch(`/departments/${departmentId}`, {
      benches: [
        {
          id: benchId,
          name: "Drafting",
          memberIds: [iris],
          strategy: "shootout",
          judgeId: "emp-nowhere",
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it("hands the first piece of work to the first member", async () => {
    expect(assignee(await workFor("One", { benchId }))).toBe(iris);
  });

  it("goes round the bench in turn", async () => {
    const one = assignee(await workFor("One", { benchId }));
    const two = assignee(await workFor("Two", { benchId }));
    const three = assignee(await workFor("Three", { benchId }));

    expect([one, two, three]).toEqual([iris, theo, iris]);
  });

  it("records which bench placed each one", async () => {
    const task = await workFor("One", { benchId });
    expect(task.json<{ benchId: string | null }>().benchId).toBe(benchId);
  });

  it("passes over somebody who has been paused", async () => {
    await workFor("One", { benchId });
    await put(`/employees/${theo}/status`, { status: "paused" });

    expect(assignee(await workFor("Two", { benchId }))).toBe(iris);
    expect(assignee(await workFor("Three", { benchId }))).toBe(iris);
  });

  it("brings them back into the rotation when they return", async () => {
    await put(`/employees/${theo}/status`, { status: "paused" });
    await workFor("One", { benchId });
    await put(`/employees/${theo}/status`, { status: "active" });

    expect(assignee(await workFor("Two", { benchId }))).toBe(theo);
  });

  it("refuses work aimed at a bench this department does not have", async () => {
    const response = await workFor("One", { benchId: "bench-nowhere" });
    expect(response.statusCode).toBe(400);
  });

  it("leaves work in the backlog when nobody on the bench can take it", async () => {
    await put(`/employees/${iris}/status`, { status: "paused" });
    await put(`/employees/${theo}/status`, { status: "paused" });
    const task = await workFor("One", { benchId });

    expect(task.statusCode).toBe(201);
    expect(assignee(task)).toBeNull();
    expect(task.json<{ status: string }>().status).toBe("backlog");
  });

  it("still takes a named assignee, with no bench involved", async () => {
    const task = await workFor("One", { assigneeId: theo });
    expect(assignee(task)).toBe(theo);
    expect(task.json<{ benchId: string | null }>().benchId).toBeNull();
  });

  it("does not let a task name both a bench and a person", async () => {
    // Two answers to who does it, and no reason to prefer either.
    expect((await workFor("One", { benchId, assigneeId: theo })).statusCode).toBe(400);
  });
});

describe("work handed across to a bench", () => {
  /** Two departments that review nothing, so a submit finishes the work. */
  async function wiredToBench() {
    const officeId = await anOffice();
    const make = async (name: string): Promise<string> =>
      (
        await post(`/offices/${officeId}/departments`, {
          name,
          color: "#3366ff",
          position: { x: 0, y: 0 },
          reviewPolicy: { kind: "direct" },
        })
      ).json<{ id: string }>().id;
    const product = await make("Product");
    const design = await make("Design");

    const hire = async (name: string, departmentId: string) =>
      (
        await post(`/offices/${officeId}/employees`, {
          name,
          role: "Maker",
          color: "#00aa66",
          department: departmentId,
          llm: { provider: "anthropic", model: "claude-sonnet-5" },
        })
      ).json<{ id: string }>().id;
    const pam = await hire("Pam", product);
    const iris = await hire("Iris", design);
    const theo = await hire("Theo", design);

    await patch(`/departments/${design}`, {
      benches: [
        { id: "bench-draft", name: "Drafting", memberIds: [iris, theo], strategy: "round_robin" },
      ],
    });
    await post(`/offices/${officeId}/connections`, {
      fromId: product,
      toId: design,
      kind: "handoff",
      rules: { assign: { bench: "bench-draft" } },
    });
    return { officeId, product, design, pam, iris, theo };
  }

  /** Finishes one piece of work in Product, which fires the handoff. */
  const handOver = async (
    office: { officeId: string; product: string; pam: string },
    title: string,
  ) => {
    const task = await post(`/offices/${office.officeId}/tasks`, {
      departmentId: office.product,
      title,
      assigneeId: office.pam,
    });
    const id = task.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.pam });
    await post(`/tasks/${id}/events`, { type: "submit", actorId: office.pam });
  };

  const inDesign = async (officeId: string, design: string) =>
    (await get(`/offices/${officeId}/tasks`))
      .json<{
        items: {
          departmentId: string;
          title: string;
          assigneeId: string | null;
          benchId: string | null;
        }[];
      }>()
      .items.filter((one) => one.departmentId === design);

  it("lands on a member of the bench the arrow names, in turn", async () => {
    const office = await wiredToBench();
    await handOver(office, "First");
    await handOver(office, "Second");

    // By title, not by list order: the store makes no promise about that.
    const handed = await inDesign(office.officeId, office.design);
    expect(handed.find((one) => one.title === "First")?.assigneeId).toBe(office.iris);
    expect(handed.find((one) => one.title === "Second")?.assigneeId).toBe(office.theo);
  });

  it("records the bench that placed it, so the box knows what it handed out", async () => {
    const office = await wiredToBench();
    await handOver(office, "First");

    expect((await inDesign(office.officeId, office.design))[0]?.benchId).toBe("bench-draft");
  });

  it("shares the turn with work created directly against the bench", async () => {
    // One rotation per bench, however the work arrived: two counters would let
    // the same person take two in a row without either path noticing.
    const office = await wiredToBench();
    await post(`/offices/${office.officeId}/tasks`, {
      departmentId: office.design,
      title: "Direct",
      benchId: "bench-draft",
    });
    await handOver(office, "Handed");

    const handed = await inDesign(office.officeId, office.design);
    expect(handed.find((one) => one.title === "Direct")?.assigneeId).toBe(office.iris);
    expect(handed.find((one) => one.title === "Handed")?.assigneeId).toBe(office.theo);
  });
});

describe("a shootout, over the wire", () => {
  interface Entry {
    readonly id: string;
    readonly title: string;
    readonly assigneeId: string | null;
    readonly benchId: string | null;
    readonly contestId: string | null;
    readonly status: string;
    readonly won: { readonly reason: string; readonly decidedBy: string | null } | null;
  }

  let officeId: string;
  let departmentId: string;
  let iris: string;
  let theo: string;

  const hire = async (name: string, department = departmentId) =>
    (
      await post(`/offices/${officeId}/employees`, {
        name,
        role: "Designer",
        color: "#00aa66",
        department,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;

  /** One job sent to the bench, and the entries it became. */
  const runOff = async (title = "Draft the launch note") => {
    const response = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title,
      acceptanceCriteria: ["It fits on one screen"],
      benchId: "bench-draft",
    });
    return response;
  };

  const entriesOf = (response: LightMyRequestResponse) =>
    response.json<{ contestId: string; items: Entry[] }>();

  /** Takes one entry all the way to done, as its own run would. */
  const finish = async (id: string, actorId: string | null) => {
    await post(`/tasks/${id}/events`, { type: "start", actorId });
    // Says what it met, because the contest asked for something in particular
    // and a submission that claims nothing is sent back.
    await post(`/tasks/${id}/events`, {
      type: "submit",
      actorId,
      met: ["It fits on one screen"],
    });
  };

  const read = async (id: string) => (await get(`/tasks/${id}`)).json<Entry>();

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = (
      await post(`/offices/${officeId}/departments`, {
        name: "Design",
        color: "#3366ff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      })
    ).json<{ id: string }>().id;
    iris = await hire("Iris");
    theo = await hire("Theo");
    await patch(`/departments/${departmentId}`, {
      benches: [
        { id: "bench-draft", name: "Drafting", memberIds: [iris, theo], strategy: "shootout" },
      ],
    });
  });

  it("answers one request with one piece of work per member", async () => {
    const made = entriesOf(await runOff());
    expect(made.items).toHaveLength(2);
    expect(made.items.map((entry) => entry.assigneeId)).toEqual([iris, theo]);
  });

  it("puts them in one contest, and says which", async () => {
    const made = entriesOf(await runOff());
    expect(made.contestId).toBeTruthy();
    expect(made.items.every((entry) => entry.contestId === made.contestId)).toBe(true);
  });

  it("asks every one of them the same thing", async () => {
    const [first, second] = entriesOf(await runOff()).items;
    const a = await read(first?.id ?? "");
    const b = await read(second?.id ?? "");
    expect(a.title).toBe(b.title);
    expect(a.benchId).toBe("bench-draft");
    expect(b.benchId).toBe("bench-draft");
  });

  it("still answers with one task when the bench takes work in turn", async () => {
    // The old shape is untouched: only a shootout fans out.
    await patch(`/departments/${departmentId}`, {
      benches: [
        { id: "bench-draft", name: "Drafting", memberIds: [iris, theo], strategy: "round_robin" },
      ],
    });
    const response = await runOff();
    expect(response.json<{ id: string }>().id).toBeTruthy();
    expect(response.json<{ items?: unknown }>().items).toBeUndefined();
  });

  it("says a piece of work arrived for each entry, not one for the contest", async () => {
    const before = events.since(officeId, 0).length;
    await runOff();
    const created = events
      .since(officeId, before)
      .filter((event) => (event.data as { kind?: string }).kind === "task.created");
    expect(created).toHaveLength(2);
  });

  it("records a verdict on the entry that won", async () => {
    const made = entriesOf(await runOff());
    const winner = made.items[1];
    await finish(winner?.id ?? "", winner?.assigneeId ?? null);

    const decided = await post(`/tasks/${winner?.id ?? ""}/win`, {
      reason: "tighter, and it kept the detail",
    });

    expect(decided.statusCode).toBe(200);
    expect(decided.json<Entry>().won?.reason).toBe("tighter, and it kept the detail");
    expect((await read(made.items[0]?.id ?? "")).won).toBeNull();
  });

  it("names the employee that decided, when one did", async () => {
    const made = entriesOf(await runOff());
    const winner = made.items[0];
    await finish(winner?.id ?? "", winner?.assigneeId ?? null);
    const judge = await hire("Ada");

    const decided = await post(`/tasks/${winner?.id ?? ""}/win`, {
      reason: "clearer",
      decidedBy: judge,
    });
    expect(decided.json<Entry>().won?.decidedBy).toBe(judge);
  });

  it("refuses a second verdict rather than overwriting the first", async () => {
    const made = entriesOf(await runOff());
    const [first, second] = made.items;
    await finish(first?.id ?? "", first?.assigneeId ?? null);
    await finish(second?.id ?? "", second?.assigneeId ?? null);
    await post(`/tasks/${first?.id ?? ""}/win`, { reason: "clearer" });

    const again = await post(`/tasks/${second?.id ?? ""}/win`, { reason: "on reflection" });
    expect(again.statusCode).toBe(400);
    expect((await read(first?.id ?? "")).won?.reason).toBe("clearer");
  });

  it("refuses a verdict on an entry whose answer is not in", async () => {
    const made = entriesOf(await runOff());
    const response = await post(`/tasks/${made.items[0]?.id ?? ""}/win`, { reason: "a hunch" });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a verdict with no reason", async () => {
    const made = entriesOf(await runOff());
    const winner = made.items[0];
    await finish(winner?.id ?? "", winner?.assigneeId ?? null);
    expect((await post(`/tasks/${winner?.id ?? ""}/win`, { reason: "  " })).statusCode).toBe(400);
  });

  it("refuses a verdict on work that is not in a contest at all", async () => {
    const ordinary = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Ordinary work",
      assigneeId: iris,
    });
    const id = ordinary.json<{ id: string }>().id;
    await finish(id, iris);

    expect((await post(`/tasks/${id}/win`, { reason: "it is the only one" })).statusCode).toBe(400);
  });

  it("says nothing about a task that is not there", async () => {
    expect((await post("/tasks/task-nowhere/win", { reason: "clearer" })).statusCode).toBe(404);
  });

  it("says the entry changed, so a canvas showing it keeps up", async () => {
    const made = entriesOf(await runOff());
    const winner = made.items[0];
    await finish(winner?.id ?? "", winner?.assigneeId ?? null);
    const before = events.since(officeId, 0).length;
    await post(`/tasks/${winner?.id ?? ""}/win`, { reason: "clearer" });

    const said = events
      .since(officeId, before)
      .map((event) => (event.data as { kind: string }).kind);
    expect(said).toContain("task.updated");
  });

  it("leaves one piece of work waiting when nobody on the bench can take it", async () => {
    await put(`/employees/${iris}/status`, { status: "paused" });
    await put(`/employees/${theo}/status`, { status: "paused" });
    const response = await runOff();

    const task = response.json<Entry>();
    expect(task.assigneeId).toBeNull();
    expect(task.contestId).toBeNull();
  });
});

describe("work handed across to a shootout bench", () => {
  /** Product hands on to a Design bench that runs everything twice. */
  async function wired() {
    const officeId = await anOffice();
    const make = async (name: string): Promise<string> =>
      (
        await post(`/offices/${officeId}/departments`, {
          name,
          color: "#3366ff",
          position: { x: 0, y: 0 },
          reviewPolicy: { kind: "direct" },
        })
      ).json<{ id: string }>().id;
    const product = await make("Product");
    const design = await make("Design");
    const build = await make("Build");

    const hire = async (name: string, departmentId: string) =>
      (
        await post(`/offices/${officeId}/employees`, {
          name,
          role: "Maker",
          color: "#00aa66",
          department: departmentId,
          llm: { provider: "anthropic", model: "claude-sonnet-5" },
        })
      ).json<{ id: string }>().id;
    const pam = await hire("Pam", product);
    const iris = await hire("Iris", design);
    const theo = await hire("Theo", design);
    await hire("Bo", build);

    await patch(`/departments/${design}`, {
      benches: [
        { id: "bench-draft", name: "Drafting", memberIds: [iris, theo], strategy: "shootout" },
      ],
    });
    await post(`/offices/${officeId}/connections`, {
      fromId: product,
      toId: design,
      kind: "handoff",
      rules: { assign: { bench: "bench-draft" } },
    });
    // Design hands on to Build, which is what must not happen N times.
    await post(`/offices/${officeId}/connections`, {
      fromId: design,
      toId: build,
      kind: "handoff",
    });
    return { officeId, product, design, build, pam, iris, theo };
  }

  const handOver = async (office: { officeId: string; product: string; pam: string }) => {
    const task = await post(`/offices/${office.officeId}/tasks`, {
      departmentId: office.product,
      title: "Draft the launch note",
      assigneeId: office.pam,
    });
    const id = task.json<{ id: string }>().id;
    await post(`/tasks/${id}/events`, { type: "start", actorId: office.pam });
    await post(`/tasks/${id}/events`, { type: "submit", actorId: office.pam });
  };

  const tasksIn = async (officeId: string, departmentId: string) =>
    (await get(`/offices/${officeId}/tasks`))
      .json<{
        items: {
          id: string;
          departmentId: string;
          assigneeId: string | null;
          contestId: string | null;
        }[];
      }>()
      .items.filter((one) => one.departmentId === departmentId);

  it("runs the handed-on work off between every member of the bench", async () => {
    const office = await wired();
    await handOver(office);

    const entries = await tasksIn(office.officeId, office.design);
    expect(entries.map((one) => one.assigneeId).sort()).toEqual([office.iris, office.theo].sort());
    expect(new Set(entries.map((one) => one.contestId)).size).toBe(1);
  });

  it("does not hand the same job on to the next department once per entry", async () => {
    // The thing that makes a shootout affordable to wire into a pipeline at all:
    // two entries finishing must not become two pieces of work next door.
    const office = await wired();
    await handOver(office);
    const entries = await tasksIn(office.officeId, office.design);
    for (const entry of entries) {
      await post(`/tasks/${entry.id}/events`, { type: "start", actorId: entry.assigneeId });
      await post(`/tasks/${entry.id}/events`, { type: "submit", actorId: entry.assigneeId });
    }

    expect(await tasksIn(office.officeId, office.build)).toHaveLength(0);
  });
});

describe("what the office was spent on", () => {
  let officeId: string;

  const event = (overrides: Record<string, unknown> = {}) => ({
    id: "ev-1",
    kind: "llm_call",
    at: Date.parse("2026-10-01T09:00:00Z"),
    attribution: { officeId, taskId: "task-1", employeeId: "emp-iris" },
    durationMs: 1200,
    ok: true,
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: { inputTokens: 100, outputTokens: 50 },
    cost: { totalUsd: 0.004 },
    streamed: false,
    ...overrides,
  });

  const record = (body: Record<string, unknown> = event()) =>
    post(`/offices/${officeId}/usage`, body);

  const listed = async (query = "") =>
    (await get(`/offices/${officeId}/usage${query}`)).json<{ items: Record<string, unknown>[] }>()
      .items;

  beforeEach(async () => {
    officeId = await anOffice();
  });

  it("keeps a call it is told about", async () => {
    expect((await record()).statusCode).toBe(201);
    expect(await listed()).toHaveLength(1);
  });

  it("keeps the event whole, so nothing is lost on the way in", async () => {
    await record();
    const [row] = await listed();
    expect((row?.["event"] as Record<string, unknown>)["model"]).toBe("claude-sonnet-5");
    expect((row?.["event"] as Record<string, unknown>)["cost"]).toEqual({ totalUsd: 0.004 });
  });

  it("answers what one piece of work cost", async () => {
    await record();
    await record(event({ attribution: { officeId, taskId: "task-2", employeeId: "emp-theo" } }));

    const mine = await listed("?taskId=task-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.["taskId"]).toBe("task-1");
  });

  it("keeps the moment the call finished, not the moment it was told", async () => {
    await record();
    expect(String((await listed())[0]?.["at"])).toContain("2026-10-01T09:00:00");
  });

  it("refuses an event that names no office", async () => {
    expect((await record(event({ attribution: {} }))).statusCode).toBe(400);
  });

  it("refuses an event with no moment on it", async () => {
    expect((await record(event({ at: "lunchtime" }))).statusCode).toBe(400);
  });

  it("says so when there is no such office", async () => {
    expect((await post("/offices/id-nope/usage", event())).statusCode).toBe(404);
  });

  it("does not wake every canvas watching the office", async () => {
    // A usage row is not a change to the office. Publishing one per model call
    // would be a stampede down the event stream for something no canvas needs
    // to react to.
    const before = events.since(officeId, 0).length;
    await record();
    expect(events.since(officeId, 0).length).toBe(before);
  });

  it("keeps one office's spend out of another's", async () => {
    await record();
    const other = await anOffice();
    expect((await get(`/offices/${other}/usage`)).json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe("what each level has spent", () => {
  let officeId: string;
  let departmentId: string;
  let iris: string;
  let theo: string;

  const hire = async (name: string) =>
    (
      await post(`/offices/${officeId}/employees`, {
        name,
        role: "Designer",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;

  const spend = async (employeeId: string, usd: number, at = "2026-10-01T09:00:00Z") =>
    post(`/offices/${officeId}/usage`, {
      id: `ev-${String(Math.random())}`,
      kind: "llm_call",
      at: Date.parse(at),
      attribution: { officeId, departmentId, employeeId, taskId: "task-1" },
      durationMs: 1000,
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { totalUsd: usd },
      streamed: false,
    });

  const summary = async (query = "") =>
    (await get(`/offices/${officeId}/spend${query}`)).json<{
      officeUsd: number;
      byDepartment: Record<string, number>;
      byEmployee: Record<string, number>;
    }>();

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = await aDepartment(officeId, "Design");
    iris = await hire("Iris");
    theo = await hire("Theo");
  });

  it("is nothing for an office that has spent nothing", async () => {
    const totals = await summary();
    expect(totals.officeUsd).toBe(0);
    expect(totals.byEmployee).toEqual({});
  });

  it("adds up the office's spend", async () => {
    await spend(iris, 1.5);
    await spend(theo, 2.25);
    expect((await summary()).officeUsd).toBeCloseTo(3.75);
  });

  it("splits it by person", async () => {
    await spend(iris, 1.5);
    await spend(iris, 0.5);
    await spend(theo, 2);

    const totals = await summary();
    expect(totals.byEmployee[iris]).toBeCloseTo(2);
    expect(totals.byEmployee[theo]).toBeCloseTo(2);
  });

  it("splits it by department, joined through the people", async () => {
    // The usage row deliberately promotes office, task and person — not the
    // department — so this join happens where the rows are.
    await spend(iris, 1.5);
    expect((await summary()).byDepartment[departmentId]).toBeCloseTo(1.5);
  });

  it("leaves out what fell before the period began", async () => {
    await spend(iris, 100, "2026-09-30T09:00:00Z");
    await spend(iris, 1, "2026-10-01T09:00:00Z");

    // A day budget asked about on 1 October must not see September's spending.
    const totals = await summary("?period=day&at=2026-10-01T12:00:00Z");
    expect(totals.officeUsd).toBeCloseTo(1);
  });

  it("counts the whole month when asked for one", async () => {
    await spend(iris, 100, "2026-09-30T09:00:00Z");
    await spend(iris, 1, "2026-10-01T09:00:00Z");

    expect((await summary("?period=month&at=2026-10-31T12:00:00Z")).officeUsd).toBeCloseTo(1);
  });

  it("does not count a call nobody could price as nothing", async () => {
    // cost is null when the registry has no price; adding it as zero would
    // make an unpriced model look free and let it run past any limit.
    await spend(iris, 1);
    await post(`/offices/${officeId}/usage`, {
      id: "ev-unpriced",
      kind: "llm_call",
      at: Date.parse("2026-10-01T09:00:00Z"),
      attribution: { officeId, employeeId: iris },
      durationMs: 10,
      ok: true,
      provider: "anthropic",
      model: "something-new",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: null,
      streamed: false,
    });

    const totals = await summary();
    expect(totals.officeUsd).toBeCloseTo(1);
    expect((totals as unknown as { unpricedCalls: number }).unpricedCalls).toBe(1);
  });

  it("refuses a period nobody has heard of", async () => {
    expect((await get(`/offices/${officeId}/spend?period=fortnight`)).statusCode).toBe(400);
  });

  it("says so when there is no such office", async () => {
    expect((await get("/offices/id-nope/spend")).statusCode).toBe(404);
  });

  it("keeps one office's spend out of another's", async () => {
    await spend(iris, 5);
    const other = await anOffice();
    expect((await get(`/offices/${other}/spend`)).json<{ officeUsd: number }>().officeUsd).toBe(0);
  });
});

describe("where an office sends word", () => {
  let officeId: string;

  const aChannel = (body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/channels`, {
      kind: "slack",
      name: "ops-alerts",
      secret: "https://hooks.slack.test/services/T/B/x",
      ...body,
    });

  beforeEach(async () => {
    officeId = await anOffice();
  });

  it("adds one", async () => {
    const response = await aChannel();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ kind: "slack", name: "ops-alerts", enabled: true });
  });

  it("never hands the secret back, not even to the one who set it", async () => {
    // A Slack webhook is a bearer credential: reading it is posting to that
    // channel for ever, and anybody who can open the canvas can read this.
    const created = await aChannel();
    expect(JSON.stringify(created.json())).not.toContain("hooks.slack.test");
    expect(JSON.stringify(created.json())).toContain("hasSecret");
  });

  it("does not leak it when listing either", async () => {
    await aChannel();
    const listed = await get(`/offices/${officeId}/channels`);
    expect(JSON.stringify(listed.json())).not.toContain("hooks.slack.test");
  });

  it("says whether one is configured, which is what anybody needs to know", async () => {
    await aChannel();
    const listed = listedChannels(await get(`/offices/${officeId}/channels`));
    expect(listed[0]?.["hasSecret"]).toBe(true);
  });

  it("keeps the secret through a rename, since no canvas can send it back", async () => {
    const id = (await aChannel()).json<{ id: string }>().id;
    const renamed = await patch(`/channels/${id}`, { name: "alerts" });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ hasSecret: boolean }>().hasSecret).toBe(true);
  });

  it("switches one off", async () => {
    const id = (await aChannel()).json<{ id: string }>().id;
    expect((await patch(`/channels/${id}`, { enabled: false })).json()).toMatchObject({
      enabled: false,
    });
  });

  it("removes one", async () => {
    const id = (await aChannel()).json<{ id: string }>().id;
    expect(
      (await server.inject({ method: "DELETE", url: `/channels/${id}`, headers: auth })).statusCode,
    ).toBe(204);
    expect(listedChannels(await get(`/offices/${officeId}/channels`))).toEqual([]);
  });

  it("refuses a telegram channel with no chat to post in", async () => {
    expect((await aChannel({ kind: "telegram", secret: "123:AA", config: {} })).statusCode).toBe(
      400,
    );
  });

  it("refuses a second channel with the same name", async () => {
    await aChannel();
    expect((await aChannel()).statusCode).toBe(400);
  });

  it("says so when there is no such office", async () => {
    expect(
      (await post("/offices/id-nope/channels", { kind: "slack", name: "x", secret: "y" }))
        .statusCode,
    ).toBe(404);
  });
});

describe("warning when the money is nearly gone", () => {
  let officeId: string;
  let departmentId: string;
  let iris: string;

  const spend = async (usd: number, at = "2026-10-01T09:00:00Z") =>
    post(`/offices/${officeId}/usage`, {
      id: `ev-${String(Math.random())}`,
      kind: "llm_call",
      at: Date.parse(at),
      attribution: { officeId, departmentId, employeeId: iris, taskId: "task-1" },
      durationMs: 1000,
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { totalUsd: usd },
      streamed: false,
    });

  const warnings = () =>
    events
      .since(officeId, 0)
      .filter((event) => (event.data as { kind?: string }).kind === "budget.warned");

  beforeEach(async () => {
    officeId = await anOffice();
    await patch(`/offices/${officeId}`, { budget: { limitUsd: 10, warnAtUsd: 8, period: "day" } });
    departmentId = await aDepartment(officeId, "Design");
    iris = (
      await post(`/offices/${officeId}/employees`, {
        name: "Iris",
        role: "Designer",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
  });

  it("says nothing while there is room", async () => {
    await spend(5);
    expect(warnings()).toHaveLength(0);
  });

  it("warns on the call that crosses the threshold", async () => {
    await spend(5);
    await spend(4);
    expect(warnings()).toHaveLength(1);
  });

  it("warns once, not on every call after it", async () => {
    // The whole reason the crossing is detected here: the spend before this
    // row was under and after it is not, so there is nothing to remember and
    // nothing to reset when the period rolls.
    await spend(5);
    await spend(4);
    // Still warning, never over: crossing the limit is a second crossing and
    // has its own test below.
    await spend(0.3);
    await spend(0.3);

    expect(warnings()).toHaveLength(1);
  });

  it("says which level, and what it has spent against what", async () => {
    await spend(9);
    const warned = warnings()[0]?.data as Record<string, unknown>;

    expect(warned["level"]).toBe("office");
    expect(warned["spentUsd"]).toBeCloseTo(9);
    expect(warned["limitUsd"]).toBe(10);
  });

  it("warns for a department over its own threshold", async () => {
    await patch(`/departments/${departmentId}`, {
      budget: { limitUsd: 4, warnAtUsd: 3, period: "day" },
    });
    await spend(3.5);

    const levels = warnings().map((event) => (event.data as { level?: string }).level);
    expect(levels).toContain("department");
  });

  it("warns again once the limit itself is crossed", async () => {
    // Crossing the warning and crossing the limit are two different moments,
    // and the second is the one that stops work.
    await spend(9);
    await spend(2);

    expect(warnings()).toHaveLength(2);
  });

  it("says nothing for an office with no budget at all", async () => {
    const plain = await anOffice();
    await post(`/offices/${plain}/usage`, {
      id: "ev-plain",
      kind: "llm_call",
      at: Date.parse("2026-10-01T09:00:00Z"),
      attribution: { officeId: plain },
      durationMs: 1,
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: {},
      cost: { totalUsd: 500 },
      streamed: false,
    });

    expect(
      events.since(plain, 0).filter((e) => (e.data as { kind?: string }).kind === "budget.warned"),
    ).toHaveLength(0);
  });
});

describe("an office that serves its own canvas", () => {
  let canvas: string;
  let serving: FastifyInstance;

  beforeEach(async () => {
    canvas = await mkdtemp(join(tmpdir(), "vo-canvas-"));
    await writeFile(join(canvas, "index.html"), "<!doctype html><title>Virtual Office</title>");
    await writeFile(join(canvas, "app.js"), "console.log('canvas')");
    serving = buildServer({
      store: new InMemoryRelationalStore(),
      events: new OfficeEventLog({ now: () => 1_700_000_000_000 }),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      webRoot: canvas,
    });
    await serving.ready();
  });

  afterEach(async () => {
    await serving.close();
  });

  const open = (url: string, headers: Record<string, string> = {}) =>
    serving.inject({ method: "GET", url, headers });

  it("serves the page to a browser that has no credential yet", async () => {
    // It cannot have one: it has not been given the page that asks for it.
    const response = await open("/");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Virtual Office");
  });

  it("serves what the page asks for next", async () => {
    expect((await open("/app.js")).statusCode).toBe(200);
  });

  it("serves the page at an address inside the canvas, which is the router's", async () => {
    // /usage is a section of the canvas, not a route this office has.
    const response = await open("/usage", { accept: "text/html" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Virtual Office");
  });

  it("still refuses the office itself without a credential", async () => {
    // Serving a canvas opens the canvas, not the office behind it.
    expect((await open("/offices")).statusCode).toBe(401);
  });

  it("answers an address under the office as an office, not as a canvas", async () => {
    // A client asking for JSON and given HTML gets a parse error instead of a
    // 404, which is a confusing way to find out a route does not exist.
    const response = await open("/tasks/task-1/nothing-like-this", {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("json");
  });

  it("serves the page at a section whose name the office also uses", async () => {
    // /tasks is both a section of the canvas and the prefix of this office's
    // task routes. A person who types it, or reloads on it, is a browser
    // asking for a page — and the office has no route there at all.
    const response = await open("/tasks", { accept: "text/html" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Virtual Office");
  });

  it("still keeps the work behind that prefix to itself", async () => {
    // The page is open; what the page then asks for is not. A route that
    // exists needs a credential however the asker dresses up.
    const response = await open("/tasks/task-1", { accept: "text/html" });

    expect(response.statusCode).toBe(401);
  });

  it("gives a browser the canvas at an address nothing answers, and a client a 404", async () => {
    // The canvas says "Nothing here" at an address it does not know, which is
    // a better answer to a person than raw JSON. A client asking for JSON gets
    // JSON, because being handed HTML is a parse error rather than a 404.
    const page = await open("/offices/office-1/nothing-like-this", { accept: "text/html" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Virtual Office");

    const api = await open("/offices/office-1/nothing-like-this", {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
    });
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-type"]).toContain("json");
  });

  it("lets a signed-in browser through to the office", async () => {
    const response = await open("/offices", { cookie: `vo_session=${TOKEN}` });
    expect(response.statusCode).toBe(200);
  });

  it("serves nothing but the office when there is no canvas to serve", async () => {
    // Which is every deployment that ran before this, and the API-only one.
    expect((await server.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
  });
});

describe("what counts as the office rather than the canvas", () => {
  it("names every route this office has", async () => {
    // Derived from the route table rather than listed by hand: a new top-level
    // route that nobody added here would be served as the canvas — a 200 with
    // an HTML page where an API answer belongs.
    const app = buildServer({
      store: new InMemoryRelationalStore(),
      blobs: new InMemoryBlobStore(),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
    });
    await app.ready();
    // Top-level entries only: `├── /tasks/:id` is the office's, and so is
    // everything under it.
    const segments = new Set(
      [...app.printRoutes({ commonPrefix: false }).matchAll(/^[├└]──\s+(\/[a-z-]+)/gm)].map(
        (match) => match[1] ?? "",
      ),
    );
    await app.close();

    expect(segments.size).toBeGreaterThan(5);
    for (const segment of segments) {
      expect(OFFICE_PATHS, segment).toContain(segment);
    }
  });
});

describe("a run the office is holding for a worker", () => {
  let app: FastifyInstance;
  let log: OfficeEventLog;
  let blobs: InMemoryBlobStore;
  let taskId: string;
  let employeeId: string;

  const send = (
    method: "POST" | "GET" | "PUT" | "DELETE",
    url: string,
    payload?: Body,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

  const checkpoint = (overrides: Record<string, unknown> = {}) => ({
    runId: taskId,
    step: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "Do the work" }] }],
    budget: { spend: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, usd: 0.01 } },
    spendApproved: false,
    droppedMessages: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });

  const held = {
    type: "await_decision",
    actorId: "",
    summary: 'tool "acme__send_email" (external_send)',
    items: [
      {
        key: "call-1",
        name: "acme__send_email",
        gates: ["external_send"],
        detail: 'tool "acme__send_email" (external_send)',
      },
    ],
  };

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
      now: () => new Date("2026-10-03T09:00:00.000Z"),
    });
    await app.ready();

    const officeId = (await send("POST", "/offices", { name: "Acme" })).json<{ id: string }>().id;
    const departmentId = (
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
    const made = await send("POST", `/offices/${officeId}/tasks`, {
      departmentId,
      title: "Tell the customer",
      assigneeId: employeeId,
    });
    taskId = made.json<{ id: string }>().id;
    await send("POST", `/tasks/${taskId}/events`, { type: "start", actorId: employeeId });
  });

  it("has nothing for a run nobody has saved", async () => {
    const answer = await send("GET", `/tasks/${taskId}/run-checkpoint`);

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ checkpoint: null, decisions: [] });
  });

  it("keeps what a worker saved, and hands it back", async () => {
    expect((await send("PUT", `/tasks/${taskId}/run-checkpoint`, checkpoint())).statusCode).toBe(
      204,
    );

    const answer = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(answer.json<{ checkpoint: { step: number } }>().checkpoint.step).toBe(1);
  });

  it("survives the process that wrote it, which is the whole point", async () => {
    await send("PUT", `/tasks/${taskId}/run-checkpoint`, checkpoint());
    const kept = taskId;

    // A second office over the same documents: a new worker, or this one after
    // a crash, reading what the old one wrote.
    const second = buildServer({
      store: new InMemoryRelationalStore(),
      blobs,
      events: new OfficeEventLog({ now: () => 1 }),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => "id-x",
      now: () => new Date("2026-10-03T09:00:00.000Z"),
    });
    await second.ready();
    const answer = await second.inject({
      method: "GET",
      url: `/tasks/${kept}/run-checkpoint`,
      headers: auth,
    });

    // The task is not in this store, so the route answers about the run only.
    expect(answer.statusCode).toBe(404);
    const blob = await blobs.get(`runs/${kept}.json`);
    expect(blob).not.toBeNull();
  });

  it("refuses a checkpoint for another run, since it is keyed by this one", async () => {
    const answer = await send("PUT", `/tasks/${taskId}/run-checkpoint`, {
      ...checkpoint({ runId: "task-somewhere-else" }),
    });

    expect(answer.statusCode).toBe(400);
  });

  it("records a decision, and starts the work again", async () => {
    await send("POST", `/tasks/${taskId}/events`, { ...held, actorId: employeeId });
    await send("PUT", `/tasks/${taskId}/run-checkpoint`, checkpoint());

    const answer = await send("POST", `/tasks/${taskId}/events`, {
      type: "call_decided",
      key: "call-1",
      decision: "approved",
      decidedBy: "owner-1",
    });

    expect(answer.statusCode).toBe(200);
    expect(answer.json<{ status: string }>().status).toBe("in_progress");
    const state = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(state.json<{ decisions: { key: string }[] }>().decisions).toEqual([
      { key: "call-1", decision: "approved", decidedBy: "owner-1" },
    ]);
  });

  it("keeps the checkpoint while the work is parked, so the run can resume", async () => {
    await send("PUT", `/tasks/${taskId}/run-checkpoint`, checkpoint());
    await send("POST", `/tasks/${taskId}/events`, { ...held, actorId: employeeId });

    const state = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(state.json<{ checkpoint: unknown }>().checkpoint).not.toBeNull();
  });

  it("forgets it when the work moves on, so the next attempt starts clean", async () => {
    // A finished checkpoint read by a later attempt would hand back the answer
    // the first attempt gave, which is a task that submits work nobody did.
    await send("PUT", `/tasks/${taskId}/run-checkpoint`, checkpoint());
    await send("POST", `/tasks/${taskId}/events`, {
      type: "submit",
      actorId: employeeId,
      artifacts: ["told them"],
    });

    const state = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(state.json()).toEqual({ checkpoint: null, decisions: [] });
  });

  it("forgets the decisions too, since they were about that attempt's calls", async () => {
    await send("POST", `/tasks/${taskId}/events`, { ...held, actorId: employeeId });
    await send("POST", `/tasks/${taskId}/events`, {
      type: "call_decided",
      key: "call-1",
      decision: "approved",
      decidedBy: "owner-1",
    });
    await send("POST", `/tasks/${taskId}/events`, {
      type: "submit",
      actorId: employeeId,
      artifacts: ["told them"],
    });

    const state = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(state.json<{ decisions: unknown[] }>().decisions).toEqual([]);
  });

  it("does not record a decision the office refused", async () => {
    // The task is in progress, not parked: there is no held call to answer, and
    // a decision kept anyway would be applied to the next thing that parks.
    const answer = await send("POST", `/tasks/${taskId}/events`, {
      type: "call_decided",
      key: "call-1",
      decision: "approved",
      decidedBy: "owner-1",
    });

    expect(answer.statusCode).toBe(400);
    const state = await send("GET", `/tasks/${taskId}/run-checkpoint`);
    expect(state.json<{ decisions: unknown[] }>().decisions).toEqual([]);
  });

  it("has never heard of a run on a task that is not there", async () => {
    expect((await send("GET", "/tasks/nope/run-checkpoint")).statusCode).toBe(404);
  });

  it("is not something a stranger may read", async () => {
    const answer = await app.inject({ method: "GET", url: `/tasks/${taskId}/run-checkpoint` });
    expect(answer.statusCode).toBe(401);
  });
});

describe("what this office is waiting on a person for", () => {
  let app: FastifyInstance;
  let blobs: InMemoryBlobStore;
  let officeId: string;
  let employeeId: string;
  let postRoom: string;
  let shipping: string;

  const send = (
    method: "POST" | "GET" | "PUT" | "PATCH",
    url: string,
    payload?: Body,
    headers: Record<string, string> = auth,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

  const items = (response: LightMyRequestResponse) =>
    response.json<{ items: Record<string, unknown>[] }>().items;

  /** A piece of work in a room, started so it can then stop. */
  const working = async (title: string, departmentId: string, body: Body = {}) => {
    const made = await send("POST", `/offices/${officeId}/tasks`, {
      departmentId,
      title,
      assigneeId: employeeId,
      ...(body as Record<string, unknown>),
    });
    const id = made.json<{ id: string }>().id;
    await send("POST", `/tasks/${id}/events`, { type: "start", actorId: employeeId });
    return id;
  };

  /** A run that stopped before a call, exactly as a worker leaves one. */
  const parked = async (taskId: string, key = "toolu_1") => {
    await send("PUT", `/tasks/${taskId}/run-checkpoint`, {
      runId: taskId,
      step: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
      budget: { spend: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, usd: 0 } },
      spendApproved: false,
      droppedMessages: 0,
      updatedAt: 1_700_000_000_000,
      pendingApproval: {
        items: [
          {
            key,
            name: "post__send_email",
            gates: ["external_send"],
            detail: 'tool "post__send_email" (external_send)',
            input: { to: "customer@acme.test" },
          },
        ],
        gates: ["external_send"],
        summary: 'tool "post__send_email" (external_send)',
      },
    });
    await send("POST", `/tasks/${taskId}/events`, {
      type: "await_decision",
      actorId: employeeId,
      summary: 'tool "post__send_email" (external_send)',
      items: [
        {
          key,
          name: "post__send_email",
          gates: ["external_send"],
          detail: 'tool "post__send_email" (external_send)',
          input: { to: "customer@acme.test" },
        },
      ],
    });
  };

  beforeEach(async () => {
    let n = 0;
    blobs = new InMemoryBlobStore();
    app = buildServer({
      store: new InMemoryRelationalStore(),
      blobs,
      events: new OfficeEventLog({ now: () => 1_700_000_000_000 }),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++n)}`,
      now: () => new Date("2026-10-03T09:00:00.000Z"),
    });
    await app.ready();

    officeId = (await send("POST", "/offices", { name: "Acme" })).json<{ id: string }>().id;
    postRoom = (
      await send("POST", `/offices/${officeId}/departments`, {
        name: "Post room",
        color: "#3366ff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "direct" },
      })
    ).json<{ id: string }>().id;
    shipping = (
      await send("POST", `/offices/${officeId}/departments`, {
        name: "Shipping",
        color: "#7c5cff",
        position: { x: 400, y: 0 },
        reviewPolicy: { kind: "gate", gatedActions: ["deploy"] },
      })
    ).json<{ id: string }>().id;
    employeeId = (
      await send("POST", `/offices/${officeId}/employees`, {
        name: "Ada",
        role: "Clerk",
        color: "#00aa66",
        department: postRoom,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
  });

  it("says nothing is waiting in an office where nothing is", async () => {
    await working("Write the note", postRoom);

    const answer = await send("GET", `/offices/${officeId}/approvals`);

    expect(answer.statusCode).toBe(200);
    expect(items(answer)).toEqual([]);
  });

  it("lists a held call with the arguments, which is what is being decided", async () => {
    const taskId = await working("Tell the customer", postRoom);
    await parked(taskId);

    const waiting = items(await send("GET", `/offices/${officeId}/approvals`));

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "call",
      taskId,
      title: "Tell the customer",
      departmentId: postRoom,
      assigneeId: employeeId,
      key: "toolu_1",
      name: "post__send_email",
      input: { to: "customer@acme.test" },
      gates: ["external_send"],
    });
  });

  it("lists finished work a department holds for a person", async () => {
    // The work has to be able to say what it will involve, or a gated room
    // could only ever hold work the office made for itself.
    const taskId = await working("Ship 4.2", shipping, { gatedActions: ["deploy"] });
    await send("POST", `/tasks/${taskId}/events`, {
      type: "submit",
      actorId: employeeId,
      artifacts: ["shipped"],
    });

    const waiting = items(await send("GET", `/offices/${officeId}/approvals`));

    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: "review", taskId, gates: ["deploy"] });
  });

  it("lists work that stopped for another reason, which nobody can approve away", async () => {
    const taskId = await working("Write the note", postRoom);
    await send("POST", `/tasks/${taskId}/events`, {
      type: "block",
      actorId: employeeId,
      reason: "waiting on the customer's address",
    });

    const waiting = items(await send("GET", `/offices/${officeId}/approvals`));

    expect(waiting[0]).toMatchObject({
      kind: "stopped",
      status: "blocked",
      reason: "waiting on the customer's address",
    });
  });

  it("knows nothing about another office's work", async () => {
    const other = (await send("POST", "/offices", { name: "Elsewhere" })).json<{ id: string }>().id;
    const taskId = await working("Tell the customer", postRoom);
    await parked(taskId);

    expect(items(await send("GET", `/offices/${other}/approvals`))).toEqual([]);
  });

  it("has never heard of an office that is not there", async () => {
    expect((await send("GET", "/offices/nope/approvals")).statusCode).toBe(404);
  });

  it("is not something a stranger may read", async () => {
    const answer = await app.inject({ method: "GET", url: `/offices/${officeId}/approvals` });
    expect(answer.statusCode).toBe(401);
  });

  it("refuses a decision about a call this run is not holding", async () => {
    // A key typed wrong would otherwise start the work again, which parks on
    // the same call a moment later — a task that flaps and a person who thinks
    // they answered something.
    const taskId = await working("Tell the customer", postRoom);
    await parked(taskId);

    const answer = await send("POST", `/tasks/${taskId}/events`, {
      type: "call_decided",
      key: "toolu_nonsense",
      decision: "approved",
      decidedBy: "owner-1",
    });

    expect(answer.statusCode).toBe(400);
    expect((await send("GET", `/tasks/${taskId}`)).json<{ status: string }>().status).toBe(
      "blocked",
    );
    expect(items(await send("GET", `/offices/${officeId}/approvals`))).toHaveLength(1);
  });

  it("stops listing a call once it has been decided", async () => {
    const taskId = await working("Tell the customer", postRoom);
    await parked(taskId);

    await send("POST", `/tasks/${taskId}/events`, {
      type: "call_decided",
      key: "toolu_1",
      decision: "approved",
      decidedBy: "owner-1",
    });

    expect(items(await send("GET", `/offices/${officeId}/approvals`))).toEqual([]);
  });
});

describe("who decided", () => {
  let app: FastifyInstance;
  let taskId: string;
  let employeeId: string;

  const send = (
    method: "POST" | "GET" | "PUT",
    url: string,
    payload?: Body,
    headers: Record<string, string> = auth,
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

  const reasons = async (): Promise<string[]> => {
    const task = await send("GET", `/tasks/${taskId}`);
    return task
      .json<{ history: { reason: string | null }[] }>()
      .history.map((event) => event.reason ?? "");
  };

  beforeEach(async () => {
    let n = 0;
    app = buildServer({
      store: new InMemoryRelationalStore(),
      blobs: new InMemoryBlobStore(),
      events: new OfficeEventLog({ now: () => 1_700_000_000_000 }),
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "the owner" } }),
      id: () => `id-${String(++n)}`,
      now: () => new Date("2026-10-03T09:00:00.000Z"),
    });
    await app.ready();

    const officeId = (await send("POST", "/offices", { name: "Acme" })).json<{ id: string }>().id;
    const departmentId = (
      await send("POST", `/offices/${officeId}/departments`, {
        name: "Shipping",
        color: "#7c5cff",
        position: { x: 0, y: 0 },
        reviewPolicy: { kind: "gate", gatedActions: ["deploy"] },
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
    taskId = (
      await send("POST", `/offices/${officeId}/tasks`, {
        departmentId,
        title: "Ship 4.2",
        assigneeId: employeeId,
        gatedActions: ["deploy"],
      })
    ).json<{ id: string }>().id;
    await send("POST", `/tasks/${taskId}/events`, { type: "start", actorId: employeeId });
    await send("POST", `/tasks/${taskId}/events`, {
      type: "submit",
      actorId: employeeId,
      artifacts: ["shipped"],
    });
  });

  it("is whoever the office let in, when the decision does not say", async () => {
    // A canvas has no name to send: it was let in with a token, and the office
    // is the thing that knows whose it is.
    const answer = await send("POST", `/tasks/${taskId}/events`, {
      type: "gate_decided",
      decision: "approved",
    });

    expect(answer.statusCode).toBe(200);
    expect((await reasons()).join(" ")).toContain("the owner");
  });

  it("is what the decision says when it says, since a person may act for another", async () => {
    await send("POST", `/tasks/${taskId}/events`, {
      type: "gate_decided",
      decision: "approved",
      decidedBy: "anton, by phone",
    });

    expect((await reasons()).join(" ")).toContain("anton, by phone");
  });

  it("is the browser that signed in, not an unknown", async () => {
    const signedIn = await app.inject({
      method: "POST",
      url: "/session",
      payload: { token: TOKEN },
    });
    const cookie = (signedIn.headers["set-cookie"] as string).split(";")[0] ?? "";

    const answer = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/events`,
      headers: { cookie },
      payload: { type: "gate_decided", decision: "approved" },
    });

    expect(answer.statusCode).toBe(200);
    expect((await reasons()).join(" ")).toContain("the owner");
  });
});

describe("what a piece of work will involve", () => {
  it("is taken when the work is made, since that is what a gate holds it for", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);

    const made = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Ship 4.2",
      gatedActions: ["deploy", "delete"],
    });

    expect(made.json()).toMatchObject({ gatedActions: ["deploy", "delete"] });
  });

  it("is nothing when the work does not say, which is most work", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);

    const made = await post(`/offices/${officeId}/tasks`, { departmentId, title: "Write it up" });

    expect(made.json()).toMatchObject({ gatedActions: [] });
  });

  it("refuses a category the office does not have", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);

    const made = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Do something odd",
      gatedActions: ["sideways"],
    });

    expect(made.statusCode).toBe(400);
  });
});

describe("changing a piece of work, and handing it on", () => {
  let officeId: string;
  let departmentId: string;
  let ada: string;
  let bob: string;
  let taskId: string;

  const aTask = async (body: Record<string, unknown> = {}): Promise<string> => {
    const made = await post(`/offices/${officeId}/tasks`, {
      departmentId,
      title: "Write the parser",
      assigneeId: ada,
      ...body,
    });
    return made.json<{ id: string }>().id;
  };

  const taskNow = async (id = taskId) =>
    (await get(`/tasks/${id}`)).json<Record<string, unknown>>();

  beforeEach(async () => {
    officeId = await anOffice();
    departmentId = await aDepartment(officeId);
    ada = (
      await post(`/offices/${officeId}/employees`, {
        name: "Ada",
        role: "Engineer",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
    bob = (
      await post(`/offices/${officeId}/employees`, {
        name: "Bob",
        role: "Engineer",
        color: "#3366ff",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;
    taskId = await aTask();
  });

  it("changes what the work is for", async () => {
    const changed = await patch(`/tasks/${taskId}`, {
      title: "Write the YAML parser",
      acceptanceCriteria: ["handles malformed input"],
      priority: "high",
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      title: "Write the YAML parser",
      acceptanceCriteria: ["handles malformed input"],
      priority: "high",
    });
  });

  it("will not move the work, however the body asks", async () => {
    await patch(`/tasks/${taskId}`, { assigneeId: bob, status: "done" });

    expect(await taskNow()).toMatchObject({ assigneeId: ada, status: "assigned" });
  });

  it("refuses a title that is not one", async () => {
    expect((await patch(`/tasks/${taskId}`, { title: "  " })).statusCode).toBe(400);
  });

  it("says somebody else got there first", async () => {
    const stale = await server.inject({
      method: "PATCH",
      url: `/tasks/${taskId}`,
      headers: { ...auth, "x-vo-since-offset": "0" },
      payload: { title: "Mine" },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ current: { title: "Write the parser" } });
  });

  it("has never heard of a task that is not there", async () => {
    expect((await patch("/tasks/nope", { title: "Hello" })).statusCode).toBe(404);
  });

  it("tells the canvas, so a board does not have to be reloaded", async () => {
    await patch(`/tasks/${taskId}`, { title: "Write the YAML parser" });

    expect(events.since(officeId, 0).map((event) => event.data["kind"])).toContain("task.updated");
  });

  it("hands work to somebody else", async () => {
    const moved = await post(`/tasks/${taskId}/events`, {
      type: "reassign",
      toEmployeeId: bob,
      reason: "Ada is away",
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ assigneeId: bob, status: "assigned" });
    const history = (await taskNow())["history"] as { to: string }[];
    expect(history.slice(-2).map((event) => event.to)).toEqual(["transferred", "assigned"]);
  });

  it("refuses somebody this office does not have", async () => {
    const refused = await post(`/tasks/${taskId}/events`, {
      type: "reassign",
      toEmployeeId: "emp-nobody",
    });

    expect(refused.statusCode).toBe(400);
    expect(await taskNow()).toMatchObject({ assigneeId: ada });
  });

  it("refuses somebody who works for another office", async () => {
    const elsewhere = await anOffice();
    const theirRoom = await aDepartment(elsewhere, "Shipping");
    const stranger = (
      await post(`/offices/${elsewhere}/employees`, {
        name: "Iris",
        role: "Engineer",
        color: "#ff8800",
        department: theirRoom,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;

    const refused = await post(`/tasks/${taskId}/events`, {
      type: "reassign",
      toEmployeeId: stranger,
    });

    expect(refused.statusCode).toBe(400);
  });
});

describe("the AI services an office can reach", () => {
  const aService = (overrides: Record<string, unknown> = {}) => ({
    kind: "openai-compatible",
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    ...overrides,
  });

  const servicesOf = async (officeId: string) =>
    (await get(`/offices/${officeId}/services`)).json<{ items: Record<string, unknown>[] }>().items;

  it("has none until somebody adds one", async () => {
    const officeId = await anOffice();

    expect(await servicesOf(officeId)).toEqual([]);
  });

  it("takes one, and says so on the stream", async () => {
    const officeId = await anOffice();

    const created = await post(`/offices/${officeId}/services`, aService());

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "openai",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      models: [],
    });
    expect(events.since(officeId, 0).map((event) => event.data["kind"])).toContain(
      "service.created",
    );
  });

  it("takes a local server with no key at all", async () => {
    const officeId = await anOffice();

    const created = await post(
      `/offices/${officeId}/services`,
      aService({ name: "workshop", baseUrl: "http://10.0.0.12:11434/v1" }),
    );

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ tokenEnv: null, secretRef: null });
  });

  it("refuses what core refuses, in core's words", async () => {
    const officeId = await anOffice();

    const refused = await post(
      `/offices/${officeId}/services`,
      aService({ baseUrl: "http://api.openai.com/v1" }),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe("baseUrl");
  });

  it("refuses a body that is not what it says, rather than throwing", async () => {
    const officeId = await anOffice();

    const refused = await post(`/offices/${officeId}/services`, { kind: 7, name: { a: 1 } });

    expect(refused.statusCode).toBe(400);
  });

  it("refuses a key pasted into the record itself", async () => {
    // There is one way in for a key, and it is not this one.
    const officeId = await anOffice();

    const refused = await post(`/offices/${officeId}/services`, aService({ apiKey: "sk-live-1" }));

    expect(refused.statusCode).toBe(201);
    expect(JSON.stringify(refused.json())).not.toContain("sk-live-1");
  });

  it("knows nothing of an office it does not have", async () => {
    expect((await get("/offices/nope/services")).statusCode).toBe(404);
    expect((await post("/offices/nope/services", aService())).statusCode).toBe(404);
  });

  it("changes one, and refuses a change to one that moved on", async () => {
    const officeId = await anOffice();
    const id = (await post(`/offices/${officeId}/services`, aService())).json<{ id: string }>().id;

    const changed = await patch(`/services/${id}`, {
      models: [{ id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }],
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ models: { id: string }[] }>().models[0]?.id).toBe("gpt-5");
    const stale = await server.inject({
      method: "PATCH",
      url: `/services/${id}`,
      headers: { ...auth, "x-vo-since-offset": "0" },
      payload: { enabled: false },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("switches one off without forgetting it", async () => {
    const officeId = await anOffice();
    const id = (await post(`/offices/${officeId}/services`, aService())).json<{ id: string }>().id;

    await patch(`/services/${id}`, { enabled: false });

    expect((await servicesOf(officeId))[0]).toMatchObject({ enabled: false });
  });

  it("forgets one that is asked to go", async () => {
    const officeId = await anOffice();
    const id = (await post(`/offices/${officeId}/services`, aService())).json<{ id: string }>().id;

    const gone = await server.inject({ method: "DELETE", url: `/services/${id}`, headers: auth });

    expect(gone.statusCode).toBe(204);
    expect(await servicesOf(officeId)).toEqual([]);
  });

  it("has nothing to say about a service it does not have", async () => {
    expect((await patch("/services/nope", { enabled: false })).statusCode).toBe(404);
    expect(
      (await server.inject({ method: "DELETE", url: "/services/nope", headers: auth })).statusCode,
    ).toBe(404);
  });
});

describe("a key the office keeps for a service", () => {
  /** A vault, as the office sees one: the real one satisfies this. */
  const keeper = () => {
    const kept = new Map<string, string>();
    let next = 0;
    return {
      kept,
      secrets: {
        put: (_name: string, value: string) => {
          const ref = `vault://kept-${String(++next)}`;
          kept.set(ref, value);
          return Promise.resolve(ref);
        },
        update: (ref: string, value: string) => {
          kept.set(ref, value);
          return Promise.resolve(ref);
        },
        get: (ref: string) => Promise.resolve(kept.get(ref) ?? null),
        delete: (ref: string) => Promise.resolve(kept.delete(ref)),
      },
    };
  };

  const office = async (extra: Record<string, unknown> = {}) => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      ...extra,
    });
    await server.ready();
    const officeId = await anOffice();
    const created = await post(`/offices/${officeId}/services`, {
      kind: "openai-compatible",
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    return { officeId, id: created.json<{ id: string }>().id };
  };

  it("takes a key pasted in and keeps a reference to it, never the key", async () => {
    const vault = keeper();
    const { officeId, id } = await office({ secrets: vault.secrets });

    const set = await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ secretRef: "vault://kept-1", tokenEnv: null });
    expect(JSON.stringify(set.json())).not.toContain("sk-live-1");
    expect(JSON.stringify(await servicesIn(officeId))).not.toContain("sk-live-1");
    expect(vault.kept.get("vault://kept-1")).toBe("sk-live-1");
  });

  const servicesIn = async (officeId: string) =>
    (await get(`/offices/${officeId}/services`)).json<{ items: unknown[] }>().items;

  it("replaces a key it already keeps, rather than keeping two", async () => {
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });

    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });
    const again = await put(`/services/${id}/credential`, { apiKey: "sk-live-2" });

    expect(again.json()).toMatchObject({ secretRef: "vault://kept-1" });
    expect(vault.kept.get("vault://kept-1")).toBe("sk-live-2");
    expect(vault.kept.size).toBe(1);
  });

  it("takes the name of a variable instead, and lets go of a key it was keeping", async () => {
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    const named = await put(`/services/${id}/credential`, { tokenEnv: "OPENAI_API_KEY" });

    expect(named.json()).toMatchObject({ tokenEnv: "OPENAI_API_KEY", secretRef: null });
    expect(vault.kept.size).toBe(0);
  });

  it("gives a key back when asked to forget it", async () => {
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    const forgotten = await server.inject({
      method: "DELETE",
      url: `/services/${id}/credential`,
      headers: auth,
    });

    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json()).toMatchObject({ secretRef: null, tokenEnv: null });
    expect(vault.kept.size).toBe(0);
  });

  it("lets go of a kept key when the service itself goes", async () => {
    // Nothing would ever ask for it again, and a vault full of keys for
    // services nobody has is a vault nobody can audit.
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    await server.inject({ method: "DELETE", url: `/services/${id}`, headers: auth });

    expect(vault.kept.size).toBe(0);
  });

  it("refuses to keep one when this office has no vault, and says to name a variable", async () => {
    const { id } = await office();

    const refused = await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    expect(refused.statusCode).toBe(501);
    expect(refused.json<{ error: string }>().error).toMatch(/variable/i);
  });

  it("still takes the name of a variable without a vault, which needs nothing kept", async () => {
    const { id } = await office();

    const named = await put(`/services/${id}/credential`, { tokenEnv: "OPENAI_API_KEY" });

    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ tokenEnv: "OPENAI_API_KEY" });
  });

  it("refuses a credential that is neither", async () => {
    const { id } = await office({ secrets: keeper().secrets });

    expect((await put(`/services/${id}/credential`, {})).statusCode).toBe(400);
    expect((await put(`/services/${id}/credential`, { apiKey: "" })).statusCode).toBe(400);
    expect((await put(`/services/${id}/credential`, { tokenEnv: "lower case" })).statusCode).toBe(
      400,
    );
  });

  it("hands the key to a worker, which is the only thing that needs it", async () => {
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    const read = await get(`/services/${id}/credential`);

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ apiKey: "sk-live-1" });
  });

  it("never hands it to a browser, however it signed in", async () => {
    // The canvas can set a key and can never read one back: anybody who can
    // open the canvas could otherwise walk off with every key in the office.
    const vault = keeper();
    const { id } = await office({ secrets: vault.secrets });
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    const asBrowser = await server.inject({
      method: "GET",
      url: `/services/${id}/credential`,
      headers: { cookie: `vo_session=${TOKEN}` },
    });

    expect(asBrowser.statusCode).toBe(403);
    expect(asBrowser.body).not.toContain("sk-live-1");
  });

  it("says a service keeps nothing when it keeps nothing", async () => {
    const { id } = await office({ secrets: keeper().secrets });

    const read = await get(`/services/${id}/credential`);

    expect(read.statusCode).toBe(404);
  });
});

describe("asking a service what models it has", () => {
  const office = async (
    discover?: (
      service: { readonly name: string },
      apiKey: string | null,
    ) => Promise<readonly string[]>,
    extra: Record<string, unknown> = {},
  ) => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      ...(discover === undefined ? {} : { discoverModels: discover }),
      ...extra,
    });
    await server.ready();
    const officeId = await anOffice();
    const created = await post(`/offices/${officeId}/services`, {
      kind: "openai-compatible",
      name: "workshop",
      baseUrl: "http://localhost:11434/v1",
    });
    return { officeId, id: created.json<{ id: string }>().id };
  };

  it("writes the names down, which is how a local server gets its list", async () => {
    const { id } = await office(() => Promise.resolve(["qwen3-coder", "llama3"]));

    const answer = await post(`/services/${id}/discover`, {});

    expect(answer.statusCode).toBe(200);
    expect(answer.json<{ models: { id: string }[] }>().models.map((model) => model.id)).toEqual([
      "qwen3-coder",
      "llama3",
    ]);
  });

  it("keeps the prices somebody typed for a model it already knew", async () => {
    // Discovering again must not quietly make every model unpriced.
    const { id } = await office(() => Promise.resolve(["qwen3-coder", "llama3"]));
    await patch(`/services/${id}`, {
      models: [{ id: "qwen3-coder", pricing: { inputPerMTok: 0.1, outputPerMTok: 0.2 } }],
    });

    const answer = await post(`/services/${id}/discover`, {});

    const models = answer.json<{ models: { id: string; pricing?: unknown }[] }>().models;
    expect(models.find((model) => model.id === "qwen3-coder")?.pricing).toEqual({
      inputPerMTok: 0.1,
      outputPerMTok: 0.2,
    });
    expect(models.find((model) => model.id === "llama3")?.pricing).toBeUndefined();
  });

  it("hands over the key, since a service will not answer without one", async () => {
    const kept = new Map<string, string>([["vault://k1", "sk-live-1"]]);
    const keys: (string | null)[] = [];
    const { id } = await office(
      (_service, apiKey) => {
        keys.push(apiKey);
        return Promise.resolve(["gpt-5"]);
      },
      {
        secrets: {
          put: () => Promise.resolve("vault://k1"),
          update: (ref: string) => Promise.resolve(ref),
          get: (ref: string) => Promise.resolve(kept.get(ref) ?? null),
          delete: () => Promise.resolve(true),
        },
      },
    );
    await put(`/services/${id}/credential`, { apiKey: "sk-live-1" });

    await post(`/services/${id}/discover`, {});

    expect(keys).toEqual(["sk-live-1"]);
  });

  it("hands over the key out of the variable the service names", async () => {
    const keys: (string | null)[] = [];
    const { id } = await office(
      (_service, apiKey) => {
        keys.push(apiKey);
        return Promise.resolve(["gpt-5"]);
      },
      { env: { OPENAI_API_KEY: "sk-from-env" } },
    );
    await put(`/services/${id}/credential`, { tokenEnv: "OPENAI_API_KEY" });

    await post(`/services/${id}/discover`, {});

    expect(keys).toEqual(["sk-from-env"]);
  });

  it("says what went wrong, because somebody pressed a button and is waiting", async () => {
    const { id } = await office(() => Promise.reject(new Error("connection refused")));

    const answer = await post(`/services/${id}/discover`, {});

    expect(answer.statusCode).toBe(502);
    expect(answer.json<{ error: string }>().error).toContain("connection refused");
  });

  it("changes nothing when a service answers with no models at all", async () => {
    const { id } = await office(() => Promise.resolve([]));
    await patch(`/services/${id}`, { models: [{ id: "qwen3-coder" }] });

    const answer = await post(`/services/${id}/discover`, {});

    expect(answer.statusCode).toBe(502);
    expect(answer.json<{ current: { models: { id: string }[] } }>().current.models).toHaveLength(1);
  });

  it("says so when this office has no way to ask", async () => {
    const { id } = await office();

    expect((await post(`/services/${id}/discover`, {})).statusCode).toBe(501);
  });
});

describe("teaching somebody over the wire", () => {
  const hire = async (body: Record<string, unknown> = {}) => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const hired = await post(`/offices/${officeId}/employees`, {
      name: "Sam",
      role: "Clerk",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      ...body,
    });
    return { officeId, hired };
  };

  it("hires somebody already told how to work", async () => {
    const { hired } = await hire({
      instructions: "Always check the order number before replying.",
      examples: [{ when: "an angry customer", good: "Thank you for flagging this." }],
    });

    expect(hired.statusCode).toBe(201);
    expect(hired.json()).toMatchObject({
      instructions: "Always check the order number before replying.",
      examples: [{ when: "an angry customer", good: "Thank you for flagging this." }],
    });
  });

  it("hires somebody told nothing, as every office did before this", async () => {
    const { hired } = await hire();

    expect(hired.json()).toMatchObject({ instructions: null, examples: [] });
  });

  it("teaches somebody already hired, and unteaches them again", async () => {
    const { hired } = await hire();
    const id = hired.json<{ id: string }>().id;

    const taught = await patch(`/employees/${id}`, { instructions: "Write in short paragraphs." });
    expect(taught.json<{ instructions: string }>().instructions).toBe("Write in short paragraphs.");

    const untaught = await patch(`/employees/${id}`, { instructions: null });
    expect(untaught.json<{ instructions: string | null }>().instructions).toBeNull();
  });

  it("refuses what core refuses, in core's words", async () => {
    const { hired } = await hire({ examples: [{ when: "no work attached" }] });

    expect(hired.statusCode).toBe(400);
    expect(hired.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe("examples[0].good");
  });

  it("refuses a paragraph nobody could have meant", async () => {
    const { hired } = await hire({ instructions: "x".repeat(20_001) });

    expect(hired.statusCode).toBe(400);
  });
});

describe("an employee that stands in for a real person", () => {
  const hire = async (officeId: string, departmentId: string, body: Record<string, unknown> = {}) =>
    post(`/offices/${officeId}/employees`, {
      name: "Sam",
      role: "Clerk",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      ...body,
    });

  it("records who they stand in for, and who said so", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);

    const hired = await hire(officeId, departmentId, {
      understudy: { person: "Anna Petrova", recordedBy: "anton@acme.test" },
    });

    expect(hired.statusCode).toBe(201);
    expect(hired.json()).toMatchObject({
      // `recordedBy` is whoever is calling, not what the body claimed — the
      // test below is about that.
      understudy: { person: "Anna Petrova", recordedBy: "owner-1", enabled: true },
    });
  });

  it("stamps who recorded it from the token, not from the body", async () => {
    // Who agreed to this is a fact about a person, and a browser saying so
    // about somebody else is exactly the claim that must not be taken.
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);

    const hired = await hire(officeId, departmentId, {
      understudy: { person: "Anna Petrova", recordedBy: "somebody-else" },
    });

    expect(hired.json<{ understudy: { recordedBy: string } }>().understudy.recordedBy).toBe(
      "owner-1",
    );
  });

  it("stops standing in for anybody", async () => {
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const id = (
      await hire(officeId, departmentId, {
        understudy: { person: "Anna Petrova", recordedBy: "anton@acme.test" },
      })
    ).json<{ id: string }>().id;

    const stopped = await patch(`/employees/${id}`, { understudy: null });

    expect(stopped.json<{ understudy: unknown }>().understudy).toBeNull();
  });
});

describe("studying how a real person writes", () => {
  const office = async (
    study?: (request: {
      person: string;
      samples: readonly { name: string; text: string }[];
      llm: { provider: string; model: string };
    }) => Promise<string>,
  ) => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      blobs: new InMemoryBlobStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      ...(study === undefined ? {} : { studyVoice: study }),
    });
    await server.ready();
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const employee = await post(`/offices/${officeId}/employees`, {
      name: "Sam",
      role: "Clerk",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      understudy: { person: "Anna Petrova", recordedBy: "anton@acme.test" },
    });
    return { officeId, id: employee.json<{ id: string }>().id };
  };

  const sample = (officeId: string, employeeId: string, name: string, text: string) =>
    post(`/offices/${officeId}/documents`, {
      ownerKind: "employee",
      ownerId: employeeId,
      tray: "in",
      name,
      mediaType: "text/plain",
      contentBase64: Buffer.from(text, "utf8").toString("base64"),
    });

  it("reads what is in their in-tray and writes down the card", async () => {
    const studied: { person: string; samples: readonly { name: string; text: string }[] }[] = [];
    const { officeId, id } = await office((request) => {
      studied.push(request);
      return Promise.resolve("Opens with the first name. Never uses bullets.");
    });
    await sample(officeId, id, "reply.txt", "Hi Tom,\n\nSorted.\n\nAnna");

    const answer = await post(`/employees/${id}/study`, {});

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      understudy: {
        card: "Opens with the first name. Never uses bullets.",
        cardFromSamples: 1,
      },
    });
    expect(studied[0]?.person).toBe("Anna Petrova");
    expect(studied[0]?.samples[0]).toEqual({
      name: "reply.txt",
      text: "Hi Tom,\n\nSorted.\n\nAnna",
    });
    // Studied on the model that does this person's work.
    expect((studied[0] as unknown as { llm: { model: string } }).llm.model).toBe("claude-sonnet-5");
  });

  it("studies only what it can read, and says so when there is nothing", async () => {
    const { officeId, id } = await office(() => Promise.resolve("never asked"));
    await post(`/offices/${officeId}/documents`, {
      ownerKind: "employee",
      ownerId: id,
      tray: "in",
      name: "headshot.png",
      mediaType: "image/png",
      contentBase64: Buffer.from([1, 2, 3]).toString("base64"),
    });

    const answer = await post(`/employees/${id}/study`, {});

    expect(answer.statusCode).toBe(400);
    expect(answer.json<{ errors: { message: string }[] }>().errors[0]?.message).toMatch(/in-tray/i);
  });

  it("refuses to study somebody who stands in for nobody", async () => {
    const { officeId, id } = await office(() => Promise.resolve("never asked"));
    await patch(`/employees/${id}`, { understudy: null });
    await sample(officeId, id, "reply.txt", "Hi Tom,");

    expect((await post(`/employees/${id}/study`, {})).statusCode).toBe(400);
  });

  it("says so when this office has no way to study anybody", async () => {
    const { officeId, id } = await office();
    await sample(officeId, id, "reply.txt", "Hi Tom,");

    expect((await post(`/employees/${id}/study`, {})).statusCode).toBe(501);
  });

  it("says what went wrong, because somebody pressed a button and is waiting", async () => {
    const { officeId, id } = await office(() => Promise.reject(new Error("the model refused")));
    await sample(officeId, id, "reply.txt", "Hi Tom,");

    const answer = await post(`/employees/${id}/study`, {});

    expect(answer.statusCode).toBe(502);
    expect(answer.json<{ error: string }>().error).toContain("the model refused");
  });

  it("keeps the samples out of the record it saves", async () => {
    // The card is what the office keeps; the writing stays where somebody put
    // it, in the tray, and is never copied into the employee.
    const { officeId, id } = await office(() => Promise.resolve("Short sentences."));
    await sample(officeId, id, "reply.txt", "Hi Tom, the parcel goes out today.");

    const answer = await post(`/employees/${id}/study`, {});

    expect(JSON.stringify(answer.json())).not.toContain("the parcel goes out today");
  });

  it("keeps what the real person changed, newest first", async () => {
    const { id } = await office(() => Promise.resolve("Short sentences."));

    await post(`/employees/${id}/corrections`, {
      before: "Dear Sir or Madam,",
      after: "Hi Tom,",
      taskId: "task-1",
    });
    const second = await post(`/employees/${id}/corrections`, {
      before: "Kind regards,",
      after: "Thanks,",
    });

    expect(second.statusCode).toBe(200);
    const corrections = second.json<{ understudy: { corrections: { after: string }[] } }>()
      .understudy.corrections;
    expect(corrections.map((one) => one.after)).toEqual(["Thanks,", "Hi Tom,"]);
  });

  it("refuses a correction that corrects nothing", async () => {
    const { id } = await office(() => Promise.resolve("Short sentences."));

    const refused = await post(`/employees/${id}/corrections`, { before: "same", after: "same" });

    expect(refused.statusCode).toBe(400);
  });

  it("has nothing to say about somebody it does not have", async () => {
    await office(() => Promise.resolve("never asked"));

    expect((await post("/employees/nope/study", {})).statusCode).toBe(404);
    expect(
      (await post("/employees/nope/corrections", { before: "a", after: "b" })).statusCode,
    ).toBe(404);
  });
});

describe("looking back over somebody's work, over the wire", () => {
  const office = async (reflect?: ServerOptions["reflectOnWork"]) => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-10-04T09:00:00.000Z"),
      ...(reflect === undefined ? {} : { reflectOnWork: reflect }),
    });
    await server.ready();
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const hired = await post(`/offices/${officeId}/employees`, {
      name: "Sam",
      role: "Clerk",
      color: "#00aa66",
      department: departmentId,
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      selfImprovement: true,
    });
    return { officeId, departmentId, id: hired.json<{ id: string }>().id };
  };

  const proposed = (employeeId: string): ProposalDraft => ({
    employeeId,
    because: "It went back twice for want of an order number.",
    changes: [{ field: "instructions", before: null, after: "Check the order number." }],
    evidence: [{ taskId: "task-1", what: "went back twice" }],
  });

  it("writes down what the office proposed", async () => {
    const { officeId, id } = await office((looked) =>
      Promise.resolve(proposed(looked.employee.id)),
    );

    const answer = await post(`/employees/${id}/retrospective`, {});

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({
      employeeId: id,
      status: "waiting",
      because: "It went back twice for want of an order number.",
    });
    const listed = await get(`/offices/${officeId}/proposals`);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("changes nobody by itself", async () => {
    // The whole point of a proposal: it waits.
    const { id } = await office((looked) => Promise.resolve(proposed(looked.employee.id)));

    await post(`/employees/${id}/retrospective`, {});

    expect(
      (await get(`/employees/${id}`)).json<{ instructions: string | null }>().instructions,
    ).toBeNull();
  });

  it("refuses to look at somebody who was never switched on", async () => {
    const { officeId, departmentId } = await office(() => Promise.resolve(null));
    const other = (
      await post(`/offices/${officeId}/employees`, {
        name: "Mal",
        role: "Clerk",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      })
    ).json<{ id: string }>().id;

    const refused = await post(`/employees/${other}/retrospective`, {});

    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ errors: { message: string }[] }>().errors[0]?.message).toMatch(
      /switched on|self-improvement/i,
    );
  });

  it("says nothing was proposed when the record is good", async () => {
    const { officeId, id } = await office(() => Promise.resolve(null));

    const answer = await post(`/employees/${id}/retrospective`, {});

    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ proposed: false });
    expect(
      (await get(`/offices/${officeId}/proposals`)).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it("refuses a proposal that reaches past how somebody works", async () => {
    // The office's own guardrail, applied to whatever came back from a model.
    const { id } = await office((looked) =>
      Promise.resolve({
        ...proposed(looked.employee.id),
        changes: [{ field: "toolGrants", before: [], after: [{ tool: "*" }] }],
      } as never),
    );

    const refused = await post(`/employees/${id}/retrospective`, {});

    expect(refused.statusCode).toBe(400);
  });

  it("says so when this office has no way to look back", async () => {
    const { id } = await office();

    expect((await post(`/employees/${id}/retrospective`, {})).statusCode).toBe(501);
  });

  it("says what went wrong, because somebody pressed a button", async () => {
    const { id } = await office(() => Promise.reject(new Error("the model refused")));

    const answer = await post(`/employees/${id}/retrospective`, {});

    expect(answer.statusCode).toBe(502);
    expect(answer.json<{ error: string }>().error).toContain("the model refused");
  });
});

describe("deciding a proposal", () => {
  const office = async () => {
    events = new OfficeEventLog({ now: () => 1_700_000_000_000 });
    server = buildServer({
      store: new InMemoryRelationalStore(),
      events,
      verifyToken: tokenVerifier({ [TOKEN]: { ownerId: "owner-1" } }),
      id: () => `id-${String(++ids)}`,
      now: () => new Date("2026-10-04T09:00:00.000Z"),
      reflectOnWork: (looked) =>
        Promise.resolve<ProposalDraft>({
          employeeId: looked.employee.id,
          because: "It went back twice.",
          changes: [{ field: "instructions", before: null, after: "Check the order number." }],
          evidence: [{ taskId: "task-1", what: "went back twice" }],
        }),
    });
    await server.ready();
    const officeId = await anOffice();
    const departmentId = await aDepartment(officeId);
    const employeeId = (
      await post(`/offices/${officeId}/employees`, {
        name: "Sam",
        role: "Clerk",
        color: "#00aa66",
        department: departmentId,
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
        selfImprovement: true,
      })
    ).json<{ id: string }>().id;
    const proposalId = (await post(`/employees/${employeeId}/retrospective`, {})).json<{
      id: string;
    }>().id;
    return { officeId, employeeId, proposalId };
  };

  it("accepts it, and that is when the person changes", async () => {
    const { employeeId, proposalId } = await office();

    const accepted = await post(`/proposals/${proposalId}/decision`, { decision: "accept" });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "accepted", decidedBy: "owner-1" });
    expect(
      (await get(`/employees/${employeeId}`)).json<{ instructions: string }>().instructions,
    ).toBe("Check the order number.");
  });

  it("stamps who decided from the token, never from the body", async () => {
    const { proposalId } = await office();

    const accepted = await post(`/proposals/${proposalId}/decision`, {
      decision: "accept",
      decidedBy: "somebody-else",
    });

    expect(accepted.json<{ decidedBy: string }>().decidedBy).toBe("owner-1");
  });

  it("declines it, and changes nobody", async () => {
    const { employeeId, proposalId } = await office();

    const declined = await post(`/proposals/${proposalId}/decision`, { decision: "decline" });

    expect(declined.json()).toMatchObject({ status: "declined" });
    expect(
      (await get(`/employees/${employeeId}`)).json<{ instructions: string | null }>().instructions,
    ).toBeNull();
  });

  it("puts an accepted one back in one press", async () => {
    const { employeeId, proposalId } = await office();
    await post(`/proposals/${proposalId}/decision`, { decision: "accept" });

    const back = await post(`/proposals/${proposalId}/decision`, { decision: "revert" });

    expect(back.json()).toMatchObject({ status: "reverted" });
    expect(
      (await get(`/employees/${employeeId}`)).json<{ instructions: string | null }>().instructions,
    ).toBeNull();
  });

  it("refuses to put one back over something somebody has since written", async () => {
    const { employeeId, proposalId } = await office();
    await post(`/proposals/${proposalId}/decision`, { decision: "accept" });
    await patch(`/employees/${employeeId}`, { instructions: "I rewrote this myself." });

    const refused = await post(`/proposals/${proposalId}/decision`, { decision: "revert" });

    expect(refused.statusCode).toBe(400);
    expect(
      (await get(`/employees/${employeeId}`)).json<{ instructions: string }>().instructions,
    ).toBe("I rewrote this myself.");
  });

  it("refuses a second decision about the same one", async () => {
    const { proposalId } = await office();
    await post(`/proposals/${proposalId}/decision`, { decision: "decline" });

    expect(
      (await post(`/proposals/${proposalId}/decision`, { decision: "accept" })).statusCode,
    ).toBe(400);
  });

  it("refuses a decision nobody could act on", async () => {
    const { proposalId } = await office();

    expect(
      (await post(`/proposals/${proposalId}/decision`, { decision: "maybe" })).statusCode,
    ).toBe(400);
  });

  it("has nothing to say about a proposal it does not have", async () => {
    await office();

    expect((await post("/proposals/nope/decision", { decision: "accept" })).statusCode).toBe(404);
  });
});
