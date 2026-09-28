import { describe, expect, it } from "vitest";
import { acceptanceCriteriaFor, unmetCriteria } from "./acceptance.js";

describe("what this work has to achieve", () => {
  const standing = ["reviewed by somebody else", "has tests"];

  it("is the department's standing list when the task asks for nothing more", () => {
    expect(acceptanceCriteriaFor([], standing)).toEqual(standing);
  });

  it("is the task's own when it has one, since the work needed something particular", () => {
    expect(acceptanceCriteriaFor(["migrates the old rows"], standing)).toEqual([
      "migrates the old rows",
    ]);
  });

  it("is nothing at all when neither says anything, which is most offices", () => {
    expect(acceptanceCriteriaFor([], [])).toEqual([]);
  });
});

describe("answering the list", () => {
  const criteria = ["handles malformed input", "has tests for the error path"];

  it("finds nothing outstanding when every criterion was met", () => {
    expect(unmetCriteria(criteria, criteria)).toEqual([]);
  });

  it("names what was left out", () => {
    expect(unmetCriteria(criteria, ["handles malformed input"])).toEqual([
      "has tests for the error path",
    ]);
  });

  it("treats silence as unmet, since saying nothing is not saying yes", () => {
    expect(unmetCriteria(criteria, [])).toEqual(criteria);
  });

  it("has nothing outstanding when nothing was asked, whatever was claimed", () => {
    // An office that has defined no criteria is not made stricter by this.
    expect(unmetCriteria([], [])).toEqual([]);
    expect(unmetCriteria([], ["something nobody asked for"])).toEqual([]);
  });

  it("ignores a claim about something that was never asked for", () => {
    expect(unmetCriteria(criteria, [...criteria, "invented a criterion"])).toEqual([]);
  });

  it("does not let a near miss count, since a reviewer has to mean the same thing", () => {
    expect(unmetCriteria(criteria, ["handles malformed inputs"])).toContain(
      "handles malformed input",
    );
  });

  it("ignores surrounding space, which a model will add and nobody means", () => {
    expect(unmetCriteria(criteria, ["  handles malformed input  ", criteria[1] ?? ""])).toEqual([]);
  });
});
