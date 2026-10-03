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
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  createConnection,
  createDepartment,
  createEmployee,
  createConnector,
  createNotificationChannel,
  createOffice,
  EMPLOYEE_STATUSES,
  isDocumentOwnerKind,
  isDocumentTray,
  isEmployeeStatus,
  isRunState,
  placeOnBench,
  createContest,
  recordContestWin,
  validateBenchMembers,
  openTaskCounts,
  RUN_STATES,
  setRunState,
  transitionEmployee,
  isBudgetPeriod,
  budgetStanding,
  periodStart,
  redactChannel,
  updateNotificationChannel,
  usageRecordOf,
  updateConnection,
  updateConnector,
  updateOffice,
  validateToolGrants,
  createTask,
  isErr,
  updateDepartment,
  updateEmployee,
  type ConnectionId,
  type Connector,
  type GatedAction,
  type ConnectorId,
  type NotificationChannelId,
  type Office,
  type BenchChoice,
  type BenchId,
  type ContestId,
  type DepartmentId,
  type DocumentId,
  type DocumentOwnerKind,
  type EmployeeId,
  type OfficeId,
  type Result,
  type TaskId,
  type ToolGrant,
  type ValidationError,
} from "@vo/core";
import {
  acceptanceCriteriaFor,
  BlobRunCheckpointStore,
  defaultWorkflowEngine,
  performCreateWork,
  whatIsWaiting,
  type HeldCall,
  type RunCheckpoint,
  type WorkflowContext,
  type WorkflowEvent,
} from "@vo/orchestrator";
import {
  copyIntoTray,
  fileDocument,
  listTray,
  readDocument,
  removeDocument,
  type BlobStore,
  type RelationalStore,
} from "@vo/storage";
import {
  bearerToken,
  clearedSessionCookie,
  sessionCookie,
  sessionCookieHeader,
  type TokenVerifier,
} from "./auth.js";
import { OfficeEventLog } from "./events.js";
import { blobRunDecisions } from "./run-state.js";

export interface ServerOptions {
  readonly store: RelationalStore;
  /**
   * Where document bodies are kept. An office without one has no trays at all
   * and the document routes are simply not there, so every deployment that ran
   * before documents existed keeps running unchanged.
   */
  readonly blobs?: BlobStore;
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
  /**
   * A built canvas to serve beside the API, if this deployment has one.
   *
   * Serving it from the office is what lets a browser hold no credential: the
   * page and the API share an origin, so the cookie set at sign-in is simply
   * sent, and there is no token to build into the bundle and no cross-origin
   * arrangement to make. Absent means an office that answers an API and nothing
   * else, which is every deployment that ran before this.
   */
  readonly webRoot?: string;
  /**
   * Where word is sent when something happens — Slack, Telegram, whatever the
   * office has configured. Injected so the server has no idea what a channel
   * is, and so no test can post into a real one by accident. A deployment that
   * passes none still runs: the stream event is published either way.
   */
  readonly notify?: (notification: {
    readonly officeId: OfficeId;
    readonly kind: string;
    readonly subject: string;
    readonly body: string;
  }) => Promise<void>;
  /**
   * Asks one connector what tools it offers, so the office can write the names
   * down and the canvas can grant them.
   *
   * Injected for the same two reasons the notifier is: this process has no idea
   * what an MCP server is, and no test may spawn one or open a socket by
   * accident. The deployment's entry point supplies the real one, which is the
   * same broker the worker calls tools through. An office without it answers
   * 501 rather than pretending a connector offers nothing.
   */
  readonly discoverTools?: (connector: Connector) => Promise<readonly string[]>;
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
  "await_decision",
  "call_decided",
];

/**
 * The statuses a run in flight can be in: being done, or waiting for a person.
 * Anything else means the attempt is over and what it wrote down is spent.
 */
const ATTEMPT_STATUSES: readonly string[] = ["in_progress", "blocked"];

/** Where a browser goes to turn a token into a cookie, and back again. */
const SESSION_PATH = "/session";

/**
 * A browser cannot set headers on a WebSocket, so the stream takes its token in
 * the query string instead — or, once somebody has signed in, in the cookie the
 * upgrade carries on its own, which is a credential that never reaches a log.
 * Either is checked before the socket is accepted, never after: an
 * unauthenticated socket is never opened at all.
 */
const WS_PATH = "/ws";

/**
 * Everything this office answers as an office.
 *
 * It matters because of what is not here: when a canvas is being served, any
 * other address is the canvas's own — a section of it, a file it asks for — and
 * is answered with the page rather than refused. A route that was left out of
 * this list would be served as HTML to a client expecting JSON, so a test reads
 * the route table and insists every top-level route appears here.
 */
export const OFFICE_PATHS: readonly string[] = [
  "/health",
  SESSION_PATH,
  WS_PATH,
  "/offices",
  "/departments",
  "/employees",
  "/tasks",
  "/connections",
  "/connectors",
  "/channels",
  "/documents",
];

const isOfficePath = (path: string): boolean =>
  OFFICE_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * Paths anyone may call: a health probe has no credentials to offer, and the
 * sign-in route is where a browser goes to get one — asking it for the thing it
 * is asking for would be a locked door with the key inside.
 */
const OPEN_PATHS: readonly string[] = ["/health", SESSION_PATH];

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

/**
 * The run state a PUT body asks for, or null when it does not name one.
 *
 * These routes are PUTs because each says what the state should be rather than
 * what to change it from - which is also why none of them checks
 * `x-vo-since-offset`: an instruction to be paused has nothing to conflict
 * with, and refusing it because somebody else also paused it would be absurd.
 */
