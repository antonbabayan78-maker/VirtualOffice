import { describe, expect, it } from "vitest";
import { acceptanceCriteriaFor } from "./acceptance.js";

describe("which list this work is judged against", () => {
  const standing = ["somebody read it back"];

  it("is the department's standing one when the work states none", () => {
    expect(acceptanceCriteriaFor([], standing)).toEqual(standing);
  });

  it("is the work's own when it states any, rather than both", () => {
    // Stating one states the whole list: a reviewer answering two of them would
    // have to be told which took precedence, and nothing in the office says.
    expect(acceptanceCriteriaFor(["the date is in it"], standing)).toEqual(["the date is in it"]);
  });

  it("is nothing when neither says anything, which is most offices", () => {
    expect(acceptanceCriteriaFor([], [])).toEqual([]);
  });
});
