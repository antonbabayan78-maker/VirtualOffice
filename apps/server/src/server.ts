/**
 * The office API.
 *
 * Every write goes through the same core factory the office file and the canvas
 * use, so there is one definition of a valid office rather than three. What core
 * refuses comes back as 400 with the paths that were wrong; what it accepts is
 * stored through the repository interfaces and announced on the event log, which
 * is what lets a canvas follow along without polling.
 *
 * Storage is injected. The server has no idea whether it is talking to SQLite,
 * Postgres or a map in memory, which is the whole point of the repositories.
 */
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  createConnection,
  createDepartment,
  createEmployee,
  createOffice,
  openTaskCounts,
  updateOffice,
  createTask,
  isErr,
  updateDepartment,
  updateEmployee,
  type ConnectionId,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type Result,
  type TaskId,
  type ValidationError,
} from "@vo/core";
import {
  acceptanceCriteriaFor,
  defaultWorkflowEngine,
  performHandoff,
  type WorkflowContext,
  type WorkflowEvent,
} from "@vo/orchestrator";
import type { RelationalStore } from "@vo/storage";
import { bearerToken, type TokenVerifier } from "./auth.js";
import { OfficeEventLog } from "./events.js";

export interface ServerOptions {
  readonly store: RelationalStore;
  readonly verifyToken: TokenVerifier;
  readonly events?: OfficeEventLog;
  readonly id?: () => string;
  readonly now?: () => Date;
  readonly logger?: boolean;
  /**
   * Cuts connections off on close rather than waiting for them to go idle. A
   * refused upgrade leaves a keep-alive socket behind that nobody will ever use
   * again, and waiting for it stalls a shutdown.
   */
  readonly forceCloseConnections?: boolean;
  /**
   * Origins the canvas may be served from. A browser will not call this API
   * from another origin without being told it may, so an empty list means the
   * API is reachable by servers and command lines only.
   */
  readonly allowedOrigins?: readonly string[];
}

/** The events a task may be given; anything else is a client mistake, not a 500. */
const KNOWN_EVENTS: readonly string[] = [
  "start",
  "submit",
  "approve",
  "request_changes",
  "block",
  "unblock",
  "cancel",
  "check_reported",
  "gate_decided",
];

/** Paths anyone may call: a health probe has no credentials to offer. */
const OPEN_PATHS: readonly string[] = ["/health"];

/**
 * A browser cannot set headers on a WebSocket, so the stream takes its token in
 * the query string instead. It is checked before the socket is accepted, never
 * after — an unauthenticated socket is never opened at all.
 */
const WS_PATH = "/ws";

function fail(reply: FastifyReply, errors: readonly ValidationError[]): FastifyReply {
  return reply.code(400).send({ errors });
}

/**
 * The offset a client claims to be working from, when it offers one. A client
 * that says nothing makes no claim to be up to date and gets no protection —
 * which is right for a script, and why the canvas always sends it.
 */
