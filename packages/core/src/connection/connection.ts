/**
 * Connection: a typed, directed edge between two departments.
 *
 *   reports_to    hierarchy; acyclic
 *   escalates_to  escalation path; acyclic
 *   handoff       completion in `from` creates work in `to`
 *   reviews       `to` reviews work produced by `from`
 *   collaborates  undirected peer link
 */
import type { DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const connectionIdBrand: unique symbol;
export type ConnectionId = string & { readonly [connectionIdBrand]: true };

export const CONNECTION_KINDS = [
  "reports_to",
  "collaborates",
  "handoff",
  "reviews",
  "escalates_to",
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** Kinds whose graph must stay acyclic. */
export const ACYCLIC_KINDS: readonly ConnectionKind[] = ["reports_to", "escalates_to"];
/** Kinds where (a, b) and (b, a) are the same edge. */
export const UNDIRECTED_KINDS: readonly ConnectionKind[] = ["collaborates"];

export interface Connection {
  readonly id: ConnectionId;
  readonly officeId: OfficeId;
  readonly fromId: DepartmentId;
  readonly toId: DepartmentId;
  readonly kind: ConnectionKind;
  /** Kind-specific rules (e.g. handoff brief format), interpreted by the workflow engine. */
  readonly rules: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface CreateConnectionInput {
  readonly officeId: OfficeId;
  readonly fromId: DepartmentId;
  readonly toId: DepartmentId;
  readonly kind: ConnectionKind;
  readonly rules?: Record<string, unknown>;
}

export interface CreateConnectionContext {
  /** Departments that exist in the office. */
  readonly departments: ReadonlySet<DepartmentId>;
  /** Connections already in the office. */
  readonly existing: readonly Connection[];
}

export interface ConnectionDeps {
  readonly id: () => ConnectionId;
  readonly now: () => Date;
}

type Edge = Pick<Connection, "fromId" | "toId" | "kind">;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isKind(v: unknown): v is ConnectionKind {
  return typeof v === "string" && (CONNECTION_KINDS as readonly string[]).includes(v);
}

function sameEdge(a: Edge, b: Edge): boolean {
  if (a.kind !== b.kind) return false;
  if (a.fromId === b.fromId && a.toId === b.toId) return true;
  return UNDIRECTED_KINDS.includes(a.kind) && a.fromId === b.toId && a.toId === b.fromId;
}

/** True when `to` is reachable from `from` following edges of `kind`. */
export function hasPath(
  edges: readonly Edge[],
  kind: ConnectionKind,
  from: DepartmentId,
  to: DepartmentId,
): boolean {
  const adjacency = new Map<DepartmentId, DepartmentId[]>();
  for (const e of edges) {
    if (e.kind !== kind) continue;
    const list = adjacency.get(e.fromId) ?? [];
    list.push(e.toId);
    adjacency.set(e.fromId, list);
  }
  const seen = new Set<DepartmentId>();
  const stack: DepartmentId[] = [from];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

/**
 * Validates one edge against the departments and the edges before it.
 * `path` prefixes error paths so the same logic serves single creation and whole-graph checks.
 */
function validateEdge(
  edge: Edge,
  departments: ReadonlySet<DepartmentId>,
  before: readonly Edge[],
  path: string,
): ValidationError[] {
  const at = (field: string): string => (path.length > 0 ? `${path}.${field}` : field);
  const self = path.length > 0 ? path : "";
  const errors: ValidationError[] = [];

  if (!isKind(edge.kind)) {
    errors.push({ path: at("kind"), message: `must be one of ${CONNECTION_KINDS.join(", ")}` });
    return errors;
  }
  if (edge.fromId === edge.toId) {
    errors.push({ path: self, message: "a department cannot connect to itself" });
    return errors;
  }
  if (!departments.has(edge.fromId))
    errors.push({ path: at("fromId"), message: `unknown department "${edge.fromId}"` });
  if (!departments.has(edge.toId))
    errors.push({ path: at("toId"), message: `unknown department "${edge.toId}"` });
  if (errors.length > 0) return errors;

  if (before.some((b) => sameEdge(b, edge))) {
    errors.push({
      path: self,
      message: `a ${edge.kind} connection between these departments already exists`,
    });
    return errors;
  }
  if (ACYCLIC_KINDS.includes(edge.kind) && hasPath(before, edge.kind, edge.toId, edge.fromId)) {
    errors.push({
      path: self,
      message: `adding this ${edge.kind} connection would create a cycle`,
    });
  }
  return errors;
}

export function createConnection(
  input: CreateConnectionInput,
  ctx: CreateConnectionContext,
  deps: ConnectionDeps,
): Result<Connection> {
  const errors = validateEdge(input, ctx.departments, ctx.existing, "");
  const rules = input.rules ?? {};
  if (!isRecord(rules)) errors.push({ path: "rules", message: "must be an object" });
  if (errors.length > 0) return err(errors);
  return ok({
    id: deps.id(),
    officeId: input.officeId,
    fromId: input.fromId,
    toId: input.toId,
    kind: input.kind,
    rules: { ...rules },
    createdAt: deps.now(),
  });
}

/** Whole-graph check used on import/restore. Each edge is validated against the ones before it. */
export function validateConnectionGraph(
  connections: readonly Connection[],
  departments: ReadonlySet<DepartmentId>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const accepted: Edge[] = [];
  connections.forEach((c, i) => {
    const edgeErrors = validateEdge(c, departments, accepted, `connections[${String(i)}]`);
    if (edgeErrors.length === 0) accepted.push(c);
    errors.push(...edgeErrors);
  });
  return errors;
}
