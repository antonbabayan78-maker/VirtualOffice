import { describe, expect, it } from "vitest";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { DEFAULT_REVIEW_POLICY } from "./review-policy.js";
import {
  createDepartment,
  updateDepartment,
  DEFAULT_DEPARTMENT_SIZE,
  normalizeHexColor,
  type Department,
  type DepartmentId,
} from "./department.js";

const officeId = "office-1" as OfficeId;
const deps = { id: () => "dept-1" as DepartmentId, now: () => new Date("2026-09-22T00:00:00Z") };
const base = { officeId, name: "Engineering", color: "#3B82F6", position: { x: 100, y: 50 } };

describe("normalizeHexColor", () => {
  it("accepts 6-digit hex and lowercases it", () => {
    expect(unwrap(normalizeHexColor("#3B82F6"))).toBe("#3b82f6");
  });

  it("expands 3-digit shorthand", () => {
    expect(unwrap(normalizeHexColor("#FA0"))).toBe("#ffaa00");
  });

  it("rejects missing hash, wrong length, non-hex characters and non-strings", () => {
    for (const bad of ["3b82f6", "#3b82f", "#3b82f6ff", "#ggg", "blue", 42, null]) {
      expect(isErr(normalizeHexColor(bad)), String(bad)).toBe(true);
    }
  });
});

describe("updateDepartment", () => {
  const made = (name: string, id: string): Department =>
    unwrap(
      createDepartment({ ...base, name }, [], {
        id: () => id as DepartmentId,
        now: () => new Date("2026-09-01T00:00:00Z"),
      }),
    );

  it("changes what it was asked to change", () => {
    const after = unwrap(updateDepartment(made("Engineering", "d1"), { name: "Platform" }, []));
    expect(after.name).toBe("Platform");
  });

  it("leaves everything else as it was", () => {
    const before = made("Engineering", "d1");
    const after = unwrap(updateDepartment(before, { name: "Platform" }, []));
    expect({ ...after, name: before.name }).toEqual(before);
  });

  it("keeps its identity and when it was created", () => {
    const before = made("Engineering", "d1");
    const after = unwrap(updateDepartment(before, { color: "#123456" }, []));
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toEqual(before.createdAt);
    expect(after.officeId).toBe(before.officeId);
  });

  it("does not mind a department keeping its own name", () => {
    const eng = made("Engineering", "d1");
    expect(isOk(updateDepartment(eng, { color: "#123456" }, [eng]))).toBe(true);
    expect(isOk(updateDepartment(eng, { name: "Engineering" }, [eng]))).toBe(true);
  });

  it("refuses a name another department already has", () => {
    const eng = made("Engineering", "d1");
    const sales = made("Sales", "d2");
    const r = updateDepartment(eng, { name: "Sales" }, [eng, sales]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("name");
  });

  it("refuses a colour that is not one", () => {
    expect(isErr(updateDepartment(made("Engineering", "d1"), { color: "nope" }, []))).toBe(true);
  });

  it("takes a different review policy", () => {
    const after = unwrap(
      updateDepartment(
        made("Engineering", "d1"),
        { reviewPolicy: { kind: "quorum", required: 2 } },
        [],
      ),
    );
    expect(after.reviewPolicy).toEqual({ kind: "quorum", required: 2, maxIterations: 3 });
  });

  it("refuses a review policy the engine could not run", () => {
    const r = updateDepartment(made("Engineering", "d1"), { reviewPolicy: { kind: "quorum" } }, []);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.map((e) => e.path).join()).toMatch(/required/);
  });

  it("sets and clears an icon", () => {
    const withIcon = unwrap(updateDepartment(made("Engineering", "d1"), { icon: "wrench" }, []));
    expect(withIcon.icon).toBe("wrench");
    expect(unwrap(updateDepartment(withIcon, { icon: null }, [])).icon).toBeNull();
  });

  it("takes its own working hours, and gives them back", () => {
    const nights = unwrap(
      updateDepartment(
        made("Engineering", "d1"),
        {
          schedule: {
            kind: "windows",
            timezone: "UTC",
            windows: [{ days: ["mon"], start: "22:00", end: "06:00" }],
          },
        },
        [],
      ),
    );
    expect(nights.schedule).toMatchObject({ kind: "windows" });
    expect(unwrap(updateDepartment(nights, { schedule: { kind: "always" } }, [])).schedule).toEqual(
      {
        kind: "always",
      },
    );
  });

  it("reports every problem at once", () => {
    const r = updateDepartment(made("Engineering", "d1"), { name: "", color: "nope" }, []);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.length).toBeGreaterThan(1);
  });
});

