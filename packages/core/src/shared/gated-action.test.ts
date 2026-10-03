import { describe, expect, it } from "vitest";
import { GATED_ACTIONS, isGatedAction } from "./gated-action.js";

describe("gated actions", () => {
  it("covers the consequential categories a human may want to sign off", () => {
    expect([...GATED_ACTIONS]).toEqual(["spend", "external_send", "deploy", "delete", "as_person"]);
  });

  it("recognises only the known categories", () => {
    for (const action of GATED_ACTIONS) expect(isGatedAction(action)).toBe(true);
    for (const other of ["", "Deploy", "launch_rocket", 7, null, undefined]) {
      expect(isGatedAction(other), JSON.stringify(other)).toBe(false);
    }
  });

  it("includes acting in a real person's name, which is a category of its own", () => {
    // Not a kind of send: an employee standing in for somebody can reach an
    // outside system in their name without sending anything, and the person
    // whose name it is should still be the one who says yes.
    expect(isGatedAction("as_person")).toBe(true);
  });
});
