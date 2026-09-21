import { describe, expect, it } from "vitest";
import { compareValues, decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor encoding", () => {
  it("round-trips strings, numbers and Dates", () => {
    expect(decodeCursor(encodeCursor({ v: "Task 9", id: "t9" }))).toEqual({
      v: "Task 9",
      id: "t9",
    });
    expect(decodeCursor(encodeCursor({ v: 42, id: "x" }))).toEqual({ v: 42, id: "x" });
    const d = new Date("2026-09-22T00:00:00Z");
    const back = decodeCursor(encodeCursor({ v: d, id: "x" }));
    expect(back.v).toBeInstanceOf(Date);
    expect(back.v).toEqual(d);
  });

  it("rejects garbage, non-object JSON and objects missing fields", () => {
    for (const bad of [
      "not-base64-json",
      Buffer.from("42").toString("base64url"),
      Buffer.from('{"v":1}').toString("base64url"),
    ]) {
      expect(() => decodeCursor(bad), bad).toThrow(/invalid cursor/);
    }
  });
});

describe("compareValues", () => {
  it("orders null and undefined first, then by type-appropriate comparison", () => {
    expect(compareValues(null, "a")).toBeLessThan(0);
    expect(compareValues("a", undefined)).toBeGreaterThan(0);
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(new Date(1), new Date(2))).toBeLessThan(0);
    expect(compareValues("Task 10", "Task 9")).toBeLessThan(0);
    expect(compareValues("b", "a")).toBeGreaterThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
    expect(compareValues(10n, 9n)).toBeLessThan(0);
    expect(compareValues(new Date(0), "1970-01-01T00:00:00.000Z")).toBe(0);
    expect(compareValues({ a: 1 }, { a: 1 })).toBe(0);
    expect(compareValues(Symbol("s"), "")).toBe(0);
  });
});
