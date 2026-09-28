import { describe, expect, it } from "vitest";
import { isErr } from "@vo/core";
import { loadSampleOffice } from "./sample-office.js";

describe("the office the canvas opens with", () => {
  it("is a real office file, accepted by the real importer", () => {
    const office = loadSampleOffice();
    expect(isErr(office)).toBe(false);
  });

  it("has departments with people in them", () => {
    const office = loadSampleOffice();
    if (isErr(office)) throw new Error("the sample office does not parse");
    expect(office.value.departments.length).toBeGreaterThan(1);
    for (const department of office.value.departments) {
      const people = office.value.employees.filter((e) => e.departmentId === department.id);
      expect(people.length, department.name).toBeGreaterThan(0);
    }
  });
});
