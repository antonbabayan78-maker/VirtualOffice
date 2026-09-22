import { describe, expect, it } from "vitest";
import {
  bucketFor,
  bucketsBetween,
  bucketTableName,
  parseBucketTableName,
} from "./time-buckets.js";

describe("time buckets (partitioning fallback)", () => {
  it("assigns instants to UTC month buckets", () => {
    expect(bucketFor(new Date("2026-09-22T23:59:59Z"))).toBe("2026_09");
    expect(bucketFor(new Date("2026-10-01T00:00:00Z"))).toBe("2026_10");
    expect(bucketFor(new Date("2026-12-31T23:00:00-05:00"))).toBe("2027_01");
  });

  it("builds and parses table names", () => {
    expect(bucketTableName("events", "2026_09")).toBe("events_2026_09");
    expect(parseBucketTableName("events", "events_2026_09")).toBe("2026_09");
    expect(parseBucketTableName("events", "events_meta")).toBeNull();
    expect(parseBucketTableName("events", "tasks_2026_09")).toBeNull();
  });

  it("enumerates the buckets covering an inclusive-exclusive range, oldest first", () => {
    const from = new Date("2026-11-15T00:00:00Z");
    const to = new Date("2027-02-01T00:00:00Z"); // exclusive: Feb bucket not needed
    expect(bucketsBetween(from, to)).toEqual(["2026_11", "2026_12", "2027_01"]);
    expect(bucketsBetween(from, new Date("2027-02-01T00:00:01Z"))).toEqual([
      "2026_11",
      "2026_12",
      "2027_01",
      "2027_02",
    ]);
    expect(bucketsBetween(from, from)).toEqual([]);
    expect(bucketsBetween(to, from)).toEqual([]);
  });
});
