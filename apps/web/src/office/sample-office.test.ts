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

  it("has somebody who has been told how to work, so the field is not a mystery", () => {
    // The first office anybody opens is where a feature is discovered. A panel
    // of empty fields teaches nobody what belongs in them.
    const office = loadSampleOffice();
    if (isErr(office)) throw new Error("the sample office does not parse");

    const taught = office.value.employees.filter((one) => one.instructions !== null);
    expect(taught.length).toBeGreaterThan(0);
    expect(office.value.employees.some((one) => one.examples.length > 0)).toBe(true);
  });
});
