import { describe, expect, it } from "vitest";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { DEFAULT_REVIEW_POLICY } from "./review-policy.js";
import {
  createDepartment,
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
