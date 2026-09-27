import { describe, expect, it } from "vitest";
import { GATED_ACTIONS, isGatedAction } from "./gated-action.js";

describe("gated actions", () => {
  it("covers the consequential categories a human may want to sign off", () => {
    expect([...GATED_ACTIONS]).toEqual(["spend", "external_send", "deploy", "delete"]);
  });

  it("recognises only the known categories", () => {
    for (const action of GATED_ACTIONS) expect(isGatedAction(action)).toBe(true);
    for (const other of ["", "Deploy", "launch_rocket", 7, null, undefined]) {
      expect(isGatedAction(other), JSON.stringify(other)).toBe(false);
    }
  });
});
