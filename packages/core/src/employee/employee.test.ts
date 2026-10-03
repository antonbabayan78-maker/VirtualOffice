import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import {
  createEmployee,
  EMPLOYEE_STATUSES,
  isEmployeeStatus,
  updateEmployee,
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
      instructions: null,
      examples: [],
      llm: { provider: "anthropic", model: "claude-sonnet-5", params: {}, fallbacks: [] },
      skillIds: [],
      toolGrants: [],
      budget: null,
      schedule: null,
      supervisorId: null,
      workspaceRef: null,
      priority: "normal",
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

describe("updateEmployee", () => {
  const officeId = "office-1" as OfficeId;
  const departmentId = "dept-1" as DepartmentId;
  const boss = { id: "emp-boss" as EmployeeId, officeId, status: "active" as const };

  const hired = (): Employee =>
    unwrap(
      createEmployee(
        {
          name: "Ada",
          role: "Engineer",
          color: "#00aa66",
          llm: { provider: "anthropic", model: "claude-sonnet-5" },
        },
        { department: { id: departmentId, officeId }, supervisor: null },
        { id: () => "emp-ada" as EmployeeId, now: () => new Date("2026-09-01T00:00:00Z") },
      ),
    );

  it("changes what it was asked to change", () => {
    const changed = unwrap(updateEmployee(hired(), { name: "Ada Lovelace" }, { supervisor: null }));
    expect(changed.name).toBe("Ada Lovelace");
  });

  it("leaves everything else exactly as it was", () => {
    const before = hired();
    const after = unwrap(updateEmployee(before, { name: "Ada Lovelace" }, { supervisor: null }));
    expect({ ...after, name: before.name }).toEqual(before);
  });

  it("keeps who they are and when they joined", () => {
    const before = hired();
    const after = unwrap(updateEmployee(before, { role: "Staff engineer" }, { supervisor: null }));
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.officeId).toBe(before.officeId);
    expect(after.departmentId).toBe(before.departmentId);
  });

  it("does not put a paused employee back to work", () => {
    const paused = unwrap(transitionEmployee(hired(), "paused", new Date("2026-09-10T00:00:00Z")));
    const after = unwrap(updateEmployee(paused, { role: "Staff engineer" }, { supervisor: null }));
    expect(after.status).toBe("paused");
    expect(after.statusChangedAt).toEqual(paused.statusChangedAt);
  });

  it("refuses a name that is not a name", () => {
    const r = updateEmployee(hired(), { name: "  " }, { supervisor: null });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("name");
  });

  it("refuses a colour that is not a colour", () => {
    expect(isErr(updateEmployee(hired(), { color: "nope" }, { supervisor: null }))).toBe(true);
  });

  it("takes a new model and a fallback chain", () => {
    const after = unwrap(
      updateEmployee(
        hired(),
        {
          llm: {
            provider: "anthropic",
            model: "claude-opus-5",
            fallbacks: [{ provider: "anthropic", model: "claude-haiku-4-5-20251001" }],
          },
        },
        { supervisor: null },
      ),
    );
    expect(after.llm.model).toBe("claude-opus-5");
    expect(after.llm.fallbacks).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    ]);
  });

  it("appoints a supervisor", () => {
    const after = unwrap(updateEmployee(hired(), { supervisorId: boss.id }, { supervisor: boss }));
    expect(after.supervisorId).toBe(boss.id);
  });

  it("removes one", () => {
    const managed = unwrap(
      updateEmployee(hired(), { supervisorId: boss.id }, { supervisor: boss }),
    );
    const freed = unwrap(updateEmployee(managed, { supervisorId: null }, { supervisor: null }));
    expect(freed.supervisorId).toBeNull();
  });

  it("will not let anyone supervise themselves", () => {
    const ada = hired();
    const r = updateEmployee(
      ada,
      { supervisorId: ada.id },
      { supervisor: { id: ada.id, officeId, status: "active" } },
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/themselves/);
  });

  it("will not take a supervisor from another office", () => {
    const elsewhere = {
      id: "emp-far" as EmployeeId,
      officeId: "office-2" as OfficeId,
      status: "active" as const,
    };
    const r = updateEmployee(hired(), { supervisorId: elsewhere.id }, { supervisor: elsewhere });
    expect(isErr(r)).toBe(true);
  });

  it("will not take a terminated supervisor", () => {
    const gone = { ...boss, status: "terminated" as const };
    expect(isErr(updateEmployee(hired(), { supervisorId: gone.id }, { supervisor: gone }))).toBe(
      true,
    );
  });

  it("sets and clears working hours", () => {
    const nights = unwrap(
      updateEmployee(
        hired(),
        {
          schedule: {
            kind: "windows",
            timezone: "UTC",
            windows: [{ days: ["mon"], start: "22:00", end: "06:00" }],
          },
        },
        { supervisor: null },
      ),
    );
    expect(nights.schedule).toMatchObject({ kind: "windows" });
    expect(
      unwrap(updateEmployee(nights, { schedule: null }, { supervisor: null })).schedule,
    ).toBeNull();
  });

  it("reports every problem at once, not just the first", () => {
    const r = updateEmployee(hired(), { name: "", color: "nope" }, { supervisor: null });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.length).toBeGreaterThan(1);
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

describe("an employee's standing priority", () => {
  it("is normal unless the employee is given one", () => {
    expect(unwrap(createEmployee(base, ctx, deps)).priority).toBe("normal");
  });

  it("is taken from the employee when it is given one", () => {
    expect(unwrap(createEmployee({ ...base, priority: "low" }, ctx, deps)).priority).toBe("low");
  });

  it("refuses a priority that is not one", () => {
    const result = createEmployee({ ...base, priority: "meh" }, ctx, deps);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("priority");
  });

  it("can be lowered later, which is how somebody is told to yield", () => {
    const employee = unwrap(createEmployee(base, ctx, deps));
    expect(
      unwrap(updateEmployee(employee, { priority: "low" }, { supervisor: null })).priority,
    ).toBe("low");
  });

  it("stays as it was when a change does not mention it", () => {
    const employee = unwrap(createEmployee({ ...base, priority: "high" }, ctx, deps));
    const after = unwrap(updateEmployee(employee, { name: "Ada L" }, { supervisor: null }));
    expect(after.priority).toBe("high");
  });
});

describe("the statuses a person can be in", () => {
  it("names them, so a caller can check one without a second list", () => {
    // Every other closed set in core is exported this way; a route that spelt
    // these out again would be a second list to keep in step.
    expect(EMPLOYEE_STATUSES).toEqual(["active", "paused", "terminated"]);
  });

  it("recognises one, and refuses anything else", () => {
    expect(isEmployeeStatus("paused")).toBe(true);
    expect(isEmployeeStatus("napping")).toBe(false);
    expect(isEmployeeStatus(undefined)).toBe(false);
  });
});

describe("telling a person how to work", () => {
  it("holds a paragraph of standing instructions", () => {
    const e = make({ instructions: "Always check the order number before replying." });

    expect(e.instructions).toBe("Always check the order number before replying.");
  });

  it("has none by default, which is every office that ran before this", () => {
    expect(make().instructions).toBeNull();
    expect(make().examples).toEqual([]);
  });

  it("treats nothing written as nothing at all", () => {
    // One representation for "unwritten", so an empty block can never reach a
    // prompt and two people with nothing to say are identical.
    expect(make({ instructions: "" }).instructions).toBeNull();
    expect(make({ instructions: "   \n  " }).instructions).toBeNull();
  });

  it("refuses a paragraph longer than anybody would read", () => {
    expect(isErr(createEmployee({ ...base, instructions: "x".repeat(20_001) }, ctx, deps))).toBe(
      true,
    );
  });

  it("refuses instructions that are not text", () => {
    expect(isErr(createEmployee({ ...base, instructions: 42 }, ctx, deps))).toBe(true);
  });

  it("keeps what somebody typed, newlines and all", () => {
    // It is a paragraph somebody wrote, not a name: the shape of it is part of
    // what it says.
    const typed = "Write in short paragraphs.\n\nNever promise a date we have not confirmed.";

    expect(make({ instructions: typed }).instructions).toBe(typed);
  });
});

describe("showing a person what good looks like", () => {
  const example = { when: "an angry customer", good: "Thank you for flagging this…" };

  it("holds the examples somebody wrote down", () => {
    expect(make({ examples: [example] }).examples).toEqual([example]);
  });

  it("takes one with no situation attached, which is still worth showing", () => {
    expect(make({ examples: [{ good: "Short. Specific. No promises." }] }).examples).toEqual([
      { when: null, good: "Short. Specific. No promises." },
    ]);
  });

  it("refuses an example with nothing in it, since it teaches nothing", () => {
    expect(isErr(createEmployee({ ...base, examples: [{ good: "  " }] }, ctx, deps))).toBe(true);
  });

  it("refuses more than a handful, because every one is paid for on every call", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ good: `example ${String(i)}` }));

    expect(isErr(createEmployee({ ...base, examples: many }, ctx, deps))).toBe(true);
  });

  it("refuses one longer than an example should be", () => {
    expect(
      isErr(createEmployee({ ...base, examples: [{ good: "x".repeat(4_001) }] }, ctx, deps)),
    ).toBe(true);
    expect(
      isErr(
        createEmployee({ ...base, examples: [{ when: "x".repeat(201), good: "ok" }] }, ctx, deps),
      ),
    ).toBe(true);
  });

  it("refuses a list that is not a list of examples", () => {
    expect(isErr(createEmployee({ ...base, examples: "a good one" }, ctx, deps))).toBe(true);
    expect(isErr(createEmployee({ ...base, examples: ["a good one"] }, ctx, deps))).toBe(true);
  });

  it("says which example was wrong, since a list of ten is hard to search", () => {
    const refused = createEmployee(
      { ...base, examples: [{ good: "fine" }, { good: "" }] },
      ctx,
      deps,
    );

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) expect(refused.error[0]?.path).toBe("examples[1].good");
  });
});

