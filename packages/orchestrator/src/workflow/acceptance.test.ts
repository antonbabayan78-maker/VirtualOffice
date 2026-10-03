import { describe, expect, it } from "vitest";
import { acceptanceCriteriaFor, unmetCriteria } from "./acceptance.js";

describe("what this work has to achieve", () => {
  // The rule itself lives in core now, with its own tests beside it: a board in
  // a browser has to apply the same one, and a browser cannot import this
  // package. What is checked here is that the name still answers through this
  // module, because every caller in the office imports it from here.
  it("is still answered through the module that reasons about acceptance", () => {
    const standing = ["reviewed by somebody else", "has tests"];

    expect(acceptanceCriteriaFor([], standing)).toEqual(standing);
    expect(acceptanceCriteriaFor(["migrates the old rows"], standing)).toEqual([
      "migrates the old rows",
    ]);
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
