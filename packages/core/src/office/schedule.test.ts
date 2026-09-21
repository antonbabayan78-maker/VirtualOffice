import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { isOpen, parseSchedule, type Schedule } from "./schedule.js";

const utc = (iso: string): Date => new Date(iso);

describe("parseSchedule", () => {
  it("accepts the always-open schedule", () => {
    const r = parseSchedule({ kind: "always" });
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toEqual({ kind: "always" });
  });

  it("accepts working windows with a valid IANA timezone", () => {
    const r = parseSchedule({
      kind: "windows",
      timezone: "Europe/Nicosia",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" }],
    });
    expect(isOk(r)).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const r = parseSchedule({ kind: "sometimes" });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("kind");
  });

  it("rejects non-object input", () => {
    expect(isErr(parseSchedule(null))).toBe(true);
    expect(isErr(parseSchedule("always"))).toBe(true);
    expect(isErr(parseSchedule([]))).toBe(true);
  });

  it("rejects a window that is not an object and non-string times", () => {
    const notObject = parseSchedule({ kind: "windows", timezone: "UTC", windows: ["09-18"] });
    expect(isErr(notObject)).toBe(true);
    if (isErr(notObject)) expect(notObject.error.map((e) => e.path)).toContain("windows[0]");
    const numeric = parseSchedule({
      kind: "windows",
      timezone: "UTC",
      windows: [{ days: ["mon"], start: 9, end: 18 }],
    });
    expect(isErr(numeric)).toBe(true);
    if (isErr(numeric)) {
      const paths = numeric.error.map((e) => e.path);
      expect(paths).toContain("windows[0].start");
      expect(paths).toContain("windows[0].end");
    }
  });

  it("rejects an invalid timezone", () => {
    const r = parseSchedule({
      kind: "windows",
      timezone: "Mars/Olympus",
      windows: [{ days: ["mon"], start: "09:00", end: "18:00" }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("timezone");
  });

  it("rejects an empty window list", () => {
    const r = parseSchedule({ kind: "windows", timezone: "UTC", windows: [] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("windows");
  });

  it("rejects malformed times, out-of-range times and equal start/end", () => {
    const cases = [
      { start: "9:00", end: "18:00", path: "windows[0].start" },
      { start: "09:00", end: "24:00", path: "windows[0].end" },
      { start: "09:60", end: "18:00", path: "windows[0].start" },
      { start: "09:00", end: "09:00", path: "windows[0].end" },
    ];
    for (const c of cases) {
      const r = parseSchedule({
        kind: "windows",
        timezone: "UTC",
        windows: [{ days: ["mon"], start: c.start, end: c.end }],
      });
      expect(isErr(r), `${c.start}-${c.end} should be rejected`).toBe(true);
      if (isErr(r)) expect(r.error.map((e) => e.path)).toContain(c.path);
    }
  });

  it("rejects empty, unknown and duplicate days", () => {
    const base = { kind: "windows", timezone: "UTC" };
    const empty = parseSchedule({ ...base, windows: [{ days: [], start: "09:00", end: "18:00" }] });
    const unknown = parseSchedule({
      ...base,
      windows: [{ days: ["monday"], start: "09:00", end: "18:00" }],
    });
    const dup = parseSchedule({
      ...base,
      windows: [{ days: ["mon", "mon"], start: "09:00", end: "18:00" }],
    });
    for (const r of [empty, unknown, dup]) {
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("windows[0].days");
    }
  });

  it("collects every error instead of stopping at the first", () => {
    const r = parseSchedule({
      kind: "windows",
      timezone: "Nowhere/City",
      windows: [{ days: [], start: "x", end: "y" }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.length).toBeGreaterThanOrEqual(4);
  });
});

describe("isOpen", () => {
  const officeHours: Schedule = {
    kind: "windows",
    timezone: "Europe/Nicosia",
    windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" }],
  };

  it("24/7 schedule is always open", () => {
    const always: Schedule = { kind: "always" };
    expect(isOpen(always, utc("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isOpen(always, utc("2026-07-04T23:59:59Z"))).toBe(true);
  });

  it("is open inside the window in the office timezone", () => {
    // Monday 2026-09-21 10:00 in Nicosia (UTC+3 in September) = 07:00Z
    expect(isOpen(officeHours, utc("2026-09-21T07:00:00Z"))).toBe(true);
  });

  it("is closed before start and at or after end (end is exclusive)", () => {
    // 08:59 local = 05:59Z ; 18:00 local = 15:00Z
    expect(isOpen(officeHours, utc("2026-09-21T05:59:00Z"))).toBe(false);
    expect(isOpen(officeHours, utc("2026-09-21T06:00:00Z"))).toBe(true); // 09:00 local, start inclusive
    expect(isOpen(officeHours, utc("2026-09-21T15:00:00Z"))).toBe(false);
    expect(isOpen(officeHours, utc("2026-09-21T14:59:59Z"))).toBe(true);
  });

  it("is closed on days outside the window", () => {
    // Saturday 2026-09-26 10:00 local = 07:00Z
    expect(isOpen(officeHours, utc("2026-09-26T07:00:00Z"))).toBe(false);
  });

  it("evaluates the same instant differently in different timezones", () => {
    const tokyo: Schedule = { ...officeHours, timezone: "Asia/Tokyo" };
    const la: Schedule = { ...officeHours, timezone: "America/Los_Angeles" };
    // 2026-09-21T01:00Z = Mon 10:00 Tokyo (open), Sun 18:00 LA (closed)
    const at = utc("2026-09-21T01:00:00Z");
    expect(isOpen(tokyo, at)).toBe(true);
    expect(isOpen(la, at)).toBe(false);
  });

  it("follows DST transitions", () => {
    const berlin: Schedule = {
      kind: "windows",
      timezone: "Europe/Berlin",
      windows: [
        { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "09:00", end: "10:00" },
      ],
    };
    // Winter (CET, UTC+1): 09:30 local = 08:30Z
    expect(isOpen(berlin, utc("2026-01-15T08:30:00Z"))).toBe(true);
    expect(isOpen(berlin, utc("2026-01-15T07:30:00Z"))).toBe(false);
    // Summer (CEST, UTC+2): 09:30 local = 07:30Z
    expect(isOpen(berlin, utc("2026-07-15T07:30:00Z"))).toBe(true);
    expect(isOpen(berlin, utc("2026-07-15T08:30:00Z"))).toBe(false);
  });

  it("supports windows that cross midnight (start day owns the window)", () => {
    const nightShift: Schedule = {
      kind: "windows",
      timezone: "UTC",
      windows: [{ days: ["fri"], start: "22:00", end: "06:00" }],
    };
    expect(isOpen(nightShift, utc("2026-09-25T23:00:00Z"))).toBe(true); // Fri 23:00
    expect(isOpen(nightShift, utc("2026-09-26T05:59:00Z"))).toBe(true); // Sat 05:59, spilled from Fri
    expect(isOpen(nightShift, utc("2026-09-26T06:00:00Z"))).toBe(false); // Sat 06:00
    expect(isOpen(nightShift, utc("2026-09-26T23:00:00Z"))).toBe(false); // Sat 23:00 not a start day
    expect(isOpen(nightShift, utc("2026-09-25T21:59:00Z"))).toBe(false); // Fri before start
  });

  it("is open if any of several windows matches", () => {
    const split: Schedule = {
      kind: "windows",
      timezone: "UTC",
      windows: [
        { days: ["mon"], start: "09:00", end: "12:00" },
        { days: ["mon"], start: "13:00", end: "17:00" },
      ],
    };
    expect(isOpen(split, utc("2026-09-21T10:00:00Z"))).toBe(true);
    expect(isOpen(split, utc("2026-09-21T12:30:00Z"))).toBe(false);
    expect(isOpen(split, utc("2026-09-21T14:00:00Z"))).toBe(true);
  });
});
