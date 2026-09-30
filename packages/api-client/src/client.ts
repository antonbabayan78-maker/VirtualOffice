/**
 * Talking to the office API.
 *
 * Three ways a save can fail, and the canvas needs to tell them apart: the
 * office refused the change (say which field), somebody else changed it first
 * (show what they wrote), or the request never arrived (leave the change alone
 * and let them try again). Collapsing those into one "error" is how a canvas
 * ends up lying about what the office holds.
 *
 * Dates come back as strings over JSON and are turned back into dates here, at
 * the edge. A Date that is secretly a string survives right up until something
 * compares or formats it.
 */
import { isRunState } from "@vo/core";
import type {
  Connection,
  Connector,
  Department,
  Document,
  Employee,
  EmployeeStatus,
  Office,
  RunState,
  Task,
  ToolGrant,
  UsageRecord,
  ValidationError,
} from "@vo/core";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "validation"; readonly errors: readonly ValidationError[] }
  | { readonly ok: false; readonly kind: "conflict"; readonly current: Department & Employee }
  | { readonly ok: false; readonly kind: "transport"; readonly message: string };

export interface OfficeSnapshot {
  readonly office: Office;
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
  readonly connections: readonly Connection[];
  /** What this office can reach outside itself. */
  readonly connectors: readonly Connector[];
}

