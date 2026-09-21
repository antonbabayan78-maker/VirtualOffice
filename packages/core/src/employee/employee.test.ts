import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import {
  createEmployee,
  transitionEmployee,
  type CreateEmployeeContext,
  type Employee,
  type EmployeeId,
} from "./employee.js";

const officeId = "office-1" as OfficeId;
const otherOfficeId = "office-2" as OfficeId;
const departmentId = "dept-1" as DepartmentId;
const now = new Date("2026-09-22T00:00:00Z");
const deps = { id: () => "emp-1" as EmployeeId, now: () => now };
const ctx: CreateEmployeeContext = {
  department: { id: departmentId, officeId },
  supervisor: null,
};
const base = {
  name: "Ada",
  role: "Backend Engineer",
  color: "#10B981",
  llm: { provider: "anthropic", model: "claude-sonnet-5" },
};

function make(
  overrides: Partial<typeof base> & Record<string, unknown> = {},
  context = ctx,
): Employee {
  return unwrap(createEmployee({ ...base, ...overrides }, context, deps));
}

describe("createEmployee", () => {
  it("creates an active employee with defaults", () => {
    const e = make();
    expect(e).toEqual<Employee>({
      id: "emp-1" as EmployeeId,
      officeId,
      departmentId,
      name: "Ada",
      role: "Backend Engineer",
      avatar: null,
      color: "#10b981",
      llm: { provider: "anthropic", model: "claude-sonnet-5", params: {}, fallbacks: [] },
      skillIds: [],
      toolGrants: [],
      schedule: null,
      supervisorId: null,
      workspaceRef: null,
      status: "active",
      statusChangedAt: now,
      createdAt: now,
    });
  });

  it("accepts skills, tool grants, an own schedule, avatar and workspace", () => {
    const e = make({
      avatar: "robot-3",
      skillIds: ["code-review", "tdd"],
      toolGrants: [
        { connectorId: "github", tool: "create_pr" },
        { connectorId: "slack", tool: "*" },
      ],
      schedule: {
        kind: "windows",
        timezone: "UTC",
        windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
      },
      workspaceRef: "git://acme/backend",
    });
    expect(e.avatar).toBe("robot-3");
    expect(e.skillIds).toEqual(["code-review", "tdd"]);
    expect(e.toolGrants).toHaveLength(2);
    expect(e.schedule?.kind).toBe("windows");
    expect(e.workspaceRef).toBe("git://acme/backend");
  });

  it("links a supervisor from the same office", () => {
    const e = make(
      { supervisorId: "emp-boss" },
      {
        department: { id: departmentId, officeId },
        supervisor: { id: "emp-boss" as EmployeeId, officeId, status: "active" },
      },
    );
    expect(e.supervisorId).toBe("emp-boss");
  });

  it("rejects a supervisor from another office", () => {
    const r = createEmployee(
      { ...base, supervisorId: "emp-boss" },
      {
        department: { id: departmentId, officeId },
        supervisor: { id: "emp-boss" as EmployeeId, officeId: otherOfficeId, status: "active" },
      },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]).toMatchObject({ path: "supervisorId" });
  });

  it("rejects a supervisor that could not be resolved or is terminated", () => {
    const missing = createEmployee({ ...base, supervisorId: "ghost" }, ctx, deps);
    expect(isErr(missing)).toBe(true);
    const terminated = createEmployee(
      { ...base, supervisorId: "emp-old" },
      {
        department: { id: departmentId, officeId },
        supervisor: { id: "emp-old" as EmployeeId, officeId, status: "terminated" },
      },
      deps,
    );
    expect(isErr(terminated)).toBe(true);
    if (isErr(terminated)) expect(terminated.error[0]?.message).toMatch(/terminated/);
  });

  it("rejects an employee supervising themselves", () => {
    const r = createEmployee(
      { ...base, supervisorId: "emp-1" },
      {
        department: { id: departmentId, officeId },
        supervisor: { id: "emp-1" as EmployeeId, officeId, status: "active" },
      },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/themselves/);
  });

  it("validates name, role and color", () => {
    for (const [field, value] of [
      ["name", ""],
      ["name", "x".repeat(81)],
      ["role", " "],
      ["color", "green"],
    ] as const) {
      const r = createEmployee({ ...base, [field]: value }, ctx, deps);
      expect(isErr(r), `${field}=${JSON.stringify(value)}`).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe(field);
    }
  });

  it("rejects non-string skill ids and non-object tool grants", () => {
    const skills = createEmployee({ ...base, skillIds: [3] as never }, ctx, deps);
    expect(isErr(skills)).toBe(true);
    if (isErr(skills)) expect(skills.error[0]?.path).toBe("skillIds");
    const grants = createEmployee({ ...base, toolGrants: ["github"] as never }, ctx, deps);
    expect(isErr(grants)).toBe(true);
    if (isErr(grants)) expect(grants.error[0]?.path).toBe("toolGrants[0]");
    const tool = createEmployee(
      { ...base, toolGrants: [{ connectorId: "github", tool: "" }] },
      ctx,
      deps,
    );
    expect(isErr(tool)).toBe(true);
    if (isErr(tool)) expect(tool.error[0]?.path).toBe("toolGrants[0].tool");
  });

  it("rejects duplicate skill ids and malformed tool grants", () => {
    const skills = createEmployee({ ...base, skillIds: ["a", "a"] }, ctx, deps);
    expect(isErr(skills)).toBe(true);
    if (isErr(skills)) expect(skills.error[0]?.path).toBe("skillIds");
    const grants = createEmployee(
      { ...base, toolGrants: [{ connectorId: "", tool: "x" }] as never },
      ctx,
      deps,
    );
    expect(isErr(grants)).toBe(true);
    if (isErr(grants)) expect(grants.error[0]?.path).toBe("toolGrants[0].connectorId");
  });

  it("nests llm and schedule errors under their paths", () => {
    const r = createEmployee(
      { ...base, llm: { provider: "anthropic" }, schedule: { kind: "nope" } },
      ctx,
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const paths = r.error.map((e) => e.path);
      expect(paths).toContain("llm.model");
      expect(paths).toContain("schedule.kind");
    }
  });
});

