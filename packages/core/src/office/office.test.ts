import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { createOffice, type OfficeId } from "./office.js";

const deps = {
  id: () => "office-1" as OfficeId,
  now: () => new Date("2026-09-22T00:00:00Z"),
};

describe("createOffice", () => {
  it("creates an always-open office with sensible defaults", () => {
    const r = createOffice({ name: "Acme Studio" }, deps);
    expect(isOk(r)).toBe(true);
    const office = unwrap(r);
    expect(office).toEqual({
      id: "office-1",
      name: "Acme Studio",
      schedule: { kind: "always" },
      configVersion: 1,
      createdAt: new Date("2026-09-22T00:00:00Z"),
    });
  });

  it("accepts an explicit working-windows schedule", () => {
    const r = createOffice(
      {
        name: "Nicosia Office",
        schedule: {
          kind: "windows",
          timezone: "Europe/Nicosia",
          windows: [{ days: ["mon", "tue"], start: "09:00", end: "17:00" }],
        },
      },
      deps,
    );
    expect(isOk(r)).toBe(true);
    expect(unwrap(r).schedule.kind).toBe("windows");
  });

  it("trims the name", () => {
    expect(unwrap(createOffice({ name: "  Acme  " }, deps)).name).toBe("Acme");
  });

  it("rejects an empty or whitespace-only name", () => {
    for (const name of ["", "   "]) {
      const r = createOffice({ name }, deps);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("name");
    }
  });

  it("rejects a non-string name", () => {
    const r = createOffice({ name: 42 as unknown as string }, deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/string/);
  });

  it("rejects a name longer than 100 characters", () => {
    const r = createOffice({ name: "x".repeat(101) }, deps);
    expect(isErr(r)).toBe(true);
  });

  it("propagates schedule validation errors under the schedule path", () => {
    const r = createOffice(
      { name: "Acme", schedule: { kind: "windows", timezone: "UTC", windows: [] } },
      deps,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("schedule.windows");
  });

  it("reports name and schedule errors together", () => {
    const r = createOffice({ name: "", schedule: { kind: "nope" } }, deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const paths = r.error.map((e) => e.path);
      expect(paths).toContain("name");
      expect(paths).toContain("schedule.kind");
    }
  });
});
