/**
 * A bench: several people in one room who take the same kind of work in turn.
 *
 * Made for running two employees on different models against the same job and
 * seeing whose output is better — which needs nothing new in the employee
 * model, since an employee already carries its own. What was missing is
 * something that splits the work between them and records who got what.
 *
 * From outside a bench looks like passing work to one person: it chooses a
 * member at the moment work arrives and the task is assigned to that member, as
 * any other task is. Everything downstream — the scheduler, the review policy,
 * the trays — sees an ordinary task with an ordinary assignee. The bench is how
 * the work got there, not a second thing it is assigned to.
 *
 * **Whose turn it is, is derived rather than stored.** The obvious design keeps
 * a cursor on the bench, which makes every placement a write and lets a canvas
 * save clobber a cursor the server has just moved. Instead the turn is read off
 * the work the bench has already placed — the same rule the rest of this
 * codebase follows, where activity is derived from tasks and arrows from
 * connections. Nothing to keep in step, and nothing to get out of step.
 */
import type { EmployeeId, EmployeeStatus } from "../employee/employee.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const benchIdBrand: unique symbol;
export type BenchId = string & { readonly [benchIdBrand]: true };

/**
 * What a bench does with a piece of work.
 *
 * `round_robin` hands it to one member and the comparison is across tasks —
 * cheap, statistical, and it runs on real work. `shootout` hands the same job to
 * every member and the comparison is on identical input — exact, and it costs as
 * many times as there are people on the bench.
 */
export const BENCH_STRATEGIES = ["round_robin", "shootout"] as const;
export type BenchStrategy = (typeof BENCH_STRATEGIES)[number];

export function isBenchStrategy(value: unknown): value is BenchStrategy {
  return typeof value === "string" && (BENCH_STRATEGIES as readonly string[]).includes(value);
}

export interface Bench {
  readonly id: BenchId;
  readonly name: string;
  /** In turn order. The order they were put in is the order they are used. */
  readonly memberIds: readonly EmployeeId[];
  readonly strategy: BenchStrategy;
  /**
   * Who decides a shootout, or null when only a person does.
   *
   * Never a member of this bench: an entrant marking its own entry is the one
   * thing a comparison cannot survive, since the comparison is the only output.
   * May work in another department, as a reviewer may.
   */
  readonly judgeId: EmployeeId | null;
}

/** A member as the department knows them: on the bench, and able to work or not. */
export interface BenchMember {
  readonly id: EmployeeId;
  readonly status: EmployeeStatus;
}

/**
 * A piece of work, and which bench placed it if any.
 *
 * Callers hand over everything in the room and `nextFromBench` picks out its
 * own: two benches in one department each keep their own turn, and a filter
 * left to every caller is a rule that gets forgotten in one of them.
 */
export interface BenchPlacement {
  readonly id: string;
  readonly assigneeId: EmployeeId | null;
  readonly benchId: BenchId | null;
  readonly createdAt: Date;
}

/**
 * Whose turn it is, or null when the bench can place nothing.
 *
 * Somebody paused, terminated, or no longer in the room is passed over rather
 * than waited for: their turn coming round must not stop the queue, and work
 * forced onto somebody who has left is work nobody does.
 */
