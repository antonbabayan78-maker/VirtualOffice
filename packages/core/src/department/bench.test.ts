import { describe, expect, it } from "vitest";
import type { EmployeeId, EmployeeStatus } from "../employee/employee.js";
import { isErr, unwrap } from "../shared/result.js";
import {
  BENCH_STRATEGIES,
  nextFromBench,
  placeOnBench,
  validateBenchMembers,
  validateBenchShape,
  type Bench,
  type BenchId,
  type BenchMember,
  type BenchPlacement,
} from "./bench.js";

const ada = "emp-ada" as EmployeeId;
const bob = "emp-bob" as EmployeeId;
const cleo = "emp-cleo" as EmployeeId;

const bench = (memberIds: readonly EmployeeId[], overrides: Partial<Bench> = {}): Bench => ({
  id: "bench-1" as BenchId,
  name: "Drafting",
  memberIds,
  strategy: "round_robin",
  judgeId: null,
  ...overrides,
});

const member = (id: EmployeeId, status: EmployeeStatus = "active"): BenchMember => ({ id, status });

let placed = 0;
/** A task this bench put somewhere, newest last unless `at` says otherwise. */
const placement = (assigneeId: EmployeeId | null, at = ++placed): BenchPlacement => ({
  id: `task-${String(at)}`,
  assigneeId,
  benchId: "bench-1" as BenchId,
  createdAt: new Date(2026, 8, 30, 9, 0, at),
});

describe("what a bench can be set to do", () => {
  it("names its strategies", () => {
    expect(BENCH_STRATEGIES).toEqual(["round_robin", "shootout"]);
  });
});

describe("what a bench does with a piece of work", () => {
  const members = [member(ada), member(bob), member(cleo)];

  it("hands a round robin bench's work to one person", () => {
    expect(placeOnBench(bench([ada, bob]), members, [])).toEqual({ kind: "one", employeeId: ada });
  });

  it("takes its turn from what the bench has already placed", () => {
    expect(placeOnBench(bench([ada, bob]), members, [placement(ada)])).toEqual({
      kind: "one",
      employeeId: bob,
    });
  });

  it("hands a shootout's work to everybody on it, so the input is identical", () => {
    // The whole point: one job, every member, one answer each. A shootout that
    // picked one person would be round robin with a different name.
    expect(placeOnBench(bench([ada, bob], { strategy: "shootout" }), members, [])).toEqual({
      kind: "every",
      employeeIds: [ada, bob],
    });
  });

  it("keeps the bench's own order, so the entries read the way the bench is written", () => {
    const written = bench([cleo, ada, bob], { strategy: "shootout" });
    expect(placeOnBench(written, members, [])).toEqual({
      kind: "every",
      employeeIds: [cleo, ada, bob],
    });
  });

  it("asks a shootout again from scratch, whatever it placed before", () => {
    // Nothing rotates: the same contest tomorrow goes to the same people.
    const shootout = bench([ada, bob], { strategy: "shootout" });
    expect(placeOnBench(shootout, members, [placement(ada), placement(bob)])).toEqual({
      kind: "every",
      employeeIds: [ada, bob],
    });
  });

  it("leaves somebody who cannot work out of a shootout rather than waiting", () => {
    const shootout = bench([ada, bob], { strategy: "shootout" });
    expect(placeOnBench(shootout, [member(ada), member(bob, "paused")], [])).toEqual({
      kind: "every",
      employeeIds: [ada],
    });
  });

  it("runs a shootout of one rather than refusing it", () => {
    // One member left working is a contest of one: thin, but it is the work
    // getting done. Refusing it would stop the office because somebody is away.
    const shootout = bench([ada], { strategy: "shootout" });
    expect(placeOnBench(shootout, [member(ada)], [])).toEqual({
      kind: "every",
      employeeIds: [ada],
    });
  });

  it("places nothing when nobody on a shootout can work", () => {
    const shootout = bench([ada, bob], { strategy: "shootout" });
    expect(placeOnBench(shootout, [member(ada, "paused"), member(bob, "paused")], [])).toEqual({
      kind: "nobody",
    });
  });

  it("places nothing when a round robin bench has nobody on it", () => {
    expect(placeOnBench(bench([]), members, [])).toEqual({ kind: "nobody" });
  });
});

