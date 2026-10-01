import { describe, expect, it } from "vitest";
import type { BenchId } from "../department/bench.js";
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { isErr, unwrap } from "../shared/result.js";
import { contestStanding, createContest, recordContestWin, type ContestId } from "./contest.js";
import { transitionTask, type Task, type TaskDeps, type TaskId } from "./task.js";

const ada = "emp-ada" as EmployeeId;
const bob = "emp-bob" as EmployeeId;
const cleo = "emp-cleo" as EmployeeId;
const contestId = "contest-1" as ContestId;
const at = new Date("2026-10-01T09:00:00Z");

let next = 0;
const deps: TaskDeps = {
  id: () => `task-${String(++next)}` as TaskId,
  now: () => at,
};

const question = {
  officeId: "office-1" as OfficeId,
  departmentId: "dept-design" as DepartmentId,
  title: "Draft the launch note",
  brief: "Two paragraphs, no jargon.",
  priority: "high",
  benchId: "bench-1" as BenchId,
  acceptanceCriteria: ["It fits on one screen"],
};

const entriesFor = (members: readonly EmployeeId[] = [ada, bob]): readonly Task[] =>
  unwrap(createContest(question, members, contestId, deps));

/** The nth entry, which the test has just made and so knows is there. */
function nth(entries: readonly Task[], index: number): Task {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`no entry at ${String(index)}`);
  return entry;
}

/** An entry that has been worked and finished, as one has when it is judged. */
const finished = (task: Task): Task => {
  const options = { at, actorId: task.assigneeId };
  const started = unwrap(transitionTask(task, "in_progress", options));
  return unwrap(transitionTask(started, "done", options));
};

describe("fanning one job out to everybody", () => {
  it("makes one piece of work per member", () => {
    expect(entriesFor([ada, bob, cleo])).toHaveLength(3);
  });

  it("gives each of them to one person, as any other task is", () => {
    // Nothing downstream learns anything new: an entry is an ordinary task with
    // an ordinary assignee, which is what keeps one review and one done.
    expect(entriesFor().map((entry) => entry.assigneeId)).toEqual([ada, bob]);
  });

  it("puts them all in the same contest", () => {
    const ids = new Set(entriesFor().map((entry) => entry.contestId));
    expect([...ids]).toEqual([contestId]);
  });

  it("asks every one of them exactly the same thing", () => {
    // The point of a shootout: a difference in the answers is a difference in
    // the models, not in what they were asked.
    const [first, second] = entriesFor();
    expect(first?.title).toBe(second?.title);
    expect(first?.brief).toBe(second?.brief);
    expect(first?.priority).toBe(second?.priority);
    expect(first?.acceptanceCriteria).toEqual(second?.acceptanceCriteria);
  });

  it("records the bench that ran it, so its record holds the contest", () => {
    expect(entriesFor()[0]?.benchId).toBe("bench-1");
  });

  it("gives each entry its own id", () => {
    const [first, second] = entriesFor();
    expect(first?.id).not.toBe(second?.id);
  });

  it("refuses a contest with nobody in it", () => {
    // Not an empty contest: nothing was asked of anybody, and a record of that
    // is a record of nothing.
    expect(isErr(createContest(question, [], contestId, deps))).toBe(true);
  });

  it("refuses the whole contest when the question is not a task", () => {
    expect(isErr(createContest({ ...question, title: "  " }, [ada, bob], contestId, deps))).toBe(
      true,
    );
  });
});

describe("how a contest is getting on", () => {
  it("is running while somebody is still working", () => {
    expect(contestStanding(entriesFor())).toBe("running");
  });

  it("is running when one is in and one is not", () => {
    const entries = entriesFor();
    expect(contestStanding([finished(nth(entries, 0)), nth(entries, 1)])).toBe("running");
  });

  it("is still running while an entry has a move left", () => {
    // Approved is not finished: it goes to done, and judging it now would be
    // judging work that is about to change.
    const entries = entriesFor();
    const working = unwrap(transitionTask(nth(entries, 1), "in_progress", { at, actorId: null }));
    const submitted = unwrap(transitionTask(working, "in_review", { at, actorId: null }));
    const approved = unwrap(transitionTask(submitted, "approved", { at, actorId: null }));
    expect(contestStanding([finished(nth(entries, 0)), approved])).toBe("running");
  });

  it("is ready once every entry is in", () => {
    expect(contestStanding(entriesFor().map(finished))).toBe("ready");
  });

  it("counts a cancelled entry as out of the contest rather than holding it up", () => {
    // Somebody's run was abandoned. The remaining answers are still comparable,
    // and waiting for an entry that will never arrive strands the comparison.
    const entries = entriesFor();
    const cancelled = unwrap(
      transitionTask(nth(entries, 1), "cancelled", { at, actorId: null, reason: "abandoned" }),
    );
    expect(contestStanding([finished(nth(entries, 0)), cancelled])).toBe("ready");
  });

  it("is not ready when every entry was cancelled", () => {
    // Nothing was produced, so there is nothing to compare.
    const cancelled = entriesFor().map((entry) =>
      unwrap(transitionTask(entry, "cancelled", { at, actorId: null, reason: "abandoned" })),
    );
    expect(contestStanding(cancelled)).toBe("running");
  });

  it("is decided once one of them has won", () => {
    const entries = entriesFor().map(finished);
    const won = unwrap(
      recordContestWin(entries, nth(entries, 1).id, {
        reason: "tighter, and it kept the detail",
        decidedBy: null,
        at,
      }),
    );
    expect(contestStanding(entries.map((one) => (one.id === won.id ? won : one)))).toBe("decided");
  });

  it("says running for no entries at all, because nothing has been asked", () => {
    expect(contestStanding([])).toBe("running");
  });
});

