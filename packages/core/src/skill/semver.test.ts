import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "./semver.js";

describe("parseSemver", () => {
  it("parses major.minor.patch", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it("rejects prefixes, missing parts, leading zeros, pre-release and non-strings", () => {
    for (const bad of ["v1.2.3", "1.2", "1", "01.2.3", "1.2.3-beta", "1.2.3.4", "", 123, null]) {
      expect(parseSemver(bad), String(bad)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders numerically, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
  });

  it("throws on invalid input naming the offending version", () => {
    expect(() => compareSemver("1.0.0", "x")).toThrow(/"x"/);
    expect(() => compareSemver("y", "1.0.0")).toThrow(/"y"/);
  });
});