describe("changing how a person works", () => {
  it("writes new instructions over the old ones", () => {
    const changed = unwrap(
      updateEmployee(
        make({ instructions: "Old." }),
        { instructions: "New." },
        { supervisor: null },
      ),
    );

    expect(changed.instructions).toBe("New.");
  });

  it("takes them away again, which is how somebody is untaught", () => {
    const changed = unwrap(
      updateEmployee(make({ instructions: "Old." }), { instructions: null }, { supervisor: null }),
    );

    expect(changed.instructions).toBeNull();
  });

  it("leaves them alone when the change says nothing about them", () => {
    const changed = unwrap(
      updateEmployee(make({ instructions: "Keep me." }), { role: "Lead" }, { supervisor: null }),
    );

    expect(changed.instructions).toBe("Keep me.");
  });

  it("refuses a change core would have refused at hiring", () => {
    expect(
      isErr(updateEmployee(make(), { instructions: "x".repeat(20_001) }, { supervisor: null })),
    ).toBe(true);
  });

  it("replaces the examples rather than adding to them", () => {
    const changed = unwrap(
      updateEmployee(
        make({ examples: [{ good: "one" }] }),
        { examples: [{ good: "two" }] },
        { supervisor: null },
      ),
    );

    expect(changed.examples).toEqual([{ when: null, good: "two" }]);
  });
});
