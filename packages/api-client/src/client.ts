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
import type { Connection, Department, Employee, Office, Task, ValidationError } from "@vo/core";

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
}

export interface ApiClient {
  loadOffice(officeId: string): Promise<ApiResult<OfficeSnapshot>>;
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

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const asDate = (value: unknown): Date => new Date(String(value));

function reviveDepartment(raw: Record<string, unknown>): Department {
  return { ...raw, createdAt: asDate(raw["createdAt"]) } as unknown as Department;
}

function reviveTask(raw: Record<string, unknown>): Task {
  const history = Array.isArray(raw["history"])
    ? (raw["history"] as Record<string, unknown>[])
    : [];
  return {
    ...raw,
    history: history.map((event) => ({ ...event, at: asDate(event["at"]) })),
  } as unknown as Task;
}

function reviveConnection(raw: Record<string, unknown>): Connection {
  return { ...raw, createdAt: asDate(raw["createdAt"]) } as unknown as Connection;
}

function reviveEmployee(raw: Record<string, unknown>): Employee {
  return {
    ...raw,
    createdAt: asDate(raw["createdAt"]),
    statusChangedAt: asDate(raw["statusChangedAt"]),
  } as unknown as Employee;
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
          "content-type": "application/json",
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
      const asOffice = interpret(office, (raw) => raw as unknown as Office);
      if (!asOffice.ok) return asOffice;

      const departments = await call(`/offices/${officeId}/departments`);
      const employees = await call(`/offices/${officeId}/employees`);
      const tasks = await call(`/offices/${officeId}/tasks`);
      const connections = await call(`/offices/${officeId}/connections`);
      if (!departments.ok) return { ok: false, kind: "transport", message: departments.message };
      if (!employees.ok) return { ok: false, kind: "transport", message: employees.message };
      if (!tasks.ok) return { ok: false, kind: "transport", message: tasks.message };
      if (!connections.ok) return { ok: false, kind: "transport", message: connections.message };

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
        },
      };
    },

    getDepartment: async (id) => interpret(await call(`/departments/${id}`), reviveDepartment),
    getEmployee: async (id) => interpret(await call(`/employees/${id}`), reviveEmployee),
    getTask: async (id) => interpret(await call(`/tasks/${id}`), reviveTask),

    postTaskEvent: async (taskId, event) =>
      interpret(
        await call(`/tasks/${taskId}/events`, { method: "POST", body: JSON.stringify(event) }),
        reviveTask,
      ),

    patchDepartment: (id, changes, sinceOffset) =>
      patch(`/departments/${id}`, changes, sinceOffset, reviveDepartment),

    patchEmployee: (id, changes, sinceOffset) =>
      patch(`/employees/${id}`, changes, sinceOffset, reviveEmployee),
  };
}