function runStateFrom(body: unknown, errors: ValidationError[]): "running" | "paused" | null {
  const value = (body as Record<string, unknown> | null)?.["runState"];
  if (isRunState(value)) return value;
  errors.push({ path: "runState", message: `must be one of ${RUN_STATES.join(", ")}` });
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Base64 as a client is allowed to send it: the alphabet, and nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bytes out of an untrusted body.
 *
 * Node's decoder ignores what it does not recognise, so text that is not base64
 * at all decodes to something shorter rather than failing — and the office would
 * store the difference and call it a document. The round trip is what catches it.
 */
function bytes(
  body: Record<string, unknown>,
  field: string,
  errors: ValidationError[],
): Uint8Array {
  const before = errors.length;
  const raw = text(body, field, errors);
  if (errors.length > before) return new Uint8Array();

  const compact = raw.replace(/\s+/g, "");
  if (compact.length === 0) return new Uint8Array();
  const refuse = (): Uint8Array => {
    errors.push({ path: field, message: "must be base64" });
    return new Uint8Array();
  };
  if (!BASE64.test(compact) || compact.length % 4 !== 0) return refuse();
  const decoded = Buffer.from(compact, "base64");
  const unpadded = (value: string): string => value.replace(/=+$/, "");
  if (unpadded(decoded.toString("base64")) !== unpadded(compact)) return refuse();
  return new Uint8Array(decoded);
}

/**
 * A filename a header can carry. The name itself is never a path — core refuses
 * one — but it may hold a quote or a character no header may, so the readable
 * form is stripped and the true name travels encoded beside it.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Grants out of an untrusted body, checked against the office's own connectors.
 *
 * Shape alone is not enough and was all this ever did: a grant naming a
 * connector that does not exist passed, was stored, and granted nothing
 * forever. The function that knows better has existed since the connector model
 * was written and was called only when an office file was loaded.
 */
async function grantsFrom(
  body: Record<string, unknown>,
  officeId: string,
  connectorsOf: (
    officeId: string,
  ) => Promise<readonly { id: string; name: string; tools: readonly string[]; enabled: boolean }[]>,
  problems: ValidationError[],
): Promise<readonly ToolGrant[] | undefined> {
  const raw = body["toolGrants"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    problems.push({ path: "toolGrants", message: "must be a list of grants" });
    return undefined;
  }

  const grants = raw.map((grant) => {
    const fields = (typeof grant === "object" && grant !== null ? grant : {}) as Record<
      string,
      unknown
    >;
    return {
      connectorId: typeof fields["connectorId"] === "string" ? fields["connectorId"] : "",
      tool: typeof fields["tool"] === "string" ? fields["tool"] : "",
    };
  }) as ToolGrant[];

  problems.push(...validateToolGrants(grants, (await connectorsOf(officeId)) as never));
  return grants;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    forceCloseConnections: options.forceCloseConnections ?? false,
  });
  const store = options.store;
  const notify = options.notify;
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
      // Kept in step with the routes by a test that reads the route table —
      // this list was correct until PUT arrived, and nothing injected noticed.
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["authorization", "content-type", "x-vo-since-offset"],
    });
  }

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done) => {
    const path = request.url.split("?")[0] ?? "";
    if (OPEN_PATHS.includes(path)) {
      done();
      return;
    }
    // Anything that is not the office is the canvas, and the canvas is open: a
    // browser cannot send a credential before it has been given the page that
    // asks for one, and the page itself holds nothing worth guarding.
    if (options.webRoot !== undefined && !isOfficePath(path)) {
      done();
      return;
    }
    if (path === WS_PATH) {
      const query = request.query as { token?: string };
      const offered = query.token ?? sessionCookie(request.headers.cookie);
      if (offered === null || options.verifyToken(offered) === null) {
        void reply.code(401).send({ error: "a valid token is required" });
        return;
      }
      done();
      return;
    }
    // Either a header or the cookie: a browser that has signed in holds no
    // credential of its own, and a worker or a curl carries one as it always did.
    const token =
      bearerToken(request.headers.authorization) ?? sessionCookie(request.headers.cookie);
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

  /**
   * Signing in: the token once, and after that the browser holds nothing.
   *
   * The office sets it as a cookie the page cannot read, so there is no token in
   * the bundle, none in storage and none in the WebSocket URL. It is the office
   * token rather than a session of its own, which means signing out clears this
   * browser and nothing else — sessions with an id, an expiry and a way to
   * revoke one are a task about identity.
   */
  app.post(SESSION_PATH, (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const offered = typeof body["token"] === "string" ? body["token"] : "";
    if (options.verifyToken(offered) === null) {
      return reply.code(401).send({ error: "that is not a token this office knows" });
    }
    // Secure only over https: on a plain-http localhost — which is where the
    // whole kit runs first — a secure cookie is dropped, and signing in would
    // appear to work and never be there.
    const secure = request.headers["x-forwarded-proto"] === "https" || request.protocol === "https";
    return reply
      .header("set-cookie", sessionCookieHeader(offered, { secure }))
      .send({ signedIn: true });
  });

  /** Signing out. Open, because clearing a cookie harms nobody — and a sign-out
   *  that needed a sign-in would strand a browser holding something stale. */
  app.delete(SESSION_PATH, (_request, reply) =>
    reply.header("set-cookie", clearedSessionCookie()).send({ signedIn: false }),
  );

  // -- the event stream ------------------------------------------------------

  /**
   * The canvas, served from the office's own origin.
   *
   * Which is the point: the page and the API share an origin, so the cookie set
   * at sign-in is simply sent, there is no token to build into the bundle and
   * no cross-origin arrangement to make.
   *
   * An address that is not a file is one of the canvas's own sections — the
   * router's business, not this office's — so a GET that wants HTML gets the
   * page. Anything else keeps the answer an API client expects: a JSON 404,
   * because a client handed HTML where JSON belongs reports a parse error
   * rather than a missing route.
   */
  if (options.webRoot !== undefined) {
    const webRoot = options.webRoot;
    void app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const wantsPage =
        request.method === "GET" && (request.headers.accept ?? "").includes("text/html");
      if (wantsPage && !isOfficePath(request.url.split("?")[0] ?? "")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "no such thing here" });
    });
  }

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

  /**
   * The switch. Separate from PATCH because stopping an office is not editing
   * one: a rename must never start it, which is the rule core already holds.
   */
  app.put("/offices/:officeId/run-state", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    const office = await store.offices.get(officeId);
    if (office === null) return missing(reply, "office");

    const problems: ValidationError[] = [];
    const runState = runStateFrom(request.body, problems);
    if (runState === null) return fail(reply, problems);

    const changed = setRunState(office, runState);
    await store.offices.put(changed);
    events.publish(office.id, { kind: "office.updated", id: officeId });
    return changed;
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
    const grants = await grantsFrom(body, officeId, connectorsIn, problems);
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
          ...(grants === undefined ? {} : { toolGrants: grants }),
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
    const refusals: ValidationError[] = [];
    await grantsFrom(
      request.body as Record<string, unknown>,
      department.officeId,
      connectorsIn,
      refusals,
    );
    refusals.push(
      ...(await benchProblems(request.body as Record<string, unknown>, id, department.officeId)),
    );
    if (refusals.length > 0) return fail(reply, refusals);

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

  app.put("/departments/:id/run-state", async (request, reply) => {
    const { id } = request.params as { id: string };
    const department = await store.departments.get(id);
    if (department === null) return missing(reply, "department");

    const problems: ValidationError[] = [];
    const runState = runStateFrom(request.body, problems);
    if (runState === null) return fail(reply, problems);

    // Its own switch: stopping a room says nothing about the office around it.
    const changed = setRunState(department, runState);
    await store.departments.put(changed);
    events.publish(department.officeId, { kind: "department.updated", id });
    return changed;
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
    const grants = await grantsFrom(body, officeId, connectorsIn, problems);
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
          ...(grants === undefined ? {} : { toolGrants: grants }),
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
    const refusals: ValidationError[] = [];
    await grantsFrom(
      request.body as Record<string, unknown>,
      employee.officeId,
      connectorsIn,
      refusals,
    );
    if (refusals.length > 0) return fail(reply, refusals);

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

  /**
   * Pausing somebody, and putting them back.
   *
   * Through `transitionEmployee`, which has held "termination is final" since
   * it was written and until now had no caller outside its own tests. The rule
   * is not restated here: a second copy of it is a second thing to get wrong.
   */
  app.put("/employees/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const employee = await store.employees.get(id);
    if (employee === null) return missing(reply, "employee");

    const status = (request.body as Record<string, unknown> | null)?.["status"];
    if (!isEmployeeStatus(status)) {
      return fail(reply, [
        { path: "status", message: `must be one of ${EMPLOYEE_STATUSES.join(", ")}` },
      ]);
    }
    // Already there is not an error here, whatever core says about it: this
    // route states a destination, and arriving twice is not a failure.
    if (employee.status === status) return employee;

    const moved = transitionEmployee(employee, status, now());
    if (isErr(moved)) return fail(reply, moved.error);
    await store.employees.put(moved.value);
    events.publish(employee.officeId, { kind: "employee.updated", id });
    return moved.value;
  });

  // -- notification channels -------------------------------------------------

  /**
   * Where this office sends word. The secret never comes back out: it is a
   * bearer credential, and anybody who can open the canvas can read a response.
   */
  const channelsIn = async (officeId: string) =>
    (await store.channels.list({ where: { officeId: officeId as OfficeId } })).items;

  app.get("/offices/:officeId/channels", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    return { items: (await channelsIn(officeId)).map(redactChannel) };
  });

  app.post("/offices/:officeId/channels", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;

    const made = createNotificationChannel(
      {
        officeId: officeId as OfficeId,
        kind: body["kind"],
        name: body["name"],
        secret: body["secret"],
        ...(isPlainObject(body["config"]) ? { config: body["config"] } : {}),
        ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
      },
      await channelsIn(officeId),
      { id: () => newId() as NotificationChannelId, now },
    );
    if (isErr(made)) return fail(reply, made.error);
    await store.channels.put(made.value);
    events.publish(made.value.officeId, { kind: "channel.created", id: made.value.id });
    return reply.code(201).send(redactChannel(made.value));
  });

  app.patch("/channels/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const channel = await store.channels.get(id);
    if (channel === null) return missing(reply, "channel");

    const body = request.body as Record<string, unknown>;
    const updated = updateNotificationChannel(
      channel,
      {
        ...(body["name"] === undefined ? {} : { name: body["name"] }),
        // Absent keeps the one it has: a canvas never holds the secret, so a
        // rename would otherwise wipe delivery.
        ...(body["secret"] === undefined ? {} : { secret: body["secret"] }),
        ...(isPlainObject(body["config"]) ? { config: body["config"] } : {}),
        ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
      },
      (await channelsIn(channel.officeId)).filter((one) => one.id !== channel.id),
    );
    if (isErr(updated)) return fail(reply, updated.error);
    await store.channels.put(updated.value);
    events.publish(channel.officeId, { kind: "channel.updated", id });
    return redactChannel(updated.value);
  });

  app.delete("/channels/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const channel = await store.channels.get(id);
    if (channel === null) return missing(reply, "channel");
    await store.channels.delete(id);
    events.publish(channel.officeId, { kind: "channel.deleted", id });
    return reply.code(204).send();
  });

  // -- usage -----------------------------------------------------------------

  /** What one level has spent in its own budget's period, and how that stands. */
  interface Standing {
    readonly standing: "ok" | "warn" | "over";
    readonly spentUsd: number;
    readonly limitUsd: number;
    readonly name: string;
  }

  const spentFor = async (
    office: Office,
    period: "day" | "month",
    pick: (row: { readonly employeeId: string | null }) => boolean,
  ): Promise<number> => {
    const timezone = office.schedule.kind === "windows" ? office.schedule.timezone : "UTC";
    const since = periodStart(period, now(), timezone);
    const rows = await store.usage.list({ where: { officeId: office.id } });
    let total = 0;
    for (const row of rows.items) {
      if (row.at.getTime() < since.getTime() || !pick(row)) continue;
      const cost = row.event["cost"];
      if (isPlainObject(cost) && typeof cost["totalUsd"] === "number") total += cost["totalUsd"];
    }
    return total;
  };

  /**
   * Where the office, and the room and person a call was attributed to, stand
   * against their budgets right now. Only levels with a budget appear.
   */
  const standings = async (
    office: Office,
    employeeId: string | null,
  ): Promise<Record<string, Standing>> => {
    const out: Record<string, Standing> = {};
    const employee = employeeId === null ? null : await store.employees.get(employeeId);
    const department =
      employee === null ? null : await store.departments.get(employee.departmentId);

    if (office.budget !== null) {
      const spent = await spentFor(office, office.budget.period, () => true);
      out["office"] = {
        standing: budgetStanding(office.budget, spent),
        spentUsd: spent,
        limitUsd: office.budget.limitUsd,
        name: office.name,
      };
    }
    if (department?.budget != null) {
      const staff = await store.employees.list({ where: { departmentId: department.id } });
      const inRoom = new Set(staff.items.map((one) => one.id as string));
      const spent = await spentFor(office, department.budget.period, (row) =>
        row.employeeId === null ? false : inRoom.has(row.employeeId),
      );
      out["department"] = {
        standing: budgetStanding(department.budget, spent),
        spentUsd: spent,
        limitUsd: department.budget.limitUsd,
        name: department.name,
      };
    }
    if (employee?.budget != null) {
      const spent = await spentFor(
        office,
        employee.budget.period,
        (row) => row.employeeId === employee.id,
      );
      out["employee"] = {
        standing: budgetStanding(employee.budget, spent),
        spentUsd: spent,
        limitUsd: employee.budget.limitUsd,
        name: employee.name,
      };
    }
    return out;
  };

  /** Says it on the stream, and sends it wherever the office has asked. */
  const warn = async (officeId: OfficeId, level: string, standing: Standing): Promise<void> => {
    events.publish(officeId, {
      kind: "budget.warned",
      id: officeId,
      level,
      standing: standing.standing,
      spentUsd: standing.spentUsd,
      limitUsd: standing.limitUsd,
    });
    await notify?.({
      officeId,
      kind: "budget.warned",
      subject:
        standing.standing === "over"
          ? `${standing.name} has reached its budget`
          : `${standing.name} is near its budget`,
      body: `Spent $${standing.spentUsd.toFixed(2)} of $${standing.limitUsd.toFixed(2)}.`,
    });
  };

  /**
   * What the office was spent on. One row per metered call.
   *
   * Nothing is published: a usage row is not a change to the office, and a
   * stream event per model call would wake every open canvas for something no
   * canvas needs to react to.
   */
  app.post("/offices/:officeId/usage", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    const office = await store.offices.get(officeId);
    if (office === null) return missing(reply, "office");

    const record = usageRecordOf(request.body as Record<string, unknown>, { id: () => newId() });
    if (isErr(record)) return fail(reply, record.error);

    // Where each level stood before this call, so the one that crosses a
    // threshold can be told apart from the ones after it.
    const before = await standings(office, record.value.employeeId);
    await store.usage.put(record.value);
    const after = await standings(office, record.value.employeeId);

    for (const [level, now] of Object.entries(after)) {
      const was = before[level];
      // The crossing, and only the crossing: no flag is stored and nothing has
      // to be reset when the period rolls, because "under before, not under
      // now" is true exactly once per threshold per period.
      if (was === undefined || was.standing === now.standing) continue;
      if (now.standing === "ok") continue;
      await warn(office.id, level, now);
    }

    return reply.code(201).send(record.value);
  });

  app.get("/offices/:officeId/usage", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const { taskId } = request.query as { taskId?: string };

    const page = await store.usage.list({
      where: {
        officeId: officeId as OfficeId,
        ...(taskId === undefined ? {} : { taskId: taskId as TaskId }),
      },
    });
    return { items: page.items };
  });

  /**
   * What each level has spent in the current period.
   *
   * A summary, not the rows: a worker needs a handful of numbers to decide what
   * to queue, and shipping every priced call to every worker on every tick is
   * the thing the rollups task exists to prevent.
   *
   * The department is joined here through its people, because a usage row
   * deliberately promotes only the office, the task and the person.
   */
  app.get("/offices/:officeId/spend", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    const office = await store.offices.get(officeId);
    if (office === null) return missing(reply, "office");

    const query = request.query as { period?: string; at?: string };
    const period = query.period ?? "day";
    if (!isBudgetPeriod(period)) {
      return fail(reply, [{ path: "period", message: "must be one of day, month" }]);
    }
    const at = query.at === undefined ? now() : new Date(query.at);
    // Where the office is, not where the server is: a day that rolled at UTC
    // midnight would cut a working day in half somewhere east of here.
    const timezone = office.schedule.kind === "windows" ? office.schedule.timezone : "UTC";
    const since = periodStart(period, at, timezone);

    const [rows, staff] = await Promise.all([
      store.usage.list({ where: { officeId: officeId as OfficeId } }),
      store.employees.list({ where: { officeId: officeId as OfficeId } }),
    ]);
    const departmentOf = new Map(staff.items.map((one) => [one.id as string, one.departmentId]));

    let officeUsd = 0;
    let unpricedCalls = 0;
    const byDepartment: Record<string, number> = {};
    const byEmployee: Record<string, number> = {};

    for (const row of rows.items) {
      if (row.at.getTime() < since.getTime()) continue;
      const cost = row.event["cost"];
      const usd =
        typeof cost === "object" &&
        cost !== null &&
        typeof (cost as { totalUsd?: unknown }).totalUsd === "number"
          ? (cost as { totalUsd: number }).totalUsd
          : null;
      // Counted, never added as zero: an unpriced model that looked free could
      // run past any limit, which is the one thing a budget must not allow.
      if (usd === null) {
        unpricedCalls += 1;
        continue;
      }
      officeUsd += usd;
      if (row.employeeId !== null) {
        byEmployee[row.employeeId] = (byEmployee[row.employeeId] ?? 0) + usd;
        const department = departmentOf.get(row.employeeId);
        if (department !== undefined) {
          byDepartment[department] = (byDepartment[department] ?? 0) + usd;
        }
      }
    }

    return {
      period,
      since: since.toISOString(),
      officeUsd,
      unpricedCalls,
      byDepartment,
      byEmployee,
    };
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

    /**
     * Who takes this: named outright, or chosen by a bench.
     *
     * Both is two answers and no reason to prefer either. A bench that the
     * department does not have is refused rather than quietly ignored — work
     * aimed at a box that is not there should not land on somebody at random.
     * A bench nobody on can work leaves the task in the backlog, which is what
     * an unassignable task has always done.
     */
    const named =
      typeof body["assigneeId"] === "string" ? (body["assigneeId"] as EmployeeId) : null;
    const wantsBench = typeof body["benchId"] === "string" ? (body["benchId"] as BenchId) : null;
    if (named !== null && wantsBench !== null) {
      return fail(reply, [{ path: "benchId", message: "name somebody or name a bench, not both" }]);
    }

    let chosen: BenchChoice =
      named === null ? { kind: "nobody" } : { kind: "one", employeeId: named };
    if (wantsBench !== null) {
      const department = await store.departments.get(departmentId);
      const bench = department?.benches.find((candidate) => candidate.id === wantsBench);
      if (bench === undefined) {
        return fail(reply, [
          { path: "benchId", message: `this department has no bench "${wantsBench}"` },
        ]);
      }
      const [staff, placed] = await Promise.all([
        store.employees.list({ where: { departmentId: departmentId as DepartmentId } }),
        store.tasks.list({ where: { departmentId: departmentId as DepartmentId } }),
      ]);
      chosen = placeOnBench(bench, staff.items, placed.items);
    }

    const asked = {
      officeId: officeId as OfficeId,
      departmentId: departmentId as DepartmentId,
      title,
      ...(brief === undefined ? {} : { brief }),
      ...(Array.isArray(body["acceptanceCriteria"])
        ? { acceptanceCriteria: body["acceptanceCriteria"] as string[] }
        : {}),
      // What this work will involve, which is what a department's gate holds it
      // for. Without a way to say so over the wire, a gated department could
      // only ever hold work the office made for itself.
      ...(Array.isArray(body["gatedActions"])
        ? { gatedActions: body["gatedActions"] as GatedAction[] }
        : {}),
      // Only when a bench actually placed it: a bench that could place nothing
      // leaves ordinary unassigned work, not a record of something it handed out.
      ...(wantsBench !== null && chosen.kind !== "nobody" ? { benchId: wantsBench } : {}),
    };
    const taskDeps = { id: () => newId() as TaskId, now };

    /**
     * A shootout answers with every entry it made, and one contest id.
     *
     * Deliberately a different shape from the single task every other creation
     * returns, because what happened is different: the office now holds N pieces
     * of work, and answering with one of them would hide the rest. Only a caller
     * that asked a shootout bench for work can see this.
     */
    if (chosen.kind === "every") {
      const contestId = newId() as ContestId;
      const entries = createContest(asked, chosen.employeeIds, contestId, taskDeps);
      if (isErr(entries)) return fail(reply, entries.error);
      for (const entry of entries.value) {
        await store.tasks.put(entry);
        events.publish(officeId, { kind: "task.created", id: entry.id });
      }
      return reply.code(201).send({ contestId, items: entries.value });
    }

    return created(
      reply,
      createTask(
        {
          ...asked,
          ...(chosen.kind === "one" ? { assigneeId: chosen.employeeId } : {}),
        },
        taskDeps,
      ),
      officeId,
      "task.created",
      (task) => store.tasks.put(task),
    );
  });

  /**
   * Which entry in a contest won, and why.
   *
   * Its own route rather than a PATCH, for the reason the run-state switch is:
   * this is not editing a field of a task, it is recording a judgement about a
   * set of them — and core refuses a second one, so there is nothing here for a
   * `sinceOffset` to protect.
   */
  app.post("/tasks/:id/win", async (request, reply) => {
    const { id } = request.params as { id: string };
    const winner = await store.tasks.get(id);
    if (winner === null) return missing(reply, "task");
    if (winner.contestId === null) {
      return fail(reply, [{ path: "id", message: "that work is not an entry in a contest" }]);
    }

    const body = request.body as Record<string, unknown>;
    const problems: ValidationError[] = [];
    const reason = text(body, "reason", problems);
    if (problems.length > 0) return fail(reply, problems);
    const decidedBy =
      typeof body["decidedBy"] === "string" ? (body["decidedBy"] as EmployeeId) : null;

    // The contest is its entries, so they are read out of the room it ran in.
    const inRoom = await store.tasks.list({ where: { departmentId: winner.departmentId } });
    const entries = inRoom.items.filter((task) => task.contestId === winner.contestId);

    const decided = recordContestWin(entries, winner.id, { reason, decidedBy, at: now() });
    if (isErr(decided)) return fail(reply, decided.error);

    await store.tasks.put(decided.value);
    events.publish(winner.officeId, {
      kind: "task.updated",
      id: decided.value.id,
      status: decided.value.status,
    });
    return decided.value;
  });

  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await store.tasks.get(id);
    return task ?? missing(reply, "task");
  });

  /**
   * Who is asking.
   *
   * Re-read rather than stashed: the hook has already proved it. The cookie
   * counts as well as the header — a browser that signed in is a person, and
   * before this it filed its documents as "unknown".
   */
  const personOf = (request: FastifyRequest): string => {
    const offered =
      bearerToken(request.headers.authorization) ?? sessionCookie(request.headers.cookie);
    return (offered === null ? null : options.verifyToken(offered))?.ownerId ?? "unknown";
  };

  /**
   * What the office is holding for a run in flight: where it got to, and what
   * a person has decided about the calls it is waiting on.
   *
   * Two records with one writer each. The worker writes the checkpoint, because
   * it is running the loop; the office writes the decisions, because they come
   * from a person. Neither writes the other's, so a step being saved and a
   * decision arriving cannot lose each other.
   *
   * Only with somewhere to keep them. An office with no blob store has no trays
   * either; a parked run in such an office is resumed by the process that
   * parked it or not at all, which is what it was before this existed.
   */
  const runState =
    options.blobs === undefined
      ? null
      : {
          checkpoints: new BlobRunCheckpointStore(options.blobs),
          decisions: blobRunDecisions(options.blobs),
        };

  if (runState !== null) {
    app.get("/tasks/:id/run-checkpoint", async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await store.tasks.get(id)) === null) return missing(reply, "task");
      return {
        checkpoint: await runState.checkpoints.load(id),
        decisions: await runState.decisions.list(id),
      };
    });

    app.put("/tasks/:id/run-checkpoint", async (request, reply) => {
      const { id } = request.params as { id: string };
      if ((await store.tasks.get(id)) === null) return missing(reply, "task");
      const body = request.body as Record<string, unknown>;
      // Keyed by the task, so a checkpoint for another run cannot be filed here
      // and answered to this one.
      if (body["runId"] !== id) {
        return fail(reply, [{ path: "runId", message: `must be "${id}"` }]);
      }
      if (!Array.isArray(body["messages"])) {
        return fail(reply, [{ path: "messages", message: "must be the conversation so far" }]);
      }
      await runState.checkpoints.save(body as unknown as RunCheckpoint);
      return reply.code(204).send();
    });
  }

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
    const everyone = colleagues.items.map((employee) => ({
      id: employee.id,
      departmentId: employee.departmentId,
      status: employee.status,
      skillIds: employee.skillIds,
      openTasks: load[employee.id] ?? 0,
    }));

    // What this work produced, resolved here rather than reached for: the engine
    // decides what travels, and this is what holds the store that can say what it is.
    const produced = await listTray(store.documents, { kind: "task", id }, "out");

    const context: WorkflowContext = {
      policy: department?.reviewPolicy ?? { kind: "direct" },
      documents: produced.map((document) => document.id),
      acceptanceCriteria: acceptanceCriteriaFor(
        task.acceptanceCriteria,
        department?.definitionOfDone ?? [],
      ),
      now: now(),
      supervisorId: assignee?.supervisorId ?? null,
      peers: everyone.filter((employee) => employee.departmentId === task.departmentId),
      // The whole office, for the one thing that looks outside this task's own
      // department: another department whose arrow says it checks this work.
      colleagues: everyone,
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

    // A decision names one call, and the run has to be holding it. A key typed
    // wrong would otherwise start the work again, which parks on the same call
    // a moment later: a task that flaps, and a person who believes they
    // answered something.
    if (runState !== null && type === "call_decided") {
      const checkpoint = await runState.checkpoints.load(id);
      const holding = checkpoint?.pendingApproval?.items ?? [];
      const key = typeof body["key"] === "string" ? body["key"] : "";
      if (holding.length > 0 && !holding.some((item) => item.key === key)) {
        return fail(reply, [{ path: "key", message: `this run is not holding a call "${key}"` }]);
      }
    }

    // A decision only a person may make records who made it. A canvas has no
    // name to send — it was let in with a token — so the office fills in whose
    // it was. A body that says is believed: one person may act for another.
    const decided =
      (type === "gate_decided" || type === "call_decided") &&
      (typeof body["decidedBy"] !== "string" || body["decidedBy"].trim().length === 0)
        ? { ...body, decidedBy: personOf(request) }
        : body;

    const outcome = workflow.handle(task, decided as unknown as WorkflowEvent, context);
    if (isErr(outcome)) return fail(reply, outcome.error);

    // Written down before the work starts again, so an approved call cannot be
    // approved and then forgotten: the run would park on the same call. The
    // other order fails safely too, but this way a retry of the same event is
    // the same decision rather than a second one.
    if (runState !== null && type === "call_decided") {
      const key = typeof body["key"] === "string" ? body["key"] : "";
      const decision = body["decision"] === "declined" ? "declined" : "approved";
      const decidedBy = typeof decided["decidedBy"] === "string" ? decided["decidedBy"] : "";
      const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
      await runState.decisions.record(id, {
        key,
        decision,
        decidedBy,
        ...(reason === undefined ? {} : { reason }),
      });
    }

    await store.tasks.put(outcome.value.task);

    // A checkpoint belongs to the attempt that is running. Once the work has
    // moved on — into review, done, cancelled, handed over — the next attempt
    // must not find the last one's finished run and hand back its answer.
    if (runState !== null && !ATTEMPT_STATUSES.includes(outcome.value.task.status)) {
      await runState.checkpoints.delete(id);
      await runState.decisions.clear(id);
    }
    events.publish(task.officeId, {
      kind: "task.updated",
      id,
      status: outcome.value.task.status,
    });

    // Work crossing into another department is the one effect this office
    // carries out. The engine says where the work goes and who should take it;
    // creating it is the store's business, and this is the store.
    for (const effect of outcome.value.effects) {
      if (effect.type !== "create_work") continue;
      // The receiving room's benches, and what they have already handed out, so
      // an arrow that names a bench gets whoever's turn it is. Without this the
      // arrow would place nothing and the work would sit in a backlog.
      const receiving = await store.departments.get(effect.toDepartmentId);
      const inRoom = await store.tasks.list({
        where: { departmentId: effect.toDepartmentId },
      });
      const placed = performCreateWork(
        effect,
        task.officeId,
        everyone.filter((employee) => employee.departmentId === effect.toDepartmentId),
        { id: () => newId() as TaskId, now },
        { benches: receiving?.benches ?? [], placed: inRoom.items },
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
      // Usually one. A shootout bench answers with one piece of work per
      // entrant, and every one of them needs its own copy of what arrived —
      // the identical input is the only thing that makes the answers comparable.
      for (const one of placed.value) {
        await store.tasks.put(one.task);
        events.publish(task.officeId, { kind: "task.created", id: one.task.id });

        // The documents come across as copies naming one body, so both desks hold
        // the work and neither can take the other's away.
        const carried = await copyIntoTray(
          store.documents,
          effect.documents,
          { kind: "task", id: one.task.id },
          "in",
          { id: () => newId() as DocumentId, now },
        );
        for (const document of carried) {
          events.publish(task.officeId, {
            kind: "document.added",
            id: document.id,
            ownerKind: document.ownerKind,
            ownerId: document.ownerId,
            tray: document.tray,
            by: document.addedBy,
            byKind: document.addedBy === null ? "person" : "employee",
          });
        }
      }
    }

    return outcome.value.task;
  });

  // -- connections -----------------------------------------------------------

  /**
   * What this office is waiting on a person for.
   *
   * One question with one answer, rather than a canvas deriving half of it and
   * asking after the run checkpoint of every blocked task: the held calls are
   * kept where the office keeps them, and what counts as waiting is one rule
   * (`whatIsWaiting`) rather than one per screen.
   *
   * Ids, not names. The canvas already holds the people and the rooms, and a
   * route that renders is a route that changes whenever the screen does.
   */
  app.get("/offices/:officeId/approvals", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");

    const tasks = (await store.tasks.list({ where: { officeId: officeId as OfficeId } })).items;
    const departments = (
      await store.departments.list({ where: { officeId: officeId as OfficeId } })
    ).items;

    // Only for work that stopped: every other task has no checkpoint to read,
    // and asking after one per task would be a request per piece of work.
    const held = new Map<string, readonly HeldCall[]>();
    if (runState !== null) {
      for (const task of tasks) {
        if (task.status !== "blocked") continue;
        const checkpoint = await runState.checkpoints.load(task.id);
        const items = checkpoint?.pendingApproval?.items ?? [];
        if (items.length > 0) held.set(task.id, items);
      }
    }

    return { items: whatIsWaiting(tasks, departments, held) };
  });

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
          ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
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

  app.patch("/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = await store.connections.get(id);
    if (connection === null) return missing(reply, "connection");

    const since = claimedOffset(request);
    if (since !== null && events.changedSince(connection.officeId, id, since)) {
      return reply
        .code(409)
        .send({ error: "this connection changed since you loaded it", current: connection });
    }

    const updated = updateConnection(connection, request.body as Record<string, never>);
    if (isErr(updated)) return fail(reply, updated.error);
    await store.connections.put(updated.value);
    events.publish(connection.officeId, { kind: "connection.updated", id });
    return updated.value;
  });

  app.delete("/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connection = await store.connections.get(id);
    if (connection === null) return missing(reply, "connection");
    await store.connections.delete(id);
    events.publish(connection.officeId, { kind: "connection.deleted", id });
    return reply.code(204).send();
  });

  // -- connectors ------------------------------------------------------------

  /** This office's connectors, which every grant is judged against. */
  const connectorsIn = async (officeId: string) =>
    (await store.connectors.list({ where: { officeId: officeId as OfficeId } })).items;

  /**
   * Whether a department's benches only hold its own people.
   *
   * The shape check runs inside core on every change; this is the cross-check
   * core cannot do, exactly as `validateToolGrants` is to `validateGrantShape`.
   */
  const benchProblems = async (
    body: Record<string, unknown>,
    departmentId: string,
    officeId: string,
  ): Promise<ValidationError[]> => {
    const benches = body["benches"];
    if (!Array.isArray(benches)) return [];
    // The room's people for the members, and the office's for a judge: judging
    // is not this room's work, and whoever does it usually sits outside it.
    const [staff, everyone] = await Promise.all([
      store.employees.list({ where: { departmentId: departmentId as DepartmentId } }),
      store.employees.list({ where: { officeId: officeId as OfficeId } }),
    ]);
    return validateBenchMembers(
      benches as never,
      staff.items.map((one) => one.id),
      everyone.items.map((one) => one.id),
    );
  };

  app.get("/offices/:officeId/connectors", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    return { items: await connectorsIn(officeId) };
  });

  app.post("/offices/:officeId/connectors", async (request, reply) => {
    const { officeId } = request.params as { officeId: string };
    if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
    const body = request.body as Record<string, unknown>;

    // Read before handing over: `createConnector` trims the name and walks the
    // tools without checking either is what it says, so an untyped body reaches
    // it as a thrown TypeError rather than as a refusal.
    const problems: ValidationError[] = [];
    const name = text(body, "name", problems);
    const kind = text(body, "kind", problems);
    const rawTools = body["tools"];
    if (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string")) {
      problems.push({ path: "tools", message: "must be a list of tool names" });
    }
    if (problems.length > 0) return fail(reply, problems);

    return created(
      reply,
      createConnector(
        {
          officeId: officeId as OfficeId,
          kind: kind as never,
          name,
          tools: rawTools as string[],
          ...(body["config"] === undefined
            ? {}
            : { config: body["config"] as Record<string, unknown> }),
          ...(typeof body["secretRef"] === "string" ? { secretRef: body["secretRef"] } : {}),
          ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
        },
        await connectorsIn(officeId),
        { id: () => newId() as ConnectorId, now },
      ),
      officeId,
      "connector.created",
      (connector) => store.connectors.put(connector),
    );
  });

  app.patch("/connectors/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await store.connectors.get(id);
    if (connector === null) return missing(reply, "connector");

    const since = claimedOffset(request);
    if (since !== null && events.changedSince(connector.officeId, id, since)) {
      return reply
        .code(409)
        .send({ error: "this connector changed since you loaded it", current: connector });
    }

    const siblings = await connectorsIn(connector.officeId);
    const updated = updateConnector(connector, request.body as Record<string, never>, siblings);
    if (isErr(updated)) return fail(reply, updated.error);
    await store.connectors.put(updated.value);
    events.publish(connector.officeId, { kind: "connector.updated", id });
    return updated.value;
  });

  /**
   * What this connector actually offers, asked of the connector itself.
   *
   * An MCP server reports its own tools, so `TOOLS_BY_KIND` cannot know them
   * and the office would otherwise have to be told by hand — a tool name typed
   * wrong is a grant that silently grants nothing. The names are written onto
   * the connector, which is what the grant checkboxes on the drawers read.
   *
   * An empty answer is refused rather than saved. A server that is up but
   * confused would otherwise empty the list and with it every grant that names
   * a tool, which is a lot of damage for one button.
   */
  app.post("/connectors/:id/discover", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await store.connectors.get(id);
    if (connector === null) return missing(reply, "connector");

    const discover = options.discoverTools;
    if (discover === undefined) {
      return reply
        .code(501)
        .send({ error: "this office has no way to ask a connector what it offers" });
    }

    let offered: readonly string[];
    try {
      offered = await discover(connector);
    } catch (error) {
      return reply
        .code(502)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (offered.length === 0) {
      return reply.code(502).send({
        error: `${connector.name} offered no tools, so nothing was changed`,
        current: connector,
      });
    }

    const siblings = await connectorsIn(connector.officeId);
    const updated = updateConnector(connector, { tools: offered }, siblings);
    if (isErr(updated)) return fail(reply, updated.error);
    await store.connectors.put(updated.value);
    events.publish(connector.officeId, { kind: "connector.updated", id });
    return updated.value;
  });

  app.delete("/connectors/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await store.connectors.get(id);
    if (connector === null) return missing(reply, "connector");
    // Grants naming it are left alone. They resolve to nothing without it, and
    // walking two other entities to prune them is a bigger change than a stale
    // row that grants nobody anything.
    await store.connectors.delete(id);
    events.publish(connector.officeId, { kind: "connector.deleted", id });
    return reply.code(204).send();
  });

  // -- documents -------------------------------------------------------------

  /**
   * Trays exist only when there is somewhere to keep a body, so these routes
   * are registered with the blob store rather than checking for it one by one.
   */
  const blobs = options.blobs;
  if (blobs !== undefined) {
    const trays = { documents: store.documents, blobs };

    /** A tray belongs to something this office actually has. */
    const ownerIsHere = async (
      officeId: string,
      kind: DocumentOwnerKind,
      id: string,
    ): Promise<boolean> => {
      if (kind === "office") return id === officeId;
      if (kind === "department") return (await store.departments.get(id))?.officeId === officeId;
      if (kind === "employee") return (await store.employees.get(id))?.officeId === officeId;
      return (await store.tasks.get(id))?.officeId === officeId;
    };

    app.get("/offices/:officeId/documents", async (request, reply) => {
      const { officeId } = request.params as { officeId: string };
      if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
      const query = request.query as { ownerKind?: string; ownerId?: string; tray?: string };

      if (
        isDocumentOwnerKind(query.ownerKind) &&
        isDocumentTray(query.tray) &&
        query.ownerId !== undefined
      ) {
        return {
          items: await listTray(
            store.documents,
            { kind: query.ownerKind, id: query.ownerId },
            query.tray,
          ),
        };
      }

      // Everything the office holds, so a canvas can derive every tray from one
      // request rather than one per desk.
      const page = await store.documents.list({
        where: { officeId: officeId as OfficeId },
        orderBy: { field: "addedAt", direction: "asc" },
      });
      return { items: page.items };
    });

    app.post(
      "/offices/:officeId/documents",
      // A body arrives base64, which is a third larger than the document, and
      // Fastify would otherwise refuse a document at the cap before core saw it.
      { bodyLimit: 4 * 1024 * 1024 },
      async (request, reply) => {
        const { officeId } = request.params as { officeId: string };
        if ((await store.offices.get(officeId)) === null) return missing(reply, "office");
        const body = request.body as Record<string, unknown>;

        const problems: ValidationError[] = [];
        const ownerKind = text(body, "ownerKind", problems);
        const ownerId = text(body, "ownerId", problems);
        const tray = text(body, "tray", problems);
        const name = text(body, "name", problems);
        const mediaType =
          body["mediaType"] === undefined ? undefined : text(body, "mediaType", problems);
        const content = bytes(body, "contentBase64", problems);
        const addedBy = body["addedBy"] === undefined ? undefined : text(body, "addedBy", problems);
        if (problems.length > 0) return fail(reply, problems);

        // Owner kind is core's to judge; whether that owner is here is not.
        if (isDocumentOwnerKind(ownerKind) && !(await ownerIsHere(officeId, ownerKind, ownerId))) {
          return missing(reply, "the owner of this tray");
        }
        if (addedBy !== undefined) {
          const employee = await store.employees.get(addedBy);
          if (employee?.officeId !== officeId) {
            return fail(reply, [
              { path: "addedBy", message: "must be somebody who works in this office" },
            ]);
          }
        }

        const filed = await fileDocument(
          trays,
          {
            officeId: officeId as OfficeId,
            owner: { kind: ownerKind, id: ownerId },
            tray,
            name,
            ...(mediaType === undefined ? {} : { mediaType }),
            body: content,
            ...(addedBy === undefined ? {} : { addedBy: addedBy as EmployeeId }),
          },
          { id: () => newId() as DocumentId, now },
        );
        if (isErr(filed)) return fail(reply, filed.error);

        const document = filed.value;
        events.publish(officeId, {
          kind: "document.added",
          id: document.id,
          ownerKind: document.ownerKind,
          ownerId: document.ownerId,
          tray: document.tray,
          // Named so an audit log can tell an employee filing its work from a
          // person dropping something off.
          by: document.addedBy ?? personOf(request),
          byKind: document.addedBy === null ? "person" : "employee",
        });
        return reply.code(201).send(document);
      },
    );

    app.get("/documents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const document = await store.documents.get(id);
      if (document === null) return missing(reply, "document");
      return document;
    });

    app.get("/documents/:id/content", async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await readDocument(trays, id as DocumentId);
      if (found === null) return missing(reply, "document");

      // Whoever uploaded it chose the media type, so echoing it back would let
      // an uploaded page be a page this origin serves. It is always something to
      // save, never something to run.
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", contentDisposition(found.document.name))
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(found.body));
    });

    app.delete("/documents/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const document = await store.documents.get(id);
      if (document === null) return missing(reply, "document");

      await removeDocument(trays, id as DocumentId);
      events.publish(document.officeId, {
        kind: "document.removed",
        id,
        ownerKind: document.ownerKind,
        ownerId: document.ownerId,
        tray: document.tray,
        by: personOf(request),
        byKind: "person",
      });
      return reply.code(204).send();
    });
  }

  return app;
}
