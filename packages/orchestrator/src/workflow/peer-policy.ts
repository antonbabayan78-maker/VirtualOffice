/**
 * Peer review policy (plan §3, scenario 3).
 *
 * A colleague from the same department reviews the work: the active peer with
 * the most overlapping skills, then the lightest open-task load, then the
 * lowest id so the choice is deterministic. The assignee is never picked, and
 * paused or terminated employees are never picked. With no eligible peer the
 * review falls back to the supervisor, and failing that to the office owner.
 */
import type { EmployeeId } from "@vo/core";
import {
  approveReview,
  requestChangesOrEscalate,
  submitForReview,
  supervisorChoice,
} from "./review-common.js";
import type { PeerCandidate, PolicyHandler } from "./workflow-types.js";

export type { PeerCandidate } from "./workflow-types.js";

export interface PeerSelection {
  readonly assigneeId: EmployeeId | null;
  readonly reviewSkills: readonly string[];
}

export function selectPeerReviewer(
  peers: readonly PeerCandidate[],
  selection: PeerSelection,
): EmployeeId | null {
  const required = new Set(selection.reviewSkills);
  const ranked = peers
    .filter((p) => p.status === "active" && p.id !== selection.assigneeId)
    .map((peer) => ({ peer, overlap: peer.skillIds.filter((skill) => required.has(skill)).length }))
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.peer.openTasks - b.peer.openTasks ||
        (a.peer.id < b.peer.id ? -1 : a.peer.id > b.peer.id ? 1 : 0),
    );
  return ranked[0]?.peer.id ?? null;
}

export const PEER_POLICY_HANDLER: PolicyHandler = {
  kind: "peer",
  handle(task, event, context) {
    switch (event.type) {
      case "submit": {
        const chosen = selectPeerReviewer(context.peers ?? [], {
          assigneeId: task.assigneeId,
          reviewSkills: context.reviewSkills ?? [],
        });
        if (chosen !== null) {
          return submitForReview(task, event, context, {
            reviewerIds: [chosen],
            audience: "reviewer",
          });
        }
        const fallback = supervisorChoice(task, context);
        if (!fallback.ok) return fallback;
        return submitForReview(task, event, context, fallback.value);
      }
      case "approve":
        return approveReview(task, event, context);
      case "request_changes":
        return requestChangesOrEscalate(task, event, context);
    }
  },
};