describe("saying which one won", () => {
  const decide = (
    entries: readonly Task[],
    winnerId: TaskId,
    overrides: { reason?: string; decidedBy?: EmployeeId | null } = {},
  ) =>
    recordContestWin(entries, winnerId, {
      reason: overrides.reason ?? "tighter, and it kept the detail",
      decidedBy: overrides.decidedBy ?? null,
      at,
    });

  it("marks the entry that won", () => {
    const entries = entriesFor().map(finished);
    const winner = unwrap(decide(entries, nth(entries, 0).id));
    expect(winner.won?.reason).toBe("tighter, and it kept the detail");
  });

  it("says when it was decided", () => {
    const entries = entriesFor().map(finished);
    expect(unwrap(decide(entries, nth(entries, 0).id)).won?.decidedAt).toEqual(at);
  });

  it("says a person decided, when nobody is named", () => {
    const entries = entriesFor().map(finished);
    expect(unwrap(decide(entries, nth(entries, 0).id)).won?.decidedBy).toBeNull();
  });

  it("names the employee that decided, when one did", () => {
    const entries = entriesFor().map(finished);
    const winner = unwrap(decide(entries, nth(entries, 0).id, { decidedBy: cleo }));
    expect(winner.won?.decidedBy).toBe(cleo);
  });

  it("leaves the entries that lost exactly as they were", () => {
    // Losing is not a thing that happens to a task: the work was done and it
    // stands. Only the winner carries the verdict.
    const entries = entriesFor().map(finished);
    const winner = unwrap(decide(entries, nth(entries, 0).id));
    expect(winner.id).toBe(nth(entries, 0).id);
    expect(entries[1]?.won).toBeNull();
  });

  it("refuses a winner that is not in this contest", () => {
    const entries = entriesFor().map(finished);
    expect(isErr(decide(entries, "task-elsewhere" as TaskId))).toBe(true);
  });

  it("refuses an entry that has not finished", () => {
    // There is nothing to have judged: the output is not in.
    const entries = entriesFor();
    const half = [finished(nth(entries, 0)), nth(entries, 1)];
    expect(isErr(decide(half, nth(entries, 1).id))).toBe(true);
  });

  it("refuses a verdict with no reason", () => {
    // A winner with no reason is a preference, not a judgement, and the reason
    // is the only part anybody can act on later.
    const entries = entriesFor().map(finished);
    expect(isErr(decide(entries, nth(entries, 0).id, { reason: "   " }))).toBe(true);
  });

  it("refuses a reason too long to keep", () => {
    const entries = entriesFor().map(finished);
    expect(isErr(decide(entries, nth(entries, 0).id, { reason: "x".repeat(20_001) }))).toBe(true);
  });

  it("trims the reason", () => {
    const entries = entriesFor().map(finished);
    const winner = unwrap(decide(entries, nth(entries, 0).id, { reason: "  clearer  " }));
    expect(winner.won?.reason).toBe("clearer");
  });

  it("names the entry that already won, not the question they all answered", () => {
    // Every entry carries the same title, so saying the title would read as
    // "Draft the launch note won it" — true of all of them and useful about none.
    const entries = entriesFor().map(finished);
    const first = unwrap(decide(entries, nth(entries, 0).id));
    const decided = entries.map((one) => (one.id === first.id ? first : one));
    const again = decide(decided, nth(entries, 1).id);

    expect(isErr(again) && again.error[0]?.message).toContain(first.id);
  });

  it("refuses a second verdict rather than overwriting the first", () => {
    // A verdict is a record of a judgement. Deciding again would quietly rewrite
    // what somebody concluded, and "decided" stops being one write.
    const entries = entriesFor().map(finished);
    const first = unwrap(decide(entries, nth(entries, 0).id));
    const decided = entries.map((one) => (one.id === first.id ? first : one));

    expect(isErr(decide(decided, nth(entries, 1).id))).toBe(true);
  });

  it("refuses deciding the same entry twice", () => {
    const entries = entriesFor().map(finished);
    const first = unwrap(decide(entries, nth(entries, 0).id));
    const decided = entries.map((one) => (one.id === first.id ? first : one));

    expect(isErr(decide(decided, first.id))).toBe(true);
  });

  it("refuses a contest with nothing in it", () => {
    expect(isErr(decide([], "task-1" as TaskId))).toBe(true);
  });
});
