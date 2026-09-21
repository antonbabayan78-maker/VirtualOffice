import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok, prefixErrors, unwrap } from "./result.js";

describe("Result", () => {
  it("wraps success values", () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    expect(unwrap(r)).toBe(42);
  });

  it("wraps errors", () => {
    const r = err([{ path: "name", message: "required" }]);
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error[0]?.path).toBe("name");
  });

  it("unwrap describes string, object and mixed-array errors", () => {
    expect(() => unwrap(err("boom"))).toThrow(/boom/);
    expect(() => unwrap(err({ code: 7 }))).toThrow(/"code":7/);
    expect(() => unwrap(err([{ path: "a", message: "b" }, "raw"]))).toThrow(/a: b; "raw"/);
  });

  it("prefixErrors nests paths and uses the prefix alone for root errors", () => {
    expect(
      prefixErrors("schedule", [
        { path: "", message: "must be an object" },
        { path: "windows[0].start", message: "bad" },
      ]),
    ).toEqual([
      { path: "schedule", message: "must be an object" },
      { path: "schedule.windows[0].start", message: "bad" },
    ]);
  });

  it("unwrap throws a descriptive error on failure", () => {
    const r = err([{ path: "schedule.windows[0].start", message: "invalid time" }]);
    expect(() => unwrap(r)).toThrow(/schedule\.windows\[0\]\.start: invalid time/);
  });
});
