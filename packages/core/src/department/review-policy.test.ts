import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { DEFAULT_REVIEW_POLICY, parseReviewPolicy } from "./review-policy.js";

describe("parseReviewPolicy", () => {
  it("defaults to manager review with three iterations", () => {
    expect(DEFAULT_REVIEW_POLICY).toEqual({ kind: "manager", maxIterations: 3 });
    expect(unwrap(parseReviewPolicy(undefined))).toEqual(DEFAULT_REVIEW_POLICY);
  });

  it("accepts direct (no review)", () => {
    expect(unwrap(parseReviewPolicy({ kind: "direct" }))).toEqual({ kind: "direct" });
  });

  it("accepts manager and peer with a positive integer iteration cap", () => {
    expect(unwrap(parseReviewPolicy({ kind: "manager", maxIterations: 2 }))).toEqual({
      kind: "manager",
      maxIterations: 2,
    });
    expect(unwrap(parseReviewPolicy({ kind: "peer", maxIterations: 5 }))).toEqual({
      kind: "peer",
      maxIterations: 5,
    });
  });

  it("fills in the default iteration cap when omitted", () => {
    expect(unwrap(parseReviewPolicy({ kind: "peer" }))).toEqual({ kind: "peer", maxIterations: 3 });
  });

  it("accepts quorum with required approvals and an iteration cap", () => {
    const r = parseReviewPolicy({ kind: "quorum", required: 2, maxIterations: 3 });
    expect(isOk(r)).toBe(true);
    expect(unwrap(r)).toEqual({ kind: "quorum", required: 2, maxIterations: 3 });
  });

  it("rejects unknown kinds and non-objects", () => {
    for (const input of [{ kind: "committee" }, "manager", null, 3]) {
      const r = parseReviewPolicy(input);
      expect(isErr(r), JSON.stringify(input)).toBe(true);
    }
  });

  it("rejects a non-positive or non-integer iteration cap", () => {
    for (const maxIterations of [0, -1, 1.5, "3"]) {
      const r = parseReviewPolicy({ kind: "manager", maxIterations });
      expect(isErr(r), String(maxIterations)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("maxIterations");
    }
  });

  it("rejects quorum without a positive integer required count", () => {
    for (const required of [undefined, 0, 2.5, "2"]) {
      const r = parseReviewPolicy({ kind: "quorum", required });
      expect(isErr(r), String(required)).toBe(true);
      if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("required");
    }
  });
});