export interface ApiClient {
  loadOffice(officeId: string): Promise<ApiResult<OfficeSnapshot>>;
  /** The office on its own, for when only it changed. */
  getOffice(id: string): Promise<ApiResult<Office>>;
  /** One entity, which is what a live canvas fetches when told it changed. */
  getDepartment(id: string): Promise<ApiResult<Department>>;
  getEmployee(id: string): Promise<ApiResult<Employee>>;
  getTask(id: string): Promise<ApiResult<Task>>;
  /**
   * Hands the office something that happened to a task and gets back where the
   * task ended up. A worker moves tasks this way rather than writing to storage
   * itself, so the office stays the only writer and everyone watching it sees
   * the move.
   */
  postTaskEvent(taskId: string, event: Readonly<Record<string, unknown>>): Promise<ApiResult<Task>>;
  /** What this office can reach: every connector, granted or not. */
  listConnectors(officeId: string): Promise<ApiResult<readonly Connector[]>>;
  createConnector(
    officeId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ApiResult<Connector>>;
  patchConnector(
    id: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
  ): Promise<ApiResult<Connector>>;
  deleteConnector(id: string): Promise<ApiResult<true>>;
  /**
   * The switch: stopping work, and starting it again. Separate from `patch*`
   * because stopping an office is not editing one, and because an instruction
   * that states a destination has nothing to conflict with — so these carry no
   * `sinceOffset`.
   */
  setOfficeRunState(id: string, runState: RunState): Promise<ApiResult<Office>>;
  setDepartmentRunState(id: string, runState: RunState): Promise<ApiResult<Department>>;
  setEmployeeStatus(id: string, status: EmployeeStatus): Promise<ApiResult<Employee>>;
  /**
   * What a call cost, told to the office as it happens. One post per call: an
   * event sent when it happens is one a dying worker cannot lose, and a turn
   * makes a handful of calls rather than thousands.
   */
  recordUsage(
    officeId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<ApiResult<UsageRecord>>;
  /** What an office, or one piece of work in it, has been spent on. */
  listUsage(officeId: string, taskId?: string): Promise<ApiResult<readonly UsageRecord[]>>;
  /** One document, which is what a live canvas fetches when told one arrived. */
  getDocument(id: string): Promise<ApiResult<Document>>;
  /** A whole office's documents, or one tray of them. */
  listDocuments(officeId: string, tray?: DocumentFilter): Promise<ApiResult<readonly Document[]>>;
  uploadDocument(officeId: string, input: UploadDocument): Promise<ApiResult<Document>>;
  /**
   * The body itself, as bytes. Not a URL: a link would have to carry the token,
   * and a token in a URL is a token in a log.
   */
  downloadDocument(id: string): Promise<ApiResult<Uint8Array>>;
  deleteDocument(id: string): Promise<ApiResult<true>>;
  patchOffice(
    id: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
  ): Promise<ApiResult<Office>>;
  patchConnection(
    id: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
  ): Promise<ApiResult<Connection>>;
  patchDepartment(
    id: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
  ): Promise<ApiResult<Department>>;
  patchEmployee(
    id: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
  ): Promise<ApiResult<Employee>>;
}

export interface DocumentFilter {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly tray: string;
}

export interface UploadDocument {
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly tray: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly body: Uint8Array;
  readonly addedBy?: string;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const asDate = (value: unknown): Date => new Date(String(value));

function reviveDocument(raw: Record<string, unknown>): Document {
  return { ...raw, addedAt: asDate(raw["addedAt"]) } as unknown as Document;
}

function reviveUsage(raw: Record<string, unknown>): UsageRecord {
  return { ...raw, at: asDate(raw["at"]) } as unknown as UsageRecord;
}

function reviveConnector(raw: Record<string, unknown>): Connector {
  return {
    ...raw,
    tools: listOr(raw["tools"]),
    // An office that predates a field says nothing about it, and a connector
    // that says nothing about being off is on — as an arrow is.
    enabled: raw["enabled"] !== false,
    createdAt: asDate(raw["createdAt"]),
  } as unknown as Connector;
}

function reviveOffice(raw: Record<string, unknown>): Office {
  return {
    ...raw,
    runState: runStateOr(raw["runState"]),
    createdAt: asDate(raw["createdAt"]),
  } as unknown as Office;
}

/**
 * Lists an entity is typed as always having.
 *
 * An office that predates a field simply does not send it, and this is the
 * boundary where untrusted JSON becomes a typed entity — so it is the place to
 * make the type's promise true, rather than defending against it everywhere
 * downstream.
 */
const listOr = (raw: unknown): readonly string[] => (Array.isArray(raw) ? (raw as string[]) : []);

/** An office stored before the switch existed says nothing, and is running. */
const runStateOr = (raw: unknown): RunState => (isRunState(raw) ? raw : "running");

/** The same promise, for the one list that is not a list of strings. */
const grantsOr = (raw: unknown): readonly ToolGrant[] =>
  Array.isArray(raw) ? (raw as ToolGrant[]) : [];

function reviveDepartment(raw: Record<string, unknown>): Department {
  return {
    ...raw,
    definitionOfDone: listOr(raw["definitionOfDone"]),
    toolGrants: grantsOr(raw["toolGrants"]),
    benches: Array.isArray(raw["benches"]) ? raw["benches"] : [],
    runState: runStateOr(raw["runState"]),
    createdAt: asDate(raw["createdAt"]),
  } as unknown as Department;
}

function reviveTask(raw: Record<string, unknown>): Task {
  const history = Array.isArray(raw["history"])
    ? (raw["history"] as Record<string, unknown>[])
    : [];
  return {
    ...raw,
    acceptanceCriteria: listOr(raw["acceptanceCriteria"]),
    route: listOr(raw["route"]),
    artifacts: listOr(raw["artifacts"]),
    history: history.map((event) => ({ ...event, at: asDate(event["at"]) })),
  } as unknown as Task;
}

function reviveConnection(raw: Record<string, unknown>): Connection {
  return {
    ...raw,
    // An office that predates the switch does not send it, and an arrow that
    // says nothing about being off is on.
    enabled: raw["enabled"] !== false,
    createdAt: asDate(raw["createdAt"]),
  } as unknown as Connection;
}

function reviveEmployee(raw: Record<string, unknown>): Employee {
  return {
    ...raw,
    toolGrants: grantsOr(raw["toolGrants"]),
    createdAt: asDate(raw["createdAt"]),
    statusChangedAt: asDate(raw["statusChangedAt"]),
  } as unknown as Employee;
}

/** Bytes as JSON can carry them. Chunked: spreading a megabyte overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Only the shape this client actually sends, so headers stay a plain record. */
  interface Call {
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }

  const call = async (
    path: string,
    init: Call = {},
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; message: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(`${options.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${options.token}`,
          // Only when there is one. A request that says it carries JSON and
          // carries nothing is refused by a strict server, which is how a
          // delete comes back 400 having done nothing.
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      const body: unknown = text.length === 0 ? null : JSON.parse(text);
      return { ok: true, status: response.status, body };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        message: aborted
          ? `the office took too long to answer (over ${String(timeoutMs)}ms)`
          : `could not reach the office: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * A call that answers with bytes rather than JSON. Its own function because
   * `call` reads the body as text and parses it, which a document is not.
   */
  const callBytes = async (
    path: string,
  ): Promise<{ ok: true; status: number; bytes: Uint8Array } | { ok: false; message: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await doFetch(`${options.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${options.token}` },
      });
      return {
        ok: true,
        status: response.status,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (error) {
      return {
        ok: false,
        message: `could not reach the office: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /** One reading of a response, so every route treats failure the same way. */
  const interpret = <T>(
    response: Awaited<ReturnType<typeof call>>,
    revive: (raw: Record<string, unknown>) => T,
  ): ApiResult<T> => {
    if (!response.ok) return { ok: false, kind: "transport", message: response.message };
    const body = response.body as Record<string, unknown> | null;

    if (response.status === 409) {
      const current = (body?.["current"] ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        kind: "conflict",
        current: {
          ...reviveDepartment(current),
          ...reviveEmployee(current),
        } as Department & Employee,
      };
    }
    if (response.status === 400) {
      return {
        ok: false,
        kind: "validation",
        errors: (body?.["errors"] ?? []) as ValidationError[],
      };
    }
    if (response.status >= 300 || body === null) {
      return {
        ok: false,
        kind: "transport",
        message: `the office answered ${String(response.status)}`,
      };
    }
    return { ok: true, value: revive(body) };
  };

  /**
   * A response that says nothing when it worked. `interpret` reads an empty body
   * as a failure, which is right everywhere else and wrong for a delete.
   */
  const nothing = (response: Awaited<ReturnType<typeof call>>): ApiResult<true> => {
    if (!response.ok) return { ok: false, kind: "transport", message: response.message };
    if (response.status >= 300) {
      return {
        ok: false,
        kind: "transport",
        message: `the office answered ${String(response.status)}`,
      };
    }
    return { ok: true, value: true };
  };

  const put = (path: string, body: Readonly<Record<string, unknown>>) =>
    call(path, { method: "PUT", body: JSON.stringify(body) });

  const patch = async <T>(
    path: string,
    changes: Readonly<Record<string, unknown>>,
    sinceOffset: number,
    revive: (raw: Record<string, unknown>) => T,
  ): Promise<ApiResult<T>> =>
    interpret(
      await call(path, {
        method: "PATCH",
        body: JSON.stringify(changes),
        headers: { "x-vo-since-offset": String(sinceOffset) },
      }),
      revive,
    );

  return {
    loadOffice: async (officeId) => {
      const office = await call(`/offices/${officeId}`);
      const asOffice = interpret(office, reviveOffice);
      if (!asOffice.ok) return asOffice;

      // Together rather than one after another: they do not depend on each
      // other, and this was already four round trips before connectors made five.
      const [departments, employees, tasks, connections, connectors] = await Promise.all([
        call(`/offices/${officeId}/departments`),
        call(`/offices/${officeId}/employees`),
        call(`/offices/${officeId}/tasks`),
        call(`/offices/${officeId}/connections`),
        call(`/offices/${officeId}/connectors`),
      ]);
      if (!departments.ok) return { ok: false, kind: "transport", message: departments.message };
      if (!employees.ok) return { ok: false, kind: "transport", message: employees.message };
      if (!tasks.ok) return { ok: false, kind: "transport", message: tasks.message };
      if (!connections.ok) return { ok: false, kind: "transport", message: connections.message };
      if (!connectors.ok) return { ok: false, kind: "transport", message: connectors.message };

      const items = (response: { body: unknown }): Record<string, unknown>[] =>
        (response.body as { items?: Record<string, unknown>[] } | null)?.items ?? [];

      return {
        ok: true,
        value: {
          office: asOffice.value,
          departments: items(departments).map(reviveDepartment),
          employees: items(employees).map(reviveEmployee),
          tasks: items(tasks).map(reviveTask),
          connections: items(connections).map(reviveConnection),
          connectors: items(connectors).map(reviveConnector),
        },
      };
    },

    getOffice: async (id) => interpret(await call(`/offices/${id}`), reviveOffice),

    getDepartment: async (id) => interpret(await call(`/departments/${id}`), reviveDepartment),
    getEmployee: async (id) => interpret(await call(`/employees/${id}`), reviveEmployee),
    getTask: async (id) => interpret(await call(`/tasks/${id}`), reviveTask),

    postTaskEvent: async (taskId, event) =>
      interpret(
        await call(`/tasks/${taskId}/events`, { method: "POST", body: JSON.stringify(event) }),
        reviveTask,
      ),

    listConnectors: async (officeId) =>
      interpret(await call(`/offices/${officeId}/connectors`), (raw) =>
        ((raw["items"] ?? []) as Record<string, unknown>[]).map(reviveConnector),
      ),

    createConnector: async (officeId, input) =>
      interpret(
        await call(`/offices/${officeId}/connectors`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
        reviveConnector,
      ),

    patchConnector: (id, changes, sinceOffset) =>
      patch(`/connectors/${id}`, changes, sinceOffset, reviveConnector),

    deleteConnector: async (id) => nothing(await call(`/connectors/${id}`, { method: "DELETE" })),

    setOfficeRunState: async (id, runState) =>
      interpret(await put(`/offices/${id}/run-state`, { runState }), reviveOffice),

    setDepartmentRunState: async (id, runState) =>
      interpret(await put(`/departments/${id}/run-state`, { runState }), reviveDepartment),

    setEmployeeStatus: async (id, status) =>
      interpret(await put(`/employees/${id}/status`, { status }), reviveEmployee),

    recordUsage: async (officeId, event) =>
      interpret(
        await call(`/offices/${officeId}/usage`, { method: "POST", body: JSON.stringify(event) }),
        reviveUsage,
      ),

    listUsage: async (officeId, taskId) =>
      interpret(
        await call(
          `/offices/${officeId}/usage${taskId === undefined ? "" : `?taskId=${encodeURIComponent(taskId)}`}`,
        ),
        (raw) => ((raw["items"] ?? []) as Record<string, unknown>[]).map(reviveUsage),
      ),

    getDocument: async (id) => interpret(await call(`/documents/${id}`), reviveDocument),

    listDocuments: async (officeId, tray) => {
      // Built rather than pasted: an owner id is somebody else's string.
      const query =
        tray === undefined
          ? ""
          : `?${new URLSearchParams({
              ownerKind: tray.ownerKind,
              ownerId: tray.ownerId,
              tray: tray.tray,
            }).toString()}`;
      return interpret(await call(`/offices/${officeId}/documents${query}`), (raw) =>
        ((raw["items"] ?? []) as Record<string, unknown>[]).map(reviveDocument),
      );
    },

    uploadDocument: async (officeId, input) =>
      interpret(
        await call(`/offices/${officeId}/documents`, {
          method: "POST",
          body: JSON.stringify({
            ownerKind: input.ownerKind,
            ownerId: input.ownerId,
            tray: input.tray,
            name: input.name,
            ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
            contentBase64: toBase64(input.body),
            ...(input.addedBy === undefined ? {} : { addedBy: input.addedBy }),
          }),
        }),
        reviveDocument,
      ),

    downloadDocument: async (id) => {
      const response = await callBytes(`/documents/${id}/content`);
      if (!response.ok) return { ok: false, kind: "transport", message: response.message };
      if (response.status >= 300) {
        return {
          ok: false,
          kind: "transport",
          message: `the office answered ${String(response.status)}`,
        };
      }
      return { ok: true, value: response.bytes };
    },

    deleteDocument: async (id) => nothing(await call(`/documents/${id}`, { method: "DELETE" })),

    patchOffice: (id, changes, sinceOffset) =>
      patch(`/offices/${id}`, changes, sinceOffset, reviveOffice),

    patchConnection: (id, changes, sinceOffset) =>
      patch(`/connections/${id}`, changes, sinceOffset, reviveConnection),

    patchDepartment: (id, changes, sinceOffset) =>
      patch(`/departments/${id}`, changes, sinceOffset, reviveDepartment),

    patchEmployee: (id, changes, sinceOffset) =>
      patch(`/employees/${id}`, changes, sinceOffset, reviveEmployee),
  };
}