function claimedOffset(request: FastifyRequest): number | null {
  const header = request.headers["x-vo-since-offset"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const offset = Number(raw);
  return Number.isFinite(offset) ? offset : null;
}

function missing(reply: FastifyReply, what: string): FastifyReply {
  return reply.code(404).send({ error: `${what} not found` });
}

/**
 * Reads a string out of an untrusted body, recording it if the client sent
 * something else. Coercing with String() would turn an object into the text
 * "[object Object]" and create a department actually called that.
 */
function text(body: Record<string, unknown>, field: string, errors: ValidationError[]): string {
  const value = body[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    errors.push({ path: field, message: "must be a string" });
    return "";
  }
  return value;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    forceCloseConnections: options.forceCloseConnections ?? false,
  });
  const store = options.store;
  const events = options.events ?? new OfficeEventLog();
  const workflow = defaultWorkflowEngine();
  const newId = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  if (options.allowedOrigins !== undefined && options.allowedOrigins.length > 0) {
    const allowed = new Set(options.allowedOrigins);
    void app.register(cors, {
      origin: (origin, done) => {
        // No origin at all is a server or a command line, which CORS does not
        // govern; a browser always sends one.
        done(null, origin === undefined || allowed.has(origin));
      },
      credentials: true,
      // Named rather than left to default: the default is GET, HEAD and POST,
      // which refuses every save the canvas makes before it is even sent.
      methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["authorization", "content-type", "x-vo-since-offset"],
    });
  }

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done) => {
    const path = request.url.split("?")[0] ?? "";
    if (OPEN_PATHS.includes(path)) {
      done();
      return;
    }
    if (path === WS_PATH) {
      const query = request.query as { token?: string };
      if (query.token === undefined || options.verifyToken(query.token) === null) {
        void reply.code(401).send({ error: "a valid token is required" });
        return;
      }
      done();
      return;
    }
    const token = bearerToken(request.headers.authorization);
    if (token === null || options.verifyToken(token) === null) {
      void reply.code(401).send({ error: "a valid bearer token is required" });
      return;
    }
    done();
  });

  /** Stores what core accepted and says so on the log; returns 201 with it. */
  const created = async <T extends { readonly id: string }>(
    reply: FastifyReply,
    result: Result<T>,
    officeId: string,
    kind: string,
    put: (entity: T) => Promise<void>,
  ): Promise<FastifyReply> => {
    if (isErr(result)) return fail(reply, result.error);
    await put(result.value);
    events.publish(officeId, { kind, id: result.value.id });
    return reply.code(201).send(result.value);
  };

  app.get("/health", () => ({ status: "ok" }));

  // -- the event stream ------------------------------------------------------

  void app.register(websocket);
  void app.register((instance, _opts, done) => {
    instance.get(WS_PATH, { websocket: true }, (socket, request) => {
      const query = request.query as { officeId?: string; since?: string };
      const officeId = query.officeId ?? "";
      const since = Number(query.since ?? 0);

      const send = (payload: unknown): void => {
        // A socket that closed between publish and send is not an error.
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
      };

      // Catch the client up before subscribing, so nothing arrives out of order.
      if (!events.canReplayFrom(officeId, Number.isFinite(since) ? since : 0)) {
        send({
          type: "gap",
          message: "too far behind to be caught up; reload the office",
        });
      } else {
        for (const event of events.since(officeId, Number.isFinite(since) ? since : 0)) {
          send(event);
        }
      }

      const stop = events.subscribe(officeId, send);
      socket.on("close", stop);
      socket.on("error", stop);
    });
    done();
  });

  // -- offices ---------------------------------------------------------------

  app.get("/offices", async () => ({ items: (await store.offices.list()).items }));

  app.post("/offices", async (request, reply) => {
    const body = request.body as { name?: string; schedule?: unknown; priority?: string };
    const office = createOffice(
      {
        name: body.name ?? "",
        ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      },
      { id: () => newId() as OfficeId, now },
    );
    if (isErr(office)) return fail(reply, office.error);
    await store.offices.put(office.value);
    events.publish(office.value.id, { kind: "office.created", id: office.value.id });
    return reply.code(201).send(office.value);
  });

  app.patch("/offices/:officeId", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    const office = await store.offices.get(officeId);
    if (office === null) return missing(reply, "office");

    const since = claimedOffset(request);
    if (since !== null && events.changedSince(office.id, officeId, since)) {
      return reply
        .code(409)
        .send({ error: "this office changed since you loaded it", current: office });
    }

    const updated = updateOffice(office, request.body as Record<string, never>);
    if (isErr(updated)) return fail(reply, updated.error);
    await store.offices.put(updated.value);
    events.publish(office.id, { kind: "office.updated", id: officeId });
    return updated.value;
  });

  app.get("/offices/:officeId", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    const office = await store.offices.get(officeId);
    return office ?? missing(reply, "office");
  });

  // -- departments -----------------------------------------------------------

  app.get("/offices/:officeId/departments", async (request) => {
    const { officeId } = request.params as { officeId: string };
    const page = await store.departments.list({ where: { officeId: officeId as OfficeId } });
    return { items: page.items };
  });

  app.post("/offices/:officeId/departments", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;
    const existing = await store.departments.list({ where: { officeId: officeId as OfficeId } });

    const problems: ValidationError[] = [];
    const name = text(body, "name", problems);
    const color = text(body, "color", problems);
    const icon = body["icon"] === undefined ? undefined : text(body, "icon", problems);
    if (problems.length > 0) return fail(reply, problems);

    return created(
      reply,
      createDepartment(
        {
          officeId: officeId as OfficeId,
          name,
          color,
          position: body["position"] as { x: number; y: number },
          ...(body["size"] === undefined
            ? {}
            : { size: body["size"] as { width: number; height: number } }),
          ...(icon === undefined ? {} : { icon }),
          ...(body["reviewPolicy"] === undefined ? {} : { reviewPolicy: body["reviewPolicy"] }),
          ...(body["schedule"] === undefined ? {} : { schedule: body["schedule"] }),
          ...(body["priority"] === undefined ? {} : { priority: body["priority"] as string }),
          ...(Array.isArray(body["definitionOfDone"])
            ? { definitionOfDone: body["definitionOfDone"] as readonly string[] }
            : {}),
        },
        existing.items,
        { id: () => newId() as DepartmentId, now },
      ),
      officeId,
      "department.created",
      (department) => store.departments.put(department),
    );
  });

  app.get("/departments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const department = await store.departments.get(id);
    return department ?? missing(reply, "department");
  });

  app.patch("/departments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const department = await store.departments.get(id);
    if (department === null) return missing(reply, "department");
    const since = claimedOffset(request);
    if (since !== null && events.changedSince(department.officeId, id, since)) {
      return reply.code(409).send({
        error: "this department changed since you loaded it",
        current: department,
      });
    }
    const siblings = await store.departments.list({ where: { officeId: department.officeId } });

    const updated = updateDepartment(
      department,
      request.body as Record<string, never>,
      siblings.items,
    );
    if (isErr(updated)) return fail(reply, updated.error);
    await store.departments.put(updated.value);
    events.publish(department.officeId, { kind: "department.updated", id });
    return updated.value;
  });

  app.delete("/departments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const department = await store.departments.get(id);
    if (department === null) return missing(reply, "department");
    await store.departments.delete(id);
    events.publish(department.officeId, { kind: "department.deleted", id });
    return reply.code(204).send();
  });

  // -- employees -------------------------------------------------------------

  app.get("/offices/:officeId/employees", async (request) => {
    const { officeId } = request.params as { officeId: string };
    const page = await store.employees.list({ where: { officeId: officeId as OfficeId } });
    return { items: page.items };
  });

  app.post("/offices/:officeId/employees", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;

    const problems: ValidationError[] = [];
    const name = text(body, "name", problems);
    const role = text(body, "role", problems);
    const color = text(body, "color", problems);
    const departmentId = text(body, "department", problems);
    if (problems.length > 0) return fail(reply, problems);

    const department = await store.departments.get(departmentId);
    if (department?.officeId !== officeId) {
      return fail(reply, [{ path: "department", message: "no such department in this office" }]);
    }
    const supervisorId =
      typeof body["supervisorId"] === "string" ? body["supervisorId"] : undefined;
    const supervisor = supervisorId === undefined ? null : await store.employees.get(supervisorId);

    return created(
      reply,
      createEmployee(
        {
          name,
          role,
          color,
          llm: body["llm"],
          ...(supervisorId === undefined ? {} : { supervisorId }),
          ...(body["skills"] === undefined ? {} : { skillIds: body["skills"] as string[] }),
          ...(body["schedule"] === undefined ? {} : { schedule: body["schedule"] }),
          ...(body["priority"] === undefined ? {} : { priority: body["priority"] as string }),
        },
        {
          department: { id: department.id, officeId: department.officeId },
          supervisor:
            supervisor === null
              ? null
              : { id: supervisor.id, officeId: supervisor.officeId, status: supervisor.status },
        },
        { id: () => newId() as EmployeeId, now },
      ),
      officeId,
      "employee.created",
      (employee) => store.employees.put(employee),
    );
  });

  app.get("/employees/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const employee = await store.employees.get(id);
    return employee ?? missing(reply, "employee");
  });

  app.patch("/employees/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const employee = await store.employees.get(id);
    if (employee === null) return missing(reply, "employee");
    const since = claimedOffset(request);
    if (since !== null && events.changedSince(employee.officeId, id, since)) {
      return reply.code(409).send({
        error: "this employee changed since you loaded them",
        current: employee,
      });
    }
    const body = request.body as { supervisorId?: string | null };
    const supervisor =
      body.supervisorId === undefined || body.supervisorId === null
        ? null
        : await store.employees.get(body.supervisorId);

    const updated = updateEmployee(employee, request.body as Record<string, never>, {
      supervisor:
        supervisor === null
          ? null
          : { id: supervisor.id, officeId: supervisor.officeId, status: supervisor.status },
    });
    if (isErr(updated)) return fail(reply, updated.error);
    await store.employees.put(updated.value);
    events.publish(employee.officeId, { kind: "employee.updated", id });
    return updated.value;
  });

  // -- tasks -----------------------------------------------------------------

  app.get("/offices/:officeId/tasks", async (request) => {
    const { officeId } = request.params as { officeId: string };
    const page = await store.tasks.list({ where: { officeId: officeId as OfficeId } });
    return { items: page.items };
  });

  app.post("/offices/:officeId/tasks", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;

    const problems: ValidationError[] = [];
    const title = text(body, "title", problems);
    const departmentId = text(body, "departmentId", problems);
    const brief = body["brief"] === undefined ? undefined : text(body, "brief", problems);
    if (problems.length > 0) return fail(reply, problems);

    return created(
      reply,
      createTask(
        {
          officeId: officeId as OfficeId,
          departmentId: departmentId as DepartmentId,
          title,
          ...(brief === undefined ? {} : { brief }),
          ...(Array.isArray(body["acceptanceCriteria"])
            ? { acceptanceCriteria: body["acceptanceCriteria"] as string[] }
            : {}),
          ...(typeof body["assigneeId"] === "string"
            ? { assigneeId: body["assigneeId"] as EmployeeId }
            : {}),
        },
        { id: () => newId() as TaskId, now },
      ),
      officeId,
      "task.created",
      (task) => store.tasks.put(task),
    );
  });

  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await store.tasks.get(id);
    return task ?? missing(reply, "task");
  });

  /**
   * Moving a task is not a field change, so it is not a PATCH. The office
   * decides what a move means — who reviews, when it escalates — and this hands
   * the event to the same workflow engine the worker uses. One set of rules.
   */
  app.post("/tasks/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await store.tasks.get(id);
    if (task === null) return missing(reply, "task");

    const body = request.body as Record<string, unknown>;
    const type = typeof body["type"] === "string" ? body["type"] : "";
    if (!KNOWN_EVENTS.includes(type)) {
      return fail(reply, [{ path: "type", message: `must be one of ${KNOWN_EVENTS.join(", ")}` }]);
    }

    const department = await store.departments.get(task.departmentId);
    const assignee = task.assigneeId === null ? null : await store.employees.get(task.assigneeId);
    const colleagues = await store.employees.list({ where: { officeId: task.officeId } });
    // What everyone is already holding, so a policy that picks the least loaded
    // reviewer has something to pick on. Told zero for everybody, it falls to
    // its tie-break and hands every review to the same person.
    const load = openTaskCounts(
      (await store.tasks.list({ where: { officeId: task.officeId } })).items,
    );

    const context: WorkflowContext = {
      policy: department?.reviewPolicy ?? { kind: "direct" },
      acceptanceCriteria: acceptanceCriteriaFor(
        task.acceptanceCriteria,
        department?.definitionOfDone ?? [],
      ),
      now: now(),
      supervisorId: assignee?.supervisorId ?? null,
      peers: colleagues.items
        .filter((employee) => employee.departmentId === task.departmentId)
        .map((employee) => ({
          id: employee.id,
          status: employee.status,
          skillIds: employee.skillIds,
          openTasks: load[employee.id] ?? 0,
        })),
      escalationGraph: {
        employees: colleagues.items.map((employee) => ({
          id: employee.id,
          departmentId: employee.departmentId,
          supervisorId: employee.supervisorId,
          status: employee.status,
        })),
        connections: (await store.connections.list({ where: { officeId: task.officeId } })).items,
      },
    };

    const outcome = workflow.handle(task, body as unknown as WorkflowEvent, context);
    if (isErr(outcome)) return fail(reply, outcome.error);

    await store.tasks.put(outcome.value.task);
    events.publish(task.officeId, {
      kind: "task.updated",
      id,
      status: outcome.value.task.status,
    });

    // Work crossing into another department is the one effect this office
    // carries out. The engine says where the work goes and who should take it;
    // creating it is the store's business, and this is the store.
    for (const effect of outcome.value.effects) {
      if (effect.type !== "hand_off") continue;
      const receiving = colleagues.items.filter(
        (employee) => employee.departmentId === effect.toDepartmentId,
      );
      const placed = performHandoff(
        effect,
        task.officeId,
        receiving.map((employee) => ({
          id: employee.id,
          status: employee.status,
          skillIds: employee.skillIds,
          openTasks: load[employee.id] ?? 0,
        })),
        { id: () => newId() as TaskId, now },
      );
      if (isErr(placed)) {
        // A handoff the office would not accept is said out loud rather than
        // dropped: somebody has wired two departments together wrongly.
        app.log.warn(
          { effect: effect.connectionId, errors: placed.error },
          "could not hand work on",
        );
        continue;
      }
      await store.tasks.put(placed.value.task);
      events.publish(task.officeId, { kind: "task.created", id: placed.value.task.id });
    }

    return outcome.value.task;
  });

  // -- connections -----------------------------------------------------------

  app.get("/offices/:officeId/connections", async (request) => {
    const { officeId } = request.params as { officeId: string };
    const page = await store.connections.list({ where: { officeId: officeId as OfficeId } });
    return { items: page.items };
  });

  app.post("/offices/:officeId/connections", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;

    const departments = await store.departments.list({ where: { officeId: officeId as OfficeId } });
    const existing = await store.connections.list({ where: { officeId: officeId as OfficeId } });

    return created(
      reply,
      createConnection(
        {
          officeId: officeId as OfficeId,
          fromId: (typeof body["fromId"] === "string" ? body["fromId"] : "") as DepartmentId,
          toId: (typeof body["toId"] === "string" ? body["toId"] : "") as DepartmentId,
          kind: body["kind"] as never,
          ...(body["rules"] === undefined
            ? {}
            : { rules: body["rules"] as Record<string, unknown> }),
        },
        {
          departments: new Set(departments.items.map((department) => department.id)),
          existing: existing.items,
        },
        { id: () => newId() as ConnectionId, now },
      ),
      officeId,
      "connection.created",
      (connection) => store.connections.put(connection),
    );
  });

  app.delete("/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = await store.connections.get(id);
    if (connection === null) return missing(reply, "connection");
    await store.connections.delete(id);
    events.publish(connection.officeId, { kind: "connection.deleted", id });
    return reply.code(204).send();
  });

  return app;
}
