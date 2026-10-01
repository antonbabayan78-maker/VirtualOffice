/**
 * A contest: the same job given to everybody on a bench, and which answer won.
 *
 * A shootout exists to settle something a round-robin bench can only estimate.
 * Splitting work between two models and comparing the results across different
 * tasks is statistics; giving both the identical job and reading the two answers
 * is an observation. It costs as many times as there are entrants, which is why
 * it is a strategy somebody turns on rather than how a bench behaves.
 *
 * **A contest is its entries and nothing else.** There is no parent task. The
 * obvious design has one — the work as it arrived, with the entries hanging off
 * it — and that parent is a row nobody works, sitting in a status it does not
 * deserve, which the scheduler then has to be taught to ignore. Instead the
 * entries share a `contestId` and everything about the contest is read off them,
 * the way whose turn it is on a bench is read off the work it has placed.
 *
 * Each entry is an ordinary task: one assignee, one review, one out-tray, one
 * definition of done. That is what makes a shootout fit a model built around
 * "one task, one answer" at all — it is N tasks, not one task with N answers.
 *
 * The verdict lives on the entry that won. Nothing is written on the ones that
 * lost: the work they did stands, and a contest nobody has decided is one where
 * no entry carries a verdict.
 */
import type { EmployeeId } from "../employee/employee.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";
import {
  createTask,
  TASK_BRIEF_MAX_LENGTH,
  type CreateTaskInput,
  type Task,
  type TaskDeps,
  type TaskId,
} from "./task.js";

declare const contestIdBrand: unique symbol;
export type ContestId = string & { readonly [contestIdBrand]: true };

export interface ContestWin {
  /** Why this answer was better. The only part of a verdict anybody can act on. */
  readonly reason: string;
  /** The employee that decided, or null when a person did. */
  readonly decidedBy: EmployeeId | null;
  readonly decidedAt: Date;
}

/**
 * Where a contest has got to.
 *
 * `running` while an answer is still coming, `ready` once they are all in and
 * nobody has decided, `decided` once one of them has won.
 */
export const CONTEST_STANDINGS = ["running", "ready", "decided"] as const;
export type ContestStanding = (typeof CONTEST_STANDINGS)[number];

/** An entry whose answer is in, and can therefore be compared and chosen. */
const isIn = (entry: Task): boolean => entry.status === "done";

/**
 * An entry still to come.
 *
 * Cancelled counts as out of the contest rather than still coming: somebody
 * abandoned that run, and waiting for an answer that will never arrive would
 * strand the comparison on it. Approved is still coming, because it has a move
 * left — judging it now would be judging work that is about to change.
 */
const isComing = (entry: Task): boolean => entry.status !== "done" && entry.status !== "cancelled";

/**
 * One piece of work per member, all asking exactly the same thing.
 *
 * The identical input is the whole point, so it is built once here rather than
 * by each caller: a difference in the answers has to be a difference in the
 * models, not in what they were asked.
 *
 * Refused outright when there is nobody to ask — an empty contest is a record of
 * nothing — and when the work itself is not a task, in which case the error is
 * the one `createTask` gave rather than the same complaint repeated per member.
 */
export function createContest(
  input: CreateTaskInput,
  memberIds: readonly EmployeeId[],
  contestId: ContestId,
  deps: TaskDeps,
): Result<readonly Task[]> {
  if (memberIds.length === 0) {
    return err([{ path: "memberIds", message: "a contest needs somebody to enter it" }]);
  }

  const entries: Task[] = [];
  for (const memberId of memberIds) {
    const created = createTask({ ...input, assigneeId: memberId, contestId }, deps);
    if (!created.ok) return created;
    entries.push(created.value);
  }
  return ok(entries);
}

export function contestStanding(entries: readonly Task[]): ContestStanding {
  if (entries.some((entry) => entry.won !== null)) return "decided";
  if (entries.some(isComing)) return "running";
  // Nothing coming and nothing in means every entry was abandoned, or there are
  // no entries: either way there is nothing to compare, so nothing is ready.
  return entries.some(isIn) ? "ready" : "running";
}

export interface ContestDecision {
  readonly reason: string;
  /** The employee deciding, or null when a person is. */
  readonly decidedBy: EmployeeId | null;
  readonly at: Date;
}

/**
 * The winner, with the reason it won.
 *
 * Returns that entry alone: the losers are untouched, so one write records a
 * verdict. Deciding before every answer is in is allowed — one clearly better
 * answer is a legitimate conclusion, and one stuck entry must not hold the
 * comparison hostage — but the entry that won has to have finished, because
 * otherwise there was nothing to read.
 *
 * **A second verdict is refused rather than replacing the first.** A verdict is
 * the record of a judgement somebody made; overwriting it would quietly rewrite
 * what they concluded, and "decided" would stop being a single write.
 */
export function recordContestWin(
  entries: readonly Task[],
  winnerId: TaskId,
  decision: ContestDecision,
): Result<Task> {
  const errors: ValidationError[] = [];

  const already = entries.find((entry) => entry.won !== null);
  if (already !== undefined) {
    errors.push({
      path: "contest",
      message: `already decided: "${already.title}" won it`,
    });
  }

  const winner = entries.find((entry) => entry.id === winnerId);
  if (winner === undefined) {
    errors.push({ path: "winnerId", message: `"${winnerId}" is not an entry in this contest` });
  } else if (!isIn(winner)) {
    errors.push({
      path: "winnerId",
      message: `that entry is ${winner.status}, so there is nothing finished to have judged`,
    });
  }

  const reason = decision.reason.trim();
  if (reason.length === 0) {
    errors.push({ path: "reason", message: "must say why it won" });
  } else if (reason.length > TASK_BRIEF_MAX_LENGTH) {
    errors.push({
      path: "reason",
      message: `must be at most ${String(TASK_BRIEF_MAX_LENGTH)} characters`,
    });
  }

  if (errors.length > 0 || winner === undefined) return err(errors);

  return ok({
    ...winner,
    // Deliberately not a history event: history is where a task's status has
    // been, and winning does not move it. The work was already done.
    won: { reason, decidedBy: decision.decidedBy, decidedAt: decision.at },
    updatedAt: decision.at,
  });
}
