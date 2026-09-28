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
import { createTask, type Result, type Task, type TaskDeps } from "@vo/core";
import { rankPeers } from "./peer-policy.js";
import type { PeerCandidate, WorkflowEffect } from "./workflow-types.js";

export type CreateWorkEffect = Extract<WorkflowEffect, { type: "create_work" }>;

/**
 * Who should take this, from the people in the receiving department.
 *
 * Null when there is nobody to take it, which is a handoff that cannot be
 * placed rather than one to force on somebody who has left.
 */
export function chooseRecipient(
  effect: CreateWorkEffect,
  candidates: readonly PeerCandidate[],
): PeerCandidate["id"] | null {
  const active = candidates.filter((candidate) => candidate.status === "active");
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

export function performCreateWork(
  effect: CreateWorkEffect,
  officeId: Task["officeId"],
  candidates: readonly PeerCandidate[],
  deps: TaskDeps,
): Result<HandoffPlacement> {
  const assignedTo = chooseRecipient(effect, candidates);
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
    },
    deps,
  );
  if (!created.ok) return created;
  return { ok: true, value: { task: created.value, assignedTo } };
}