describe("transitionEmployee", () => {
  const later = new Date("2026-09-23T00:00:00Z");

  it("pauses and resumes an active employee, stamping statusChangedAt", () => {
    const paused = unwrap(transitionEmployee(make(), "paused", later));
    expect(paused.status).toBe("paused");
    expect(paused.statusChangedAt).toEqual(later);
    const resumed = unwrap(transitionEmployee(paused, "active", new Date("2026-09-24T00:00:00Z")));
    expect(resumed.status).toBe("active");
  });

  it("terminates from active or paused", () => {
    expect(unwrap(transitionEmployee(make(), "terminated", later)).status).toBe("terminated");
    const paused = unwrap(transitionEmployee(make(), "paused", later));
    expect(unwrap(transitionEmployee(paused, "terminated", later)).status).toBe("terminated");
  });

  it("treats terminated as final", () => {
    const gone = unwrap(transitionEmployee(make(), "terminated", later));
    for (const to of ["active", "paused", "terminated"] as const) {
      const r = transitionEmployee(gone, to, later);
      expect(isErr(r), to).toBe(true);
      if (isErr(r)) expect(r.error[0]?.message).toMatch(/terminated/);
    }
  });

  it("rejects a no-op transition to the same status", () => {
    const r = transitionEmployee(make(), "active", later);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/already active/);
  });

  it("does not mutate the input", () => {
    const e = make();
    expect(isOk(transitionEmployee(e, "paused", later))).toBe(true);
    expect(e.status).toBe("active");
    expect(e.statusChangedAt).toEqual(now);
  });
});
