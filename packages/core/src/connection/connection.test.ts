import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import {
  CONNECTION_KINDS,
  createConnection,
  hasPath,
  validateConnectionGraph,
  type Connection,
  type ConnectionId,
} from "./connection.js";

const officeId = "office-1" as OfficeId;
const A = "dept-a" as DepartmentId;
const B = "dept-b" as DepartmentId;
const C = "dept-c" as DepartmentId;
const now = new Date("2026-09-22T00:00:00Z");
let counter = 0;
const deps = { id: () => `conn-${String(++counter)}` as ConnectionId, now: () => now };
const departments = new Set<DepartmentId>([A, B, C]);

function edge(
  fromId: DepartmentId,
  toId: DepartmentId,
  kind: Connection["kind"],
  existing: Connection[] = [],
): Connection {
  return unwrap(
    createConnection({ officeId, fromId, toId, kind }, { departments, existing }, deps),
  );
}

describe("createConnection", () => {
  it("lists the five connection kinds", () => {
    expect(CONNECTION_KINDS).toEqual([
      "reports_to",
      "collaborates",
      "handoff",
      "reviews",
      "escalates_to",
    ]);
  });

  it("creates a connection with empty rules by default", () => {
    const c = edge(A, B, "handoff");
    expect(c).toEqual<Connection>({
      id: c.id,
      officeId,
      fromId: A,
      toId: B,
      kind: "handoff",
      rules: {},
      createdAt: now,
    });
  });

  it("keeps rules as a copied object", () => {
    const rules = { brief: "summary-only" };
    const c = unwrap(
      createConnection(
        { officeId, fromId: A, toId: B, kind: "handoff", rules },
        { departments, existing: [] },
        deps,
      ),
    );
    expect(c.rules).toEqual(rules);
    expect(c.rules).not.toBe(rules);
  });

  it("rejects an unknown kind", () => {
    const r = createConnection(
      { officeId, fromId: A, toId: B, kind: "manages" as never },
      { departments, existing: [] },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("kind");
  });

  it("rejects self loops", () => {
    const r = createConnection(
      { officeId, fromId: A, toId: A, kind: "collaborates" },
      { departments, existing: [] },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/itself/);
  });

  it("rejects unknown departments on either end", () => {
    const ghost = "dept-ghost" as DepartmentId;
    const from = createConnection(
      { officeId, fromId: ghost, toId: A, kind: "reviews" },
      { departments, existing: [] },
      deps,
    );
    const to = createConnection(
      { officeId, fromId: A, toId: ghost, kind: "reviews" },
      { departments, existing: [] },
      deps,
    );
    expect(isErr(from)).toBe(true);
    if (isErr(from)) expect(from.error[0]?.path).toBe("fromId");
    expect(isErr(to)).toBe(true);
    if (isErr(to)) expect(to.error[0]?.path).toBe("toId");
  });

  it("rejects a duplicate edge of the same kind and direction", () => {
    const existing = [edge(A, B, "handoff")];
    const r = createConnection(
      { officeId, fromId: A, toId: B, kind: "handoff" },
      { departments, existing },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/already exists/);
  });

  it("allows the same pair with a different kind or the reverse direction for directed kinds", () => {
    const existing = [edge(A, B, "handoff")];
    expect(
      isOk(
        createConnection(
          { officeId, fromId: A, toId: B, kind: "reviews" },
          { departments, existing },
          deps,
        ),
      ),
    ).toBe(true);
    expect(
      isOk(
        createConnection(
          { officeId, fromId: B, toId: A, kind: "handoff" },
          { departments, existing },
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("treats collaborates as undirected for duplicate detection", () => {
    const existing = [edge(A, B, "collaborates")];
    const r = createConnection(
      { officeId, fromId: B, toId: A, kind: "collaborates" },
      { departments, existing },
      deps,
    );
    expect(isErr(r)).toBe(true);
  });

  it("rejects a reports_to edge that would create a cycle", () => {
    const existing = [edge(A, B, "reports_to"), edge(B, C, "reports_to")];
    const r = createConnection(
      { officeId, fromId: C, toId: A, kind: "reports_to" },
      { departments, existing },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/cycle/);
  });

  it("rejects an escalates_to edge that would create a cycle, even a two-node one", () => {
    const existing = [edge(A, B, "escalates_to")];
    const r = createConnection(
      { officeId, fromId: B, toId: A, kind: "escalates_to" },
      { departments, existing },
      deps,
    );
    expect(isErr(r)).toBe(true);
  });

  it("does not let cycles across different kinds block each other", () => {
    const existing = [edge(A, B, "reports_to"), edge(B, C, "reports_to")];
    expect(
      isOk(
        createConnection(
          { officeId, fromId: C, toId: A, kind: "escalates_to" },
          { departments, existing },
          deps,
        ),
      ),
    ).toBe(true);
    expect(
      isOk(
        createConnection(
          { officeId, fromId: C, toId: A, kind: "handoff" },
          { departments, existing },
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("rejects non-object rules", () => {
    const r = createConnection(
      { officeId, fromId: A, toId: B, kind: "handoff", rules: "fast" as never },
      { departments, existing: [] },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("rules");
  });
});

describe("hasPath", () => {
  it("finds direct and transitive paths and ignores other kinds", () => {
    const edges = [edge(A, B, "reports_to"), edge(B, C, "reports_to"), edge(C, A, "handoff")];
    expect(hasPath(edges, "reports_to", A, C)).toBe(true);
    expect(hasPath(edges, "reports_to", C, A)).toBe(false);
    expect(hasPath(edges, "handoff", C, A)).toBe(true);
    expect(hasPath(edges, "reviews", A, B)).toBe(false);
  });

  it("handles diamonds without revisiting nodes", () => {
    const D = "dept-d" as DepartmentId;
    const all = new Set<DepartmentId>([A, B, C, D]);
    const mk = (fromId: DepartmentId, toId: DepartmentId, existing: Connection[]): Connection =>
      unwrap(
        createConnection(
          { officeId, fromId, toId, kind: "reports_to" },
          { departments: all, existing },
          deps,
        ),
      );
    const e1 = mk(A, B, []);
    const e2 = mk(A, C, [e1]);
    const e3 = mk(B, D, [e1, e2]);
    const e4 = mk(C, D, [e1, e2, e3]);
    const edges = [e1, e2, e3, e4];
    expect(hasPath(edges, "reports_to", A, D)).toBe(true);
    expect(hasPath(edges, "reports_to", D, A)).toBe(false);
  });
});

describe("validateConnectionGraph", () => {
  it("accepts a valid graph", () => {
    const graph = [edge(A, B, "reports_to"), edge(B, C, "reports_to"), edge(A, C, "collaborates")];
    expect(validateConnectionGraph(graph, departments)).toEqual([]);
  });

  it("reports self loops, unknown departments, duplicates and cycles with indexed paths", () => {
    const mk = (
      fromId: DepartmentId,
      toId: DepartmentId,
      kind: Connection["kind"],
    ): Connection => ({
      id: `conn-${String(++counter)}` as ConnectionId,
      officeId,
      fromId,
      toId,
      kind,
      rules: {},
      createdAt: now,
    });
    const graph = [
      mk(A, A, "handoff"),
      mk(A, "dept-x" as DepartmentId, "reviews"),
      mk(A, B, "handoff"),
      mk(A, B, "handoff"),
      mk(B, C, "escalates_to"),
      mk(C, B, "escalates_to"),
    ];
    const errors = validateConnectionGraph(graph, departments);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("connections[0]");
    expect(paths).toContain("connections[1].toId");
    expect(paths).toContain("connections[3]");
    expect(errors.some((e) => e.message.includes("cycle"))).toBe(true);
  });
});