export function nextFromBench(
  bench: Bench,
  members: readonly BenchMember[],
  placed: readonly BenchPlacement[],
): EmployeeId | null {
  const canWork = new Set(
    members.filter((one) => one.status === "active").map((one) => one.id as string),
  );
  // Turn order is the bench's own, narrowed to whoever can actually take work.
  const turn = bench.memberIds.filter((id) => canWork.has(id));
  if (turn.length === 0) return null;

  // Newest last. Ties on the instant break by id, because two tasks can land in
  // the same millisecond and a rotation that depended on array order would
  // answer differently for the same office twice running.
  const newest = placed
    .filter((one) => one.benchId === bench.id)
    .sort((a, b) =>
      a.createdAt.getTime() === b.createdAt.getTime()
        ? a.id.localeCompare(b.id)
        : a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .at(-1);

  const lastAt =
    newest?.assigneeId === undefined || newest.assigneeId === null
      ? -1
      : turn.indexOf(newest.assigneeId);
  // -1 covers all three ways the last placement tells us nothing: there was
  // none, it reached nobody, or it went to somebody who has since gone. Each
  // means start at the top.
  return turn[(lastAt + 1) % turn.length] ?? null;
}

/**
 * What this bench does with one piece of work: one person, or all of them.
 *
 * A discriminated answer rather than an employee or a list, because the two
 * strategies place work differently and a caller that forgets one of them
 * should not compile. `nobody` is a bench that can place nothing — empty, or
 * with nobody on it able to work — which is not an error and not a reason to
 * drop the work on whoever is nearest.
 */
export type BenchChoice =
  | { readonly kind: "one"; readonly employeeId: EmployeeId }
  | { readonly kind: "every"; readonly employeeIds: readonly EmployeeId[] }
  | { readonly kind: "nobody" };

export function placeOnBench(
  bench: Bench,
  members: readonly BenchMember[],
  placed: readonly BenchPlacement[],
): BenchChoice {
  if (bench.strategy === "shootout") {
    const canWork = new Set(
      members.filter((one) => one.status === "active").map((one) => one.id as string),
    );
    // The bench's own order, so the entries read the way the bench is written.
    // Nothing here depends on what was placed before: a shootout does not
    // rotate, and the same job tomorrow goes to the same people.
    const entrants = bench.memberIds.filter((id) => canWork.has(id));
    return entrants.length === 0 ? { kind: "nobody" } : { kind: "every", employeeIds: entrants };
  }

  const turn = nextFromBench(bench, members, placed);
  return turn === null ? { kind: "nobody" } : { kind: "one", employeeId: turn };
}

const NAMED = (path: string, message: string): ValidationError => ({ path, message });

/**
 * Whether these are shaped like benches, without asking who works where.
 *
 * Separate from `validateBenchMembers` for the reason `validateGrantShape` is
 * separate from `validateToolGrants`: this one runs whenever a department is
 * created or changed and has no list of the room's people to consult, while
 * that one is the cross-check a route or an office file can afford.
 *
 * An empty bench passes: a box is made before anybody is put in it, and
 * refusing one would mean creating a bench and filling it in a single move.
 */
export function validateBenchShape(benches: readonly Bench[]): Result<readonly Bench[]> {
  const errors: ValidationError[] = [];
  const seenIds = new Set<string>();
  const seenMembers = new Map<string, string>();

  benches.forEach((bench, index) => {
    const at = `benches[${String(index)}]`;
    if (typeof bench.name !== "string" || bench.name.trim().length === 0) {
      errors.push(NAMED(`${at}.name`, "must not be empty"));
    }
    if (typeof bench.id !== "string" || bench.id.length === 0) {
      errors.push(NAMED(`${at}.id`, "must be an id"));
    } else if (seenIds.has(bench.id)) {
      errors.push(NAMED(`${at}.id`, `duplicate bench id "${bench.id}"`));
    }
    seenIds.add(bench.id);

    if (!isBenchStrategy(bench.strategy)) {
      errors.push(NAMED(`${at}.strategy`, `must be one of ${BENCH_STRATEGIES.join(", ")}`));
    }

    const members: readonly EmployeeId[] = Array.isArray(bench.memberIds) ? bench.memberIds : [];
    // Checked whatever the strategy is, so switching a bench to a shootout
    // cannot turn a saved judge into a rigged one. A judge on a round robin
    // bench is idle rather than wrong, and switching back must not lose it.
    const judgeId = bench.judgeId ?? null;
    if (judgeId !== null && members.includes(judgeId)) {
      errors.push(NAMED(`${at}.judgeId`, `"${judgeId}" is on this bench, so cannot judge it`));
    }
    members.forEach((memberId, position) => {
      // Two benches over one person means "whose turn" has two answers, and
      // each spends the same person's time without seeing the other.
      const already = seenMembers.get(memberId);
      if (already !== undefined) {
        errors.push(
          NAMED(
            `${at}.memberIds[${String(position)}]`,
            `"${memberId}" is already on the "${already}" bench`,
          ),
        );
        return;
      }
      seenMembers.set(memberId, bench.name);
    });
  });

  if (errors.length > 0) return err(errors);
  return ok(
    benches.map((bench) => ({
      id: bench.id,
      name: bench.name.trim(),
      memberIds: [...bench.memberIds],
      strategy: bench.strategy,
      judgeId: bench.judgeId ?? null,
    })),
  );
}

/**
 * Checks each member against the people the department actually holds, and each
 * judge against the office's.
 *
 * Two lists because the two answer to different rooms: a member takes the
 * bench's work, so they work here, while a judge only reads what came out of it
 * and is often better for having nothing at stake in this department.
 */
export function validateBenchMembers(
  benches: readonly Bench[],
  employeesInDepartment: readonly EmployeeId[],
  employeesInOffice: readonly EmployeeId[],
): ValidationError[] {
  const works = new Set(employeesInDepartment as readonly string[]);
  const anywhere = new Set(employeesInOffice as readonly string[]);
  const errors: ValidationError[] = [];
  benches.forEach((bench, index) => {
    bench.memberIds.forEach((memberId, position) => {
      if (!works.has(memberId)) {
        errors.push(
          NAMED(
            `benches[${String(index)}].memberIds[${String(position)}]`,
            `"${memberId}" does not work in this department`,
          ),
        );
      }
    });
    // Absent means nobody judges, which is what a body or a file that says
    // nothing about it means. Only a judge who was named has to exist.
    const judgeId = bench.judgeId ?? null;
    if (judgeId !== null && !anywhere.has(judgeId)) {
      errors.push(
        NAMED(`benches[${String(index)}].judgeId`, `"${judgeId}" does not work in this office`),
      );
    }
  });
  return errors;
}
