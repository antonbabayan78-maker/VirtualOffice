import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@vo/core";
import { CRON_FIELDS, nextCronRun, parseCron } from "./cron.js";

const at = (iso: string): Date => new Date(iso);
const next = (expr: string, from: string, timezone = "UTC"): string =>
  nextCronRun(unwrap(parseCron(expr)), at(from), timezone).toISOString();

describe("parseCron", () => {
  it("names the five fields it accepts", () => {
    expect([...CRON_FIELDS]).toEqual(["minute", "hour", "dayOfMonth", "month", "dayOfWeek"]);
  });

  it("accepts stars, numbers, lists, ranges and steps", () => {
    for (const expr of [
      "* * * * *",
      "0 9 * * 1",
      "0,30 9-17 * * 1-5",
      "*/15 * * * *",
      "0 0 1 1 *",
      "0 8-18/2 * * *",
    ]) {
      expect(isErr(parseCron(expr)), expr).toBe(false);
    }
  });

  it("accepts weekday and month names, in any case", () => {
    expect(unwrap(parseCron("0 9 * * mon")).dayOfWeek).toEqual([1]);
    expect(unwrap(parseCron("0 9 * JAN *")).month).toEqual([1]);
    expect(unwrap(parseCron("0 9 * * Sat,Sun")).dayOfWeek).toEqual([0, 6]);
  });

  it("treats sunday as both 0 and 7", () => {
    expect(unwrap(parseCron("0 9 * * 7")).dayOfWeek).toEqual([0]);
    expect(unwrap(parseCron("0 9 * * 0")).dayOfWeek).toEqual([0]);
  });

  it("expands a field to every value it matches, sorted and without repeats", () => {
    expect(unwrap(parseCron("*/20 * * * *")).minute).toEqual([0, 20, 40]);
    expect(unwrap(parseCron("0,0,5 * * * *")).minute).toEqual([0, 5]);
    expect(unwrap(parseCron("0 9 * * 1-3")).dayOfWeek).toEqual([1, 2, 3]);
  });

  it("rejects the wrong number of fields", () => {
    for (const expr of ["", "* * * *", "* * * * * *", "   "]) {
      const r = parseCron(expr);
      expect(isErr(r), JSON.stringify(expr)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.message).toMatch(/five fields/);
    }
  });

  it("rejects values outside a field's range, naming the field", () => {
    for (const [expr, field] of [
      ["60 * * * *", "minute"],
      ["* 24 * * *", "hour"],
      ["* * 32 * *", "dayOfMonth"],
      ["* * * 13 *", "month"],
      ["* * * * 8", "dayOfWeek"],
      ["* * 0 * *", "dayOfMonth"],
    ] as const) {
      const r = parseCron(expr);
      expect(isErr(r), expr).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe(field);
    }
  });

  it("rejects syntax it does not implement rather than guessing", () => {
    for (const expr of [
      "0 9 L * *",
      "0 9 * * 1#2",
      "0 9 ? * *",
      "0 9 * * mon~fri",
      "*/0 * * * *",
    ]) {
      expect(isErr(parseCron(expr)), expr).toBe(true);
    }
  });
});

describe("nextCronRun", () => {
  it("finds the next minute, never the one it was given", () => {
    expect(next("* * * * *", "2026-09-27T09:00:00.000Z")).toBe("2026-09-27T09:01:00.000Z");
    expect(next("* * * * *", "2026-09-27T09:00:30.000Z")).toBe("2026-09-27T09:01:00.000Z");
  });

  it("finds the next matching hour and minute", () => {
    expect(next("30 14 * * *", "2026-09-27T09:00:00.000Z")).toBe("2026-09-27T14:30:00.000Z");
    expect(next("30 14 * * *", "2026-09-27T15:00:00.000Z")).toBe("2026-09-28T14:30:00.000Z");
  });

  it("walks forward to a matching weekday", () => {
    // 2026-09-27 is a Sunday; the next Monday 09:00 is the 28th.
    expect(next("0 9 * * mon", "2026-09-27T12:00:00.000Z")).toBe("2026-09-28T09:00:00.000Z");
  });

  it("walks forward months and over a leap day", () => {
    expect(next("0 0 1 1 *", "2026-06-01T00:00:00.000Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("0 12 29 2 *", "2027-03-01T00:00:00.000Z")).toBe("2028-02-29T12:00:00.000Z");
  });

  it("matches a day when either day-of-month or day-of-week is a star", () => {
    // Both restricted: cron's historic rule is that either may match.
    expect(next("0 9 13 * 5", "2026-11-01T00:00:00.000Z")).toBe("2026-11-06T09:00:00.000Z");
  });

  it("reads the expression in the office's timezone, not the server's", () => {
    // 09:00 in Nicosia during summer (UTC+3) is 06:00 UTC.
    expect(next("0 9 * * *", "2026-09-27T00:00:00.000Z", "Asia/Nicosia")).toBe(
      "2026-09-27T06:00:00.000Z",
    );
    // And in winter (UTC+2) the same expression is 07:00 UTC.
    expect(next("0 9 * * *", "2026-12-01T00:00:00.000Z", "Asia/Nicosia")).toBe(
      "2026-12-01T07:00:00.000Z",
    );
  });

  it("keeps a daily job at the same local time across a spring clock change", () => {
    // Europe/London moves to BST on 2027-03-28.
    expect(next("0 9 * * *", "2027-03-27T12:00:00.000Z", "Europe/London")).toBe(
      "2027-03-28T08:00:00.000Z",
    );
  });

  it("still fires when the local time it asks for is skipped by a clock change", () => {
    // 01:30 does not exist in London on 2027-03-28; the job must not be lost.
    const fired = next("30 1 28 3 *", "2027-03-01T00:00:00.000Z", "Europe/London");
    expect(new Date(fired).getTime()).toBeGreaterThan(at("2027-03-28T00:00:00.000Z").getTime());
    expect(new Date(fired).getTime()).toBeLessThan(at("2027-03-28T03:00:00.000Z").getTime());
  });

  it("gives up rather than looping forever on a date that never comes", () => {
    // 30 February.
    expect(() => next("0 0 30 2 *", "2026-01-01T00:00:00.000Z")).toThrow(/no occurrence/);
  });
});
