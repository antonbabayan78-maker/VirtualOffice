/**
 * Office file: the YAML representation of an OfficeConfig (plan §9, §13).
 *
 * Export is deterministic (entities sorted by id, ISO timestamps). Import parses
 * with position tracking, validates through the same core factories the API
 * uses, and reports every problem with its path and YAML line/column. Runtime
 * data (tasks, memory, events) is never part of the file.
 */
import { LineCounter, isNode, parseDocument, stringify, type Document } from "yaml";
import {
  createConnection,
  type Connection,
  type ConnectionId,
  type ConnectionKind,
} from "../connection/connection.js";
import {
  createConnector,
  validateToolGrants,
  type Connector,
  type ConnectorId,
  type ConnectorKind,
  type ToolGrant,
} from "../connector/connector.js";
import { createDepartment, type Department, type DepartmentId } from "../department/department.js";
import {
  createEmployee,
  type Employee,
  type EmployeeId,
  type EmployeeStatus,
} from "../employee/employee.js";
import { createOffice, type Office, type OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";
import type { OfficeConfig } from "../snapshot/snapshot.js";

export const OFFICE_FILE_VERSION = 1;

export interface OfficeFileError extends ValidationError {
  readonly line?: number;
  readonly col?: number;
}

export interface OfficeFileDeps {
  /** Used for entities whose id is missing from the file. */
  readonly id: () => string;
  /** Used for entities whose createdAt is missing from the file. */
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function omitNull(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

export function exportOfficeYaml(config: OfficeConfig): string {
  const o = config.office;
  const file = {
    version: OFFICE_FILE_VERSION,
    office: {
      id: o.id,
      name: o.name,
      schedule: o.schedule,
      configVersion: o.configVersion,
      createdAt: o.createdAt.toISOString(),
    },
    departments: byId(config.departments).map((d) =>
      omitNull({
        id: d.id,
        name: d.name,
        color: d.color,
        icon: d.icon,
        position: d.position,
        size: d.size,
        config: d.config,
        reviewPolicy: d.reviewPolicy,
        createdAt: d.createdAt.toISOString(),
      }),
    ),
    employees: byId(config.employees).map((e) =>
      omitNull({
        id: e.id,
        department: e.departmentId,
        name: e.name,
        role: e.role,
        avatar: e.avatar,
        color: e.color,
        llm: omitNull({
          provider: e.llm.provider,
          model: e.llm.model,
          params: Object.keys(e.llm.params).length > 0 ? e.llm.params : null,
          fallbacks: e.llm.fallbacks.length > 0 ? e.llm.fallbacks : null,
        }),
        skills: e.skillIds,
        tools: e.toolGrants.map((g) => ({ connector: g.connectorId, tool: g.tool })),
        schedule: e.schedule,
        supervisor: e.supervisorId,
        workspace: e.workspaceRef,
        status: e.status,
        statusChangedAt: e.statusChangedAt.toISOString(),
        createdAt: e.createdAt.toISOString(),
      }),
    ),
    connections: byId(config.connections).map((c) => ({
      id: c.id,
      from: c.fromId,
      to: c.toId,
      kind: c.kind,
      rules: c.rules,
      createdAt: c.createdAt.toISOString(),
    })),
    connectors: byId(config.connectors).map((k) =>
      omitNull({
        id: k.id,
        kind: k.kind,
        name: k.name,
        config: k.config,
        secretRef: k.secretRef,
        tools: k.tools,
        enabled: k.enabled,
        createdAt: k.createdAt.toISOString(),
      }),
    ),
  };
  return stringify(file, { lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pathParts(path: string): (string | number)[] {
  const parts: (string | number)[] = [];
  for (const segment of path.split(".")) {
    if (segment.length === 0) continue;
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(segment);
    if (!m) {
      parts.push(segment);
      continue;
    }
    parts.push(m[1] ?? segment);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) parts.push(Number(idx[1]));
  }
  return parts;
}

class Locator {
  constructor(
    private readonly doc: Document,
    private readonly lines: LineCounter,
  ) {}

  /** Line/col of the deepest existing node on the path (falls back to ancestors, then line 1). */
  locate(path: string): { line: number; col: number } {
    const parts = pathParts(path);
    for (let depth = parts.length; depth >= 0; depth--) {
      const node = depth === 0 ? this.doc.contents : this.doc.getIn(parts.slice(0, depth), true);
      if (isNode(node) && node.range) return this.lines.linePos(node.range[0]);
    }
    return { line: 1, col: 1 };
  }
}

class Collector {
  readonly errors: OfficeFileError[] = [];
  constructor(private readonly locator: Locator) {}

  add(path: string, message: string): void {
    const pos = this.locator.locate(path);
    this.errors.push({ path, message, line: pos.line, col: pos.col });
  }

  addAll(
    prefix: string,
    errors: readonly ValidationError[],
    rename: (p: string) => string = (p) => p,
  ): void {
    for (const e of errors) {
      const local = rename(e.path);
      this.add(local.length === 0 ? prefix : `${prefix}.${local}`, e.message);
    }
  }
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function str(raw: Raw, key: string): string | undefined {
  const v = raw[key];
  return typeof v === "string" ? v : undefined;
}

function date(
  raw: Raw,
  key: string,
  fallback: Date,
  at: (p: string, m: string) => void,
  path: string,
): Date {
  const v = raw[key];
  if (v === undefined) return fallback;
  const d = typeof v === "string" || v instanceof Date ? new Date(v) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) {
    at(`${path}.${key}`, "must be an ISO-8601 timestamp");
    return fallback;
  }
  return d;
}

function requireStrings(raw: Raw, keys: readonly string[], path: string, c: Collector): boolean {
  let ok = true;
  for (const key of keys) {
    if (typeof raw[key] !== "string") {
      c.add(`${path}.${key}`, "is required and must be a string");
      ok = false;
    }
  }
  return ok;
}

function list(raw: Raw, key: string, c: Collector): Raw[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    c.add(key, "must be a list");
    return [];
  }
  const out: Raw[] = [];
  v.forEach((item: unknown, i) => {
    if (isRecord(item)) out.push(item);
    else c.add(`${key}[${String(i)}]`, "must be a mapping");
  });
  return out;
}

const EMPLOYEE_RENAMES: [RegExp, string][] = [
  [/^supervisorId\b/, "supervisor"],
  [/^toolGrants\[(\d+)\]\.connectorId\b/, "tools[$1].connector"],
  [/^toolGrants\b/, "tools"],
  [/^skillIds\b/, "skills"],
  [/^workspaceRef\b/, "workspace"],
];
const CONNECTION_RENAMES: [RegExp, string][] = [
  [/^fromId\b/, "from"],
  [/^toId\b/, "to"],
];
const rename =
  (table: [RegExp, string][]) =>
  (p: string): string =>
    table.reduce((acc, [re, to]) => acc.replace(re, to), p);

export function importOfficeYaml(
  text: string,
  deps: OfficeFileDeps,
): Result<OfficeConfig, OfficeFileError[]> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, keepSourceTokens: true });
  if (doc.errors.length > 0) {
    return err(
      doc.errors.map((e) => {
        const pos = e.linePos?.[0];
        return {
          path: "",
          message: e.message.split("\n")[0] ?? e.message,
          ...(pos ? { line: pos.line, col: pos.col } : {}),
        };
      }),
    );
  }
  const c = new Collector(new Locator(doc, lines));
  const report = (p: string, m: string): void => {
    c.add(p, m);
  };
  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) {
    c.add("", "the office file must be a YAML mapping");
    return err(c.errors);
  }
  if (raw["version"] !== OFFICE_FILE_VERSION) {
    c.add(
      "version",
      `unsupported office file version ${JSON.stringify(raw["version"])}; expected ${String(OFFICE_FILE_VERSION)}`,
    );
    return err(c.errors);
  }

  // Office ----------------------------------------------------------------
  const rawOffice = raw["office"];
  if (!isRecord(rawOffice)) {
    c.add("office", "is required and must be a mapping");
    return err(c.errors);
  }
  const officeId = (str(rawOffice, "id") ?? deps.id()) as OfficeId;
  const officeCreated = date(rawOffice, "createdAt", deps.now(), report, "office");
  let office: Office | null = null;
  if (requireStrings(rawOffice, ["name"], "office", c)) {
    const r = createOffice(
      {
        name: rawOffice["name"] as string,
        ...("schedule" in rawOffice ? { schedule: rawOffice["schedule"] } : {}),
      },
      { id: () => officeId, now: () => officeCreated },
    );
    if (r.ok) office = r.value;
    else c.addAll("office", r.error);
  }
  const rawVersion = rawOffice["configVersion"] ?? 1;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1)
    c.add("office.configVersion", "must be a positive integer");
  else if (office) office = { ...office, configVersion: rawVersion };

  // Departments -----------------------------------------------------------
  const departments: Department[] = [];
  const seenDepartmentIds = new Set<string>();
  list(raw, "departments", c).forEach((d, i) => {
    const path = `departments[${String(i)}]`;
    const id = str(d, "id") ?? deps.id();
    if (seenDepartmentIds.has(id)) c.add(`${path}.id`, `duplicate department id "${id}"`);
    seenDepartmentIds.add(id);
    if (!requireStrings(d, ["name", "color"], path, c)) return;
    if (!isRecord(d["position"])) {
      c.add(`${path}.position`, "is required and must be a mapping with x and y");
      return;
    }
    const created = date(d, "createdAt", deps.now(), report, path);
    const r = createDepartment(
      {
        officeId,
        name: d["name"] as string,
        color: d["color"] as string,
        position: d["position"] as { x: number; y: number },
        ...(typeof d["icon"] === "string" ? { icon: d["icon"] } : {}),
        ...(isRecord(d["size"]) ? { size: d["size"] as { width: number; height: number } } : {}),
        ...(isRecord(d["config"]) ? { config: d["config"] } : {}),
        ...("reviewPolicy" in d ? { reviewPolicy: d["reviewPolicy"] } : {}),
      },
      departments,
      { id: () => id as DepartmentId, now: () => created },
    );
    if (r.ok) departments.push(r.value);
    else c.addAll(path, r.error);
  });

  // Connectors ------------------------------------------------------------
  const connectors: Connector[] = [];
  const seenConnectorIds = new Set<string>();
  list(raw, "connectors", c).forEach((k, i) => {
    const path = `connectors[${String(i)}]`;
    const id = str(k, "id") ?? deps.id();
    if (seenConnectorIds.has(id)) c.add(`${path}.id`, `duplicate connector id "${id}"`);
    seenConnectorIds.add(id);
    if (!requireStrings(k, ["kind", "name"], path, c)) return;
    const tools = Array.isArray(k["tools"])
      ? (k["tools"] as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const created = date(k, "createdAt", deps.now(), report, path);
    const r = createConnector(
      {
        officeId,
        kind: k["kind"] as ConnectorKind,
        name: k["name"] as string,
        tools,
        ...(isRecord(k["config"]) ? { config: k["config"] } : {}),
        ...(typeof k["secretRef"] === "string" ? { secretRef: k["secretRef"] } : {}),
        ...(typeof k["enabled"] === "boolean" ? { enabled: k["enabled"] } : {}),
      },
      connectors,
      { id: () => id as ConnectorId, now: () => created },
    );
    if (r.ok) connectors.push(r.value);
    else c.addAll(path, r.error);
  });

  // Employees -------------------------------------------------------------
  const rawEmployees = list(raw, "employees", c);
  const employeeIds = rawEmployees.map((e) => str(e, "id") ?? deps.id());
  const employees: Employee[] = [];
  const statuses: EmployeeStatus[] = ["active", "paused", "terminated"];
  rawEmployees.forEach((e, i) => {
    const path = `employees[${String(i)}]`;
    const id = employeeIds[i] ?? deps.id();
    if (employeeIds.indexOf(id) !== i) c.add(`${path}.id`, `duplicate employee id "${id}"`);
    if (!requireStrings(e, ["name", "role", "color", "department"], path, c)) return;
    const departmentId = e["department"] as string;
    if (!departments.some((d) => d.id === departmentId))
      c.add(`${path}.department`, `unknown department "${departmentId}"`);
    const rawStatus = e["status"] ?? "active";
    if (!statuses.includes(rawStatus as EmployeeStatus))
      c.add(`${path}.status`, `must be one of ${statuses.join(", ")}`);
    const supervisorId = str(e, "supervisor");
    const supervisorIndex = supervisorId === undefined ? -1 : employeeIds.indexOf(supervisorId);
    const supervisor =
      supervisorId !== undefined && supervisorIndex >= 0
        ? {
            id: supervisorId as EmployeeId,
            officeId,
            status: (rawEmployees[supervisorIndex]?.["status"] ?? "active") as EmployeeStatus,
          }
        : null;
    const rawTools = Array.isArray(e["tools"]) ? (e["tools"] as unknown[]) : [];
    const toolGrants: ToolGrant[] = rawTools.map((t) =>
      isRecord(t)
        ? { connectorId: asText(t["connector"]), tool: asText(t["tool"]) }
        : { connectorId: "", tool: "" },
    );
    const created = date(e, "createdAt", deps.now(), report, path);
    const r = createEmployee(
      {
        name: e["name"] as string,
        role: e["role"] as string,
        color: e["color"] as string,
        llm: e["llm"],
        ...(typeof e["avatar"] === "string" ? { avatar: e["avatar"] } : {}),
        ...(Array.isArray(e["skills"]) ? { skillIds: e["skills"] as string[] } : {}),
        toolGrants,
        ...("schedule" in e ? { schedule: e["schedule"] } : {}),
        ...(supervisorId === undefined ? {} : { supervisorId }),
        ...(typeof e["workspace"] === "string" ? { workspaceRef: e["workspace"] } : {}),
      },
      { department: { id: departmentId as DepartmentId, officeId }, supervisor },
      { id: () => id as EmployeeId, now: () => created },
    );
    c.addAll(path, validateToolGrants(toolGrants, connectors), rename(EMPLOYEE_RENAMES));
    if (!r.ok) {
      c.addAll(path, r.error, rename(EMPLOYEE_RENAMES));
      return;
    }
    let employee = r.value;
    if (rawStatus !== "active" && statuses.includes(rawStatus as EmployeeStatus)) {
      employee = {
        ...employee,
        status: rawStatus as EmployeeStatus,
        statusChangedAt: date(e, "statusChangedAt", created, report, path),
      };
    } else {
      employee = {
        ...employee,
        statusChangedAt: date(e, "statusChangedAt", created, report, path),
      };
    }
    employees.push(employee);
  });

  // Connections -----------------------------------------------------------
  const connections: Connection[] = [];
  const departmentIds = new Set(departments.map((d) => d.id));
  list(raw, "connections", c).forEach((x, i) => {
    const path = `connections[${String(i)}]`;
    if (!requireStrings(x, ["from", "to", "kind"], path, c)) return;
    const created = date(x, "createdAt", deps.now(), report, path);
    const r = createConnection(
      {
        officeId,
        fromId: x["from"] as DepartmentId,
        toId: x["to"] as DepartmentId,
        kind: x["kind"] as ConnectionKind,
        ...(isRecord(x["rules"]) ? { rules: x["rules"] } : {}),
      },
      { departments: departmentIds, existing: connections },
      {
        id: () => (str(x, "id") ?? deps.id()) as ConnectionId,
        now: () => created,
      },
    );
    if (r.ok) connections.push(r.value);
    else c.addAll(path, r.error, rename(CONNECTION_RENAMES));
  });

  if (c.errors.length > 0 || office === null) return err(c.errors);
  return ok({ office, departments, employees, connections, connectors });
}
