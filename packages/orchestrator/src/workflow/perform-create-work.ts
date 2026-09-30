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
  createTask,
  nextFromBench,
  type Bench,
  type BenchPlacement,
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
  const active = candidates.filter((candidate) => candidate.status === "active");
  const assign = effect.assign;
  if (assign.kind === "bench") {
    // A bench that has gone, or one nobody on it can work, places nothing.
    // Dropping the work on whoever is nearest instead would quietly undo what
    // the arrow asked for — the point of naming a bench is that it decides.
    const bench = room.benches.find((candidate) => candidate.id === assign.benchId);
    if (bench === undefined) return null;
    return nextFromBench(bench, candidates, room.placed);
  }
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

export function performCreateWork(
  effect: CreateWorkEffect,
  officeId: Task["officeId"],
  candidates: readonly PeerCandidate[],
  deps: TaskDeps,
  room: ReceivingRoom = NO_BENCHES,
): Result<HandoffPlacement> {
  const assignedTo = chooseRecipient(effect, candidates, room);
  const created = createTask(
    {
      officeId,
      departmentId: effect.toDepartmentId,
      title: effect.title,
      brief: effect.brief,
      priority: effect.priority,
      artifacts: effect.artifacts,
      route: effect.route,
      ...(assignedTo === null ? {} : { assigneeId: assignedTo }),
      // Recorded only when a bench actually placed it, so the bench's record
      // is what it handed out rather than what passed through the room.
      ...(effect.assign.kind === "bench" && assignedTo !== null
        ? { benchId: effect.assign.benchId as Task["benchId"] & string }
        : {}),
    },
    deps,
  );
  if (!created.ok) return created;
  return { ok: true, value: { task: created.value, assignedTo } };
}