describe("createDepartment", () => {
  it("creates a department with defaults for size, icon, config and review policy", () => {
    const r = createDepartment(base, [], deps);
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toEqual<Department>({
      id: "dept-1" as DepartmentId,
      officeId,
      name: "Engineering",
      color: "#3b82f6",
      icon: null,
      position: { x: 100, y: 50 },
      size: DEFAULT_DEPARTMENT_SIZE,
      config: {},
      reviewPolicy: DEFAULT_REVIEW_POLICY,
      priority: "normal",
      definitionOfDone: [],
      toolGrants: [],
      schedule: { kind: "always" },
      createdAt: new Date("2026-09-22T00:00:00Z"),
    });
  });

  it("accepts explicit icon, size, config and review policy", () => {
    const r = createDepartment(
      {
        ...base,
        icon: "🛠️",
        size: { width: 640, height: 400 },
        config: { autoAssign: true },
        reviewPolicy: { kind: "direct" },
      },
      [],
      deps,
    );
    const d = unwrap(r);
    expect(d.icon).toBe("🛠️");
    expect(d.size).toEqual({ width: 640, height: 400 });
    expect(d.config).toEqual({ autoAssign: true });
    expect(d.reviewPolicy).toEqual({ kind: "direct" });
  });

  it("trims the name and rejects empty or over-long names", () => {
    expect(unwrap(createDepartment({ ...base, name: "  Sales " }, [], deps)).name).toBe("Sales");
    for (const name of ["", "  ", "x".repeat(61)]) {
      const r = createDepartment({ ...base, name }, [], deps);
      expect(isErr(r), JSON.stringify(name)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("name");
    }
  });

  it("requires the name to be unique within the office, case-insensitively", () => {
    const existing = [{ name: "engineering" }, { name: "Sales" }];
    const dup = createDepartment({ ...base, name: "  ENGINEERING " }, existing, deps);
    expect(isErr(dup)).toBe(true);
    if (isErr(dup)) {
      expect(dup.error[0]?.path).toBe("name");
      expect(dup.error[0]?.message).toMatch(/already exists/);
    }
    expect(isOk(createDepartment({ ...base, name: "Marketing" }, existing, deps))).toBe(true);
  });

  it("rejects an invalid color under the color path", () => {
    const r = createDepartment({ ...base, color: "red" }, [], deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("color");
  });

  it("rejects non-finite positions", () => {
    for (const position of [
      { x: Number.NaN, y: 0 },
      { x: 0, y: Number.POSITIVE_INFINITY },
      { x: "1", y: 2 },
      null,
    ]) {
      const r = createDepartment({ ...base, position: position as never }, [], deps);
      expect(isErr(r), JSON.stringify(position)).toBe(true);
      if (isErr(r))
        expect(r.error.map((e) => e.path).some((p) => p.startsWith("position"))).toBe(true);
    }
  });

  it("rejects sizes below the minimum or non-numeric", () => {
    for (const size of [
      { width: 10, height: 300 },
      { width: 300, height: 10 },
      { width: "300", height: 300 },
    ]) {
      const r = createDepartment({ ...base, size: size as never }, [], deps);
      expect(isErr(r), JSON.stringify(size)).toBe(true);
      if (isErr(r)) expect(r.error.map((e) => e.path).some((p) => p.startsWith("size"))).toBe(true);
    }
  });

  it("rejects an over-long icon and a non-object config", () => {
    const icon = createDepartment({ ...base, icon: "x".repeat(33) }, [], deps);
    expect(isErr(icon)).toBe(true);
    if (isErr(icon)) expect(icon.error[0]?.path).toBe("icon");
    const config = createDepartment({ ...base, config: ["a"] as never }, [], deps);
    expect(isErr(config)).toBe(true);
    if (isErr(config)) expect(config.error[0]?.path).toBe("config");
  });

  it("propagates review policy errors under the reviewPolicy path", () => {
    const r = createDepartment({ ...base, reviewPolicy: { kind: "quorum" } }, [], deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("reviewPolicy.required");
  });

  it("works round the clock unless given its own hours", () => {
    expect(unwrap(createDepartment(base, [], deps)).schedule).toEqual({ kind: "always" });
    const nights = createDepartment(
      {
        ...base,
        schedule: {
          kind: "windows",
          timezone: "Asia/Nicosia",
          windows: [{ days: ["mon"], start: "22:00", end: "06:00" }],
        },
      },
      [],
      deps,
    );
    expect(unwrap(nights).schedule).toMatchObject({ kind: "windows", timezone: "Asia/Nicosia" });
  });

  it("rejects hours it cannot read, saying which field", () => {
    const r = createDepartment(
      { ...base, schedule: { kind: "windows", timezone: "Mars/Olympus" } },
      [],
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toMatch(/^schedule/);
  });

  it("collects errors from several fields at once", () => {
    const r = createDepartment(
      { ...base, name: "", color: "nope", position: { x: 1, y: Number.NaN } },
      [],
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const paths = r.error.map((e) => e.path);
      expect(paths).toContain("name");
      expect(paths).toContain("color");
      expect(paths).toContain("position.y");
    }
  });
});

describe("a department's standing priority", () => {
  it("is normal unless the department says otherwise", () => {
    expect(unwrap(createDepartment(base, [], deps)).priority).toBe("normal");
  });

  it("is taken from the department when it is given one", () => {
    expect(unwrap(createDepartment({ ...base, priority: "urgent" }, [], deps)).priority).toBe(
      "urgent",
    );
  });

  it("refuses a priority that is not one, rather than quietly working at normal", () => {
    const result = createDepartment({ ...base, priority: "asap" }, [], deps);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("priority");
  });

  it("can be raised later, which is how a department goes into crunch", () => {
    const department = unwrap(createDepartment(base, [], deps));
    expect(unwrap(updateDepartment(department, { priority: "urgent" }, [])).priority).toBe(
      "urgent",
    );
  });

  it("stays as it was when a change does not mention it", () => {
    const department = unwrap(createDepartment({ ...base, priority: "high" }, [], deps));
    expect(unwrap(updateDepartment(department, { name: "Platform" }, [])).priority).toBe("high");
  });

  it("refuses a bad priority on a change too", () => {
    const department = unwrap(createDepartment(base, [], deps));
    expect(isErr(updateDepartment(department, { priority: "asap" }, []))).toBe(true);
  });
});

describe("a department's standing definition of done", () => {
  it("is empty unless the department says otherwise", () => {
    expect(unwrap(createDepartment(base, [], deps)).definitionOfDone).toEqual([]);
  });

  it("holds what everything this department does has to achieve", () => {
    const standing = ["reviewed by somebody else", "has tests"];
    expect(
      unwrap(createDepartment({ ...base, definitionOfDone: standing }, [], deps)).definitionOfDone,
    ).toEqual(standing);
  });

  it("refuses an entry that is not text", () => {
    expect(isErr(createDepartment({ ...base, definitionOfDone: [7] as never }, [], deps))).toBe(
      true,
    );
  });

  it("refuses an empty entry", () => {
    expect(isErr(createDepartment({ ...base, definitionOfDone: ["  "] }, [], deps))).toBe(true);
  });

  it("can be changed later, which is how a department raises its standard", () => {
    const department = unwrap(createDepartment(base, [], deps));
    const raised = unwrap(updateDepartment(department, { definitionOfDone: ["has tests"] }, []));
    expect(raised.definitionOfDone).toEqual(["has tests"]);
  });

  it("stays as it was when a change does not mention it", () => {
    const department = unwrap(
      createDepartment({ ...base, definitionOfDone: ["has tests"] }, [], deps),
    );
    expect(unwrap(updateDepartment(department, { name: "Platform" }, [])).definitionOfDone).toEqual(
      ["has tests"],
    );
  });
});

describe("what a department may reach", () => {
  const grants = (toolGrants: unknown) =>
    createDepartment(
      { officeId, name: "Design", color: "#3366ff", position: { x: 0, y: 0 }, toolGrants } as never,
      [],
      deps,
    );

  it("reaches nothing until somebody says otherwise", () => {
    expect(unwrap(createDepartment(base, [], deps)).toolGrants).toEqual([]);
  });

  it("carries what the whole room may call, so a grant is not repeated per person", () => {
    const department = unwrap(grants([{ connectorId: "conn-web", tool: "fetch_url" }]));
    expect(department.toolGrants).toEqual([{ connectorId: "conn-web", tool: "fetch_url" }]);
  });

  it("takes a wildcard, for a connector a whole department lives in", () => {
    expect(unwrap(grants([{ connectorId: "conn-figma", tool: "*" }])).toolGrants).toEqual([
      { connectorId: "conn-figma", tool: "*" },
    ]);
  });

  it("refuses a grant that names no connector", () => {
    const refused = grants([{ connectorId: "", tool: "fetch_url" }]);
    if (!isErr(refused)) throw new Error("expected this grant to be refused");
    expect(refused.error[0]?.path).toBe("toolGrants[0].connectorId");
  });

  it("refuses a grant that names no tool", () => {
    const refused = grants([{ connectorId: "conn-web" }]);
    if (!isErr(refused)) throw new Error("expected this grant to be refused");
    expect(refused.error[0]?.path).toBe("toolGrants[0].tool");
  });

  it("refuses something that is not a grant at all", () => {
    expect(isErr(grants(["conn-web"]))).toBe(true);
  });

  it("can be changed without touching anything else about the room", () => {
    const department = unwrap(createDepartment(base, [], deps));
    const changed = unwrap(
      updateDepartment(department, { toolGrants: [{ connectorId: "conn-web", tool: "*" }] }, []),
    );
    expect(changed.toolGrants).toEqual([{ connectorId: "conn-web", tool: "*" }]);
    expect(changed.name).toBe(department.name);
  });
});
