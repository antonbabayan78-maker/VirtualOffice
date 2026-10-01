/**
 * Carrying out a handoff: turning the effect into the next department's work.
 *
 * Shared by the server and by a headless run, because the alternative is two
 * implementations of the same thing — which has now cost this repo three
 * separate bugs, in the scheduler's view of an office, in what an agent does on
 * its turn, and in how busy everyone is.
 *
 * It decides who takes the work, which the engine cannot: the engine is given
 * the finishing department's people, not the receiving one's. Ranking is the
 * same ranking a peer review uses — skill first, then who has least on, then a
 * stable order — so "the right person" means one thing across the office.
 */
import {
  createContest,
  createTask,
  placeOnBench,
  type Bench,
  type BenchChoice,
  type BenchPlacement,
  type ContestId,
  type Result,
  type Task,
  type TaskDeps,
} from "@vo/core";
import { rankPeers } from "./peer-policy.js";
import type { PeerCandidate, WorkflowEffect } from "./workflow-types.js";

export type CreateWorkEffect = Extract<WorkflowEffect, { type: "create_work" }>;

/**
 * The receiving department's boxes, and what they have already handed out.
 *
 * Empty for a room with none, which is most of them — so an arrow that names
 * nobody behaves exactly as it did before benches existed.
 */
export interface ReceivingRoom {
  readonly benches: readonly Bench[];
  /** Everything placed in this room; each bench picks out its own. */
  readonly placed: readonly BenchPlacement[];
}

const NO_BENCHES: ReceivingRoom = { benches: [], placed: [] };

/**
 * Who should take this, from the people in the receiving department.
 *
 * Null when there is nobody to take it, which is a handoff that cannot be
 * placed rather than one to force on somebody who has left.
 */
export function chooseRecipient(
  effect: CreateWorkEffect,
  candidates: readonly PeerCandidate[],
  room: ReceivingRoom = NO_BENCHES,
): PeerCandidate["id"] | null {
  const chosen = chooseEveryone(effect, candidates, room);
  // A shootout reaches several people, and this answers the older question of
  // which one person takes the work: the first entrant, which is who a bench
  // with one strategy would have chosen anyway.
  if (chosen.kind === "every") return chosen.employeeIds[0] ?? null;
  return chosen.kind === "one" ? chosen.employeeId : null;
}

/**
 * Who this work reaches: one person, or everybody on a shootout bench.
 *
 * The bench answers for itself through `placeOnBench`, so the two strategies
 * cannot drift apart between here and the route that creates work directly.
 */
function chooseEveryone(
  effect: CreateWorkEffect,
  candidates: readonly PeerCandidate[],
  room: ReceivingRoom,
): BenchChoice {
  const active = candidates.filter((candidate) => candidate.status === "active");
  const assign = effect.assign;
  if (assign.kind === "bench") {
    // A bench that has gone, or one nobody on it can work, places nothing.
    // Dropping the work on whoever is nearest instead would quietly undo what
    // the arrow asked for — the point of naming a bench is that it decides.
    const bench = room.benches.find((candidate) => candidate.id === assign.benchId);
    if (bench === undefined) return { kind: "nobody" };
    return placeOnBench(bench, candidates, room.placed);
  }
  const one = chooseOne(effect, active);
  return one === null ? { kind: "nobody" } : { kind: "one", employeeId: one };
}

function chooseOne(
  effect: CreateWorkEffect,
  active: readonly PeerCandidate[],
): PeerCandidate["id"] | null {
  const assign = effect.assign;
  if (assign.kind === "named") {
    // A name that no longer answers is not a reason to drop the work; the
    // department still has it to do.
    const named = active.find((candidate) => candidate.id === assign.employeeId);
    if (named !== undefined) return named.id;
  }
  const skills = assign.kind === "skill" ? [assign.skill] : [];
  return rankPeers(active, { assigneeId: null, reviewSkills: skills })[0]?.id ?? null;
}

export interface HandoffPlacement {
  readonly task: Task;
  /** Null when nobody could take it: the work lands in the department's backlog. */
  readonly assignedTo: PeerCandidate["id"] | null;
}

/**
 * The work this handoff makes in the receiving department.
 *
 * Usually one piece. A shootout bench makes one per entrant, all asking the same
 * question, which is why this answers with a list rather than a task — and why
 * the caller copies the documents into every one of them.
 */
export function performCreateWork(
  effect: CreateWorkEffect,
  officeId: Task["officeId"],
  candidates: readonly PeerCandidate[],
  deps: TaskDeps,
  room: ReceivingRoom = NO_BENCHES,
): Result<readonly HandoffPlacement[]> {
  const chosen = chooseEveryone(effect, candidates, room);
  const asked = {
    officeId,
    departmentId: effect.toDepartmentId,
    title: effect.title,
    brief: effect.brief,
    priority: effect.priority,
    artifacts: effect.artifacts,
    route: effect.route,
    // Recorded only when a bench actually placed it, so the bench's record is
    // what it handed out rather than what passed through the room.
    ...(effect.assign.kind === "bench" && chosen.kind !== "nobody"
      ? { benchId: effect.assign.benchId as Task["benchId"] & string }
      : {}),
  };

  if (chosen.kind === "every") {
    // One id off the same generator: a contest only needs to be told apart from
    // other contests, and nothing else in this office is keyed by it.
    const contestId = deps.id() as string as ContestId;
    const entries = createContest(asked, chosen.employeeIds, contestId, deps);
    if (!entries.ok) return entries;
    return {
      ok: true,
      value: entries.value.map((task) => ({ task, assignedTo: task.assigneeId })),
    };
  }

  const assignedTo = chosen.kind === "one" ? chosen.employeeId : null;
  const created = createTask(
    { ...asked, ...(assignedTo === null ? {} : { assigneeId: assignedTo }) },
    deps,
  );
  if (!created.ok) return created;
  return { ok: true, value: [{ task: created.value, assignedTo }] };
}
