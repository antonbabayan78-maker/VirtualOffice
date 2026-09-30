import { describe, expect, it } from "vitest";
import type { Schedule } from "./schedule.js";
import { RUN_STATES, isRunState, setRunState, whyShut, type RunState } from "./run-state.js";

const always: Schedule = { kind: "always" };
/** Weekday mornings, UTC — shut at any weekend or afternoon instant below. */
const mornings: Schedule = {
  kind: "windows",
  timezone: "UTC",
  windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "12:00" }],
};

const monday10 = new Date("2026-09-28T10:00:00Z");
const monday20 = new Date("2026-09-28T20:00:00Z");

const thing = (runState: RunState, schedule: Schedule = always) => ({ runState, schedule });

describe("the two positions a switch has", () => {
  it("names them", () => {
    expect(RUN_STATES).toEqual(["running", "paused"]);
  });

  it("recognises one, and refuses anything else", () => {
    expect(isRunState("paused")).toBe(true);
    expect(isRunState("stopped")).toBe(false);
    expect(isRunState(undefined)).toBe(false);
  });
});

describe("setting a run state", () => {
  it("pauses something that was running", () => {
    expect(setRunState(thing("running"), "paused").runState).toBe("paused");
  });

  it("takes something that is already paused without complaining", () => {
    // Unlike transitionEmployee, which refuses a no-op. A switch has two
    // positions and no final one, and two people pressing Pause must not make
    // the second of them an error.
    expect(setRunState(thing("paused"), "paused").runState).toBe("paused");
  });

  it("leaves everything else about it alone", () => {
    const before = { ...thing("running", mornings), name: "Design", headcount: 4 };
    const after = setRunState(before, "paused");

    expect(after).toEqual({ ...before, runState: "paused" });
  });

  it("does not change the thing it was given", () => {
    const before = thing("running");
    setRunState(before, "paused");
    expect(before.runState).toBe("running");
  });
});

describe("why something is not working", () => {
  it("says nothing is wrong when it is running and open", () => {
    expect(whyShut(thing("running"), monday10)).toBeNull();
  });

  it("says paused when somebody stopped it", () => {
    expect(whyShut(thing("paused"), monday10)).toBe("paused");
  });

  it("says closed when the hours are against it", () => {
    expect(whyShut(thing("running", mornings), monday20)).toBe("closed");
  });

  it("says paused rather than closed when it is both", () => {
    // The two are not the same fact and only one of them ends by itself:
    // waiting until Monday will not restart something a person stopped.
    expect(whyShut(thing("paused", mornings), monday20)).toBe("paused");
  });

  it("is paused whatever the hours say, even round-the-clock ones", () => {
    expect(whyShut(thing("paused", always), monday10)).toBe("paused");
  });
});