describe("whose turn it is", () => {
  it("gives the first piece of work to the first member", () => {
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [])).toBe(ada);
  });

  it("gives the next one to the next member", () => {
    const turn = nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [placement(ada)]);
    expect(turn).toBe(bob);
  });

  it("comes back round to the start", () => {
    const history = [placement(ada), placement(bob)];
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], history)).toBe(ada);
  });

  it("goes round a three-person bench in order", () => {
    const members = [member(ada), member(bob), member(cleo)];
    const history: BenchPlacement[] = [];
    const order: (EmployeeId | null)[] = [];
    for (let n = 0; n < 7; n += 1) {
      const turn = nextFromBench(bench([ada, bob, cleo]), members, history);
      order.push(turn);
      history.push(placement(turn));
    }
    expect(order).toEqual([ada, bob, cleo, ada, bob, cleo, ada]);
  });

  it("goes by the most recent placement, not the order they arrived in", () => {
    // Tasks come back from storage in whatever order the store felt like.
    const first = placement(ada, 1);
    const second = placement(bob, 2);
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [second, first])).toBe(ada);
  });

  it("breaks a tie on the same instant by id, so a tick is not a coin toss", () => {
    // Two tasks can land in the same millisecond; without this the rotation
    // depends on array order and the same office answers differently twice.
    const at = new Date(2026, 8, 30, 9, 0, 0);
    const a = { id: "task-a", assigneeId: ada, benchId: "bench-1" as BenchId, createdAt: at };
    const b = { id: "task-b", assigneeId: bob, benchId: "bench-1" as BenchId, createdAt: at };
    const members = [member(ada), member(bob)];

    expect(nextFromBench(bench([ada, bob]), members, [a, b])).toBe(
      nextFromBench(bench([ada, bob]), members, [b, a]),
    );
  });
});

describe("members who cannot take work", () => {
  it("passes over somebody paused rather than waiting for them", () => {
    // Their turn does not hold up the queue: work would simply stop.
    const members = [member(ada), member(bob, "paused")];
    expect(nextFromBench(bench([ada, bob]), members, [placement(ada)])).toBe(ada);
  });

  it("passes over somebody terminated", () => {
    const members = [member(ada), member(bob, "terminated")];
    expect(nextFromBench(bench([ada, bob]), members, [placement(ada)])).toBe(ada);
  });

  it("passes over a member the department no longer holds", () => {
    // Removed from the room but still named on the bench: not an error, just
    // somebody who cannot be given anything.
    expect(nextFromBench(bench([ada, bob]), [member(ada)], [placement(ada)])).toBe(ada);
  });

  it("carries on round the bench when the one whose turn it was came back", () => {
    const members = [member(ada), member(bob), member(cleo)];
    expect(nextFromBench(bench([ada, bob, cleo]), members, [placement(bob)])).toBe(cleo);
  });

  it("places nothing when nobody on the bench can work", () => {
    const members = [member(ada, "paused"), member(bob, "terminated")];
    expect(nextFromBench(bench([ada, bob]), members, [])).toBeNull();
  });

  it("places nothing when the bench has nobody on it", () => {
    // An empty bench is not a reason to invent an assignee.
    expect(nextFromBench(bench([]), [member(ada)], [])).toBeNull();
  });

  it("ignores what the last placement said when that person has since left", () => {
    const members = [member(ada), member(cleo)];
    expect(nextFromBench(bench([ada, cleo]), members, [placement(bob)])).toBe(ada);
  });

  it("ignores work another bench placed", () => {
    // Two benches in one room each keep their own turn; a filter left to every
    // caller is a rule that gets forgotten in one of them.
    // Placed on ada, so an unfiltered read would say bob is next.
    const elsewhere = { ...placement(ada), benchId: "bench-other" as BenchId };
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [elsewhere])).toBe(ada);
  });

  it("ignores work no bench placed", () => {
    // Assigned to ada by hand; the bench's own turn has not started.
    const direct = { ...placement(ada), benchId: null };
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [direct])).toBe(ada);
  });

  it("ignores a placement that never reached anybody", () => {
    expect(nextFromBench(bench([ada, bob]), [member(ada), member(bob)], [placement(null)])).toBe(
      ada,
    );
  });
});

