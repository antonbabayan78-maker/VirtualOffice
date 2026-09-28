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
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";

declare const connectionIdBrand: unique symbol;
export type ConnectionId = string & { readonly [connectionIdBrand]: true };

export const CONNECTION_KINDS = [
  "reports_to",
  "collaborates",
  "handoff",
  "reviews",
  "escalates_to",
  "watches",
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
  /**
   * Whether this arrow is in force. An office is wired once and turned on and
   * off as it changes; deleting an arrow to pause it would lose the id that
   * everything referring to it depends on.
   */
  readonly enabled: boolean;
  /** Kind-specific rules (e.g. handoff brief format), interpreted by the workflow engine. */
  readonly rules: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface CreateConnectionInput {
  /** Defaults to on. An office can be drawn before it is meant to run. */
  readonly enabled?: boolean;
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

/**
 * Who picks up work that arrives along a handoff.
 *
 * Named or by skill, never both: ranking a named person against a skill match
 * would need a rule nothing in the office states. Saying nothing is allowed and
 * means whoever in the receiving department is freest.
 *
 * Checked when the arrow is drawn rather than when work arrives, so a mistake
 * surfaces to whoever made it instead of stopping a handoff weeks later.
 */
/**
 * The moments one department can watch another for.
 *
 * Read off the task's own status transitions rather than off the office event
 * log: these are a closed vocabulary the domain already owns, while the log is
 * a delivery channel for the canvas that happens to carry strings.
 */
export const WATCHABLE_MOMENTS = [
  "work_started",
  "work_finished",
  "work_went_wrong",
  "decision_wanted",
] as const;
export type WatchableMoment = (typeof WATCHABLE_MOMENTS)[number];

export function isWatchableMoment(value: unknown): value is WatchableMoment {
  return typeof value === "string" && (WATCHABLE_MOMENTS as readonly string[]).includes(value);
}

export type HandoffAssignment =
  | { readonly kind: "named"; readonly employeeId: string }
  | { readonly kind: "skill"; readonly skill: string }
  | { readonly kind: "anyone" };

export function parseHandoffAssignment(raw: unknown): Result<HandoffAssignment> {
  if (raw === undefined) return ok({ kind: "anyone" });
  if (!isRecord(raw)) return err([{ path: "assign", message: "must be an object" }]);

  const named = raw["named"];
  const skill = raw["skill"];
  if (named !== undefined && skill !== undefined) {
    return err([{ path: "assign", message: "name somebody or name a skill, not both" }]);
  }
  if (named !== undefined) {
    if (typeof named !== "string" || named.length === 0) {
      return err([{ path: "assign.named", message: "must be an employee id" }]);
    }
    return ok({ kind: "named", employeeId: named });
  }
  if (skill !== undefined) {
    if (typeof skill !== "string" || skill.length === 0) {
      return err([{ path: "assign.skill", message: "must be a skill" }]);
    }
    return ok({ kind: "skill", skill });
  }
  return err([
    { path: "assign", message: "say who takes the work: name somebody, or name a skill" },
  ]);
}

/** A handoff's rules, as the engine reads them. Other kinds carry rules of their own. */
export function parseHandoffRules(rules: Readonly<Record<string, unknown>>): Result<{
  readonly assign: HandoffAssignment;
}> {
  const assign = parseHandoffAssignment(rules["assign"]);
  if (!assign.ok) return err(assign.error);
  return ok({ assign: assign.value });
}

/** What a watching arrow is pointed at, and who takes the work it raises. */
export function parseWatchRules(rules: Readonly<Record<string, unknown>>): Result<{
  readonly moments: readonly WatchableMoment[];
  readonly assign: HandoffAssignment;
}> {
  const raw = rules["for"];
  if (!Array.isArray(raw) || raw.length === 0) {
    return err([
      {
        path: "for",
        message: `must say what it watches for: ${WATCHABLE_MOMENTS.join(", ")}`,
      },
    ]);
  }
  if (!raw.every(isWatchableMoment)) {
    return err([{ path: "for", message: `must each be one of ${WATCHABLE_MOMENTS.join(", ")}` }]);
  }

  const assign = parseHandoffAssignment(rules["assign"]);
  if (!assign.ok) return err(assign.error);
  return ok({ moments: raw, assign: assign.value });
}

export function createConnection(
  input: CreateConnectionInput,
  ctx: CreateConnectionContext,
  deps: ConnectionDeps,
): Result<Connection> {
  const errors = validateEdge(input, ctx.departments, ctx.existing, "");
  const rules = input.rules ?? {};
  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") {
    errors.push({ path: "enabled", message: "must be true or false" });
  }

  if (!isRecord(rules)) errors.push({ path: "rules", message: "must be an object" });
  else if (input.kind === "watches") {
    const parsed = parseWatchRules(rules);
    if (!parsed.ok) errors.push(...prefixErrors("rules", parsed.error));
  } else if (input.kind === "handoff") {
    // Only a handoff interprets these. The same key on another kind is somebody
    // else's business, not something to refuse.
    const parsed = parseHandoffRules(rules);
    if (!parsed.ok) errors.push(...prefixErrors("rules", parsed.error));
  }
  if (errors.length > 0) return err(errors);
  return ok({
    id: deps.id(),
    officeId: input.officeId,
    fromId: input.fromId,
    toId: input.toId,
    kind: input.kind,
    enabled,
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
