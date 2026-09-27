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

  it("accepts a pipeline of ordered stages, filling in stage defaults", () => {
    const r = parseReviewPolicy({
      kind: "pipeline",
      maxIterations: 2,
      stages: [
        { name: "Draft", workerId: "emp-ada", reviewerIds: ["emp-boss"] },
        { name: "QA", workerId: "emp-qa", reviewerIds: ["emp-lead", "emp-arch"], required: 2 },
        { name: "Legal", reviewerIds: [] },
      ],
    });
    expect(unwrap(r)).toEqual({
      kind: "pipeline",
      maxIterations: 2,
      stages: [
        { name: "Draft", workerId: "emp-ada", reviewerIds: ["emp-boss"], required: 1 },
        { name: "QA", workerId: "emp-qa", reviewerIds: ["emp-lead", "emp-arch"], required: 2 },
        { name: "Legal", workerId: null, reviewerIds: [], required: 1 },
      ],
    });
  });

  it("rejects a pipeline without stages", () => {
    for (const stages of [undefined, [], "Draft", {}]) {
      const r = parseReviewPolicy({ kind: "pipeline", stages });
      expect(isErr(r), JSON.stringify(stages)).toBe(true);
      if (isErr(r)) expect(r.error.map((e) => e.path)).toContain("stages");
    }
  });

  it("rejects a blank or duplicated stage name", () => {
    const blank = parseReviewPolicy({ kind: "pipeline", stages: [{ name: "  " }] });
    expect(isErr(blank)).toBe(true);
    if (isErr(blank)) expect(blank.error[0]?.path).toBe("stages[0].name");

    const dup = parseReviewPolicy({
      kind: "pipeline",
      stages: [{ name: "QA" }, { name: "QA" }],
    });
    expect(isErr(dup)).toBe(true);
    if (isErr(dup)) expect(dup.error[0]?.path).toBe("stages[1].name");
  });

  it("rejects a stage asking for more approvals than it has reviewers", () => {
    const r = parseReviewPolicy({
      kind: "pipeline",
      stages: [{ name: "QA", reviewerIds: ["emp-lead"], required: 2 }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("stages[0].required");
  });

  it("rejects more than one approval from a stage that names no reviewers", () => {
    // With no named reviewers the supervisor (or owner) signs off alone.
    const r = parseReviewPolicy({
      kind: "pipeline",
      stages: [{ name: "Legal", reviewerIds: [], required: 2 }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("stages[0].required");
  });

  it("rejects a stage whose worker reviews their own work, or repeats a reviewer", () => {
    const own = parseReviewPolicy({
      kind: "pipeline",
      stages: [{ name: "QA", workerId: "emp-qa", reviewerIds: ["emp-qa"] }],
    });
    expect(isErr(own)).toBe(true);
    if (isErr(own)) expect(own.error[0]?.path).toBe("stages[0].reviewerIds");

    const twice = parseReviewPolicy({
      kind: "pipeline",
      stages: [{ name: "QA", reviewerIds: ["emp-lead", "emp-lead"] }],
    });
    expect(isErr(twice)).toBe(true);
    if (isErr(twice)) expect(twice.error[0]?.path).toBe("stages[0].reviewerIds");
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