describe("whether a bench is shaped like one", () => {
  it("takes an ordinary bench", () => {
    expect(unwrap(validateBenchShape([bench([ada, bob])]))).toHaveLength(1);
  });

  it("takes a department with no benches at all", () => {
    expect(unwrap(validateBenchShape([]))).toEqual([]);
  });

  it("refuses the same person on two benches in one room", () => {
    // Whose turn it is would have two answers, and the two benches would spend
    // the same person's time without either of them seeing the other.
    const two = [bench([ada, bob]), bench([bob], { id: "bench-2" as BenchId, name: "Review" })];
    expect(isErr(validateBenchShape(two))).toBe(true);
  });

  it("refuses two benches with the same id", () => {
    expect(isErr(validateBenchShape([bench([ada]), bench([bob], { name: "Review" })]))).toBe(true);
  });

  it("refuses a bench with no name", () => {
    expect(isErr(validateBenchShape([bench([ada], { name: "  " })]))).toBe(true);
  });

  it("refuses a strategy nobody has heard of", () => {
    expect(isErr(validateBenchShape([bench([ada], { strategy: "vibes" as never })]))).toBe(true);
  });

  it("allows an empty bench, because a box is made before anyone is put in it", () => {
    expect(isErr(validateBenchShape([bench([])]))).toBe(false);
  });

  it("says which bench was wrong", () => {
    const result = validateBenchShape([bench([ada]), bench([], { id: "b2" as BenchId, name: "" })]);
    expect(isErr(result) && result.error.some((e) => e.path.includes("benches[1]"))).toBe(true);
  });

  it("takes a judge from outside the bench", () => {
    const judged = bench([ada, bob], { strategy: "shootout", judgeId: cleo });
    expect(unwrap(validateBenchShape([judged]))[0]?.judgeId).toBe(cleo);
  });

  it("refuses a judge who is on the bench being judged", () => {
    // An entrant marking its own entry is the one thing a shootout cannot
    // survive: the comparison is the only output, and it would be rigged.
    const rigged = bench([ada, bob], { strategy: "shootout", judgeId: ada });
    expect(isErr(validateBenchShape([rigged]))).toBe(true);
  });

  it("keeps a judge on a round robin bench rather than refusing it", () => {
    // The strategy is a switch, and switching it back must not lose who judges.
    const idle = bench([ada], { judgeId: cleo });
    expect(unwrap(validateBenchShape([idle]))[0]?.judgeId).toBe(cleo);
  });

  it("takes a bench that says nothing about judging, and reads it as nobody", () => {
    const silent = { ...bench([ada]), judgeId: undefined } as unknown as Bench;
    expect(unwrap(validateBenchShape([silent]))[0]?.judgeId).toBeNull();
  });

  it("takes a bench with nobody judging, which is a person deciding", () => {
    expect(unwrap(validateBenchShape([bench([ada], { strategy: "shootout" })]))[0]?.judgeId).toBe(
      null,
    );
  });

  it("says nothing about who works where, which it cannot know", () => {
    // Separate from validateBenchMembers for the reason validateGrantShape is
    // separate from validateToolGrants: this runs on every change, with no list
    // of the room's people to consult.
    expect(isErr(validateBenchShape([bench(["emp-nowhere" as EmployeeId])]))).toBe(false);
  });
});

describe("whether a bench's members work in the room", () => {
  const inRoom = [ada, bob];
  const inOffice = [ada, bob, cleo];

  it("accepts members who do", () => {
    expect(validateBenchMembers([bench([ada, bob])], inRoom, inOffice)).toEqual([]);
  });

  it("refuses a member who does not work in this department", () => {
    expect(
      validateBenchMembers([bench([ada, "emp-nope" as EmployeeId])], inRoom, inOffice),
    ).toHaveLength(1);
  });

  it("says which member on which bench", () => {
    const problems = validateBenchMembers(
      [bench([ada]), bench([bob, "emp-nope" as EmployeeId], { id: "b2" as BenchId })],
      inRoom,
      inOffice,
    );
    expect(problems[0]?.path).toContain("benches[1].memberIds[1]");
  });

  it("accepts a judge from another department, as a reviewer may be", () => {
    // Cleo works elsewhere in the office. Judging is not the room's work, and
    // somebody outside it is often the only person with nothing at stake.
    expect(validateBenchMembers([bench([ada, bob], { judgeId: cleo })], inRoom, inOffice)).toEqual(
      [],
    );
  });

  it("takes a bench that says nothing at all about judging", () => {
    // What arrives over HTTP or out of a file has whatever keys it has, and a
    // bench with no judge is the ordinary case — not one to refuse.
    const silent = { ...bench([ada]), judgeId: undefined } as unknown as Bench;
    expect(validateBenchMembers([silent], inRoom, inOffice)).toEqual([]);
  });

  it("refuses a judge nobody in the office has heard of", () => {
    const stranger = bench([ada], { judgeId: "emp-nope" as EmployeeId });
    expect(validateBenchMembers([stranger], inRoom, inOffice)).toHaveLength(1);
  });

  it("says which bench the unknown judge is on", () => {
    const problems = validateBenchMembers(
      [bench([ada]), bench([bob], { id: "b2" as BenchId, judgeId: "emp-nope" as EmployeeId })],
      inRoom,
      inOffice,
    );
    expect(problems[0]?.path).toBe("benches[1].judgeId");
  });
});
