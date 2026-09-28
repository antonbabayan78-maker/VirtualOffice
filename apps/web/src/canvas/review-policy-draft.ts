/**
 * Turning a review policy into something a form can hold, and back.
 *
 * Every policy kind wants different settings, so the draft carries them all and
 * only the chosen kind's are used when it is built. That way switching from
 * quorum to manager and back does not lose the number you typed.
 *
 * What comes out is handed to core to validate; nothing here decides whether a
 * policy is acceptable, only what shape to offer.
 */
import { GATED_ACTIONS, type GatedAction, type ReviewPolicy } from "@vo/core";

export const POLICY_KINDS = [
  "direct",
  "manager",
  "peer",
  "quorum",
  "pipeline",
  "automated",
  "gate",
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const POLICY_DESCRIPTION: Record<PolicyKind, string> = {
  direct: "No review. Work is finished when the employee says it is.",
  manager: "The employee's supervisor approves, or sends it back.",
  peer: "A colleague reviews, chosen by matching skills and lightest load.",
  quorum: "Several reviewers must approve; one rejection sends it back.",
  pipeline: "Ordered stages, each signed off before the next begins.",
  automated: "A check decides — a test suite, a lint run, a script.",
  gate: "A person approves work that spends, deploys, deletes or sends.",
};

export interface PolicyDraft {
  readonly kind: PolicyKind;
  readonly maxIterations: string;
  readonly required: string;
  readonly checkId: string;
  readonly gatedActions: readonly GatedAction[];
  readonly stages: readonly string[];
}

export const EMPTY_POLICY_DRAFT: PolicyDraft = {
  kind: "manager",
  maxIterations: "3",
  required: "2",
  checkId: "",
  gatedActions: [],
  stages: [],
};

export function policyDraftOf(policy: ReviewPolicy): PolicyDraft {
  return {
    ...EMPTY_POLICY_DRAFT,
    kind: policy.kind,
    ...("maxIterations" in policy ? { maxIterations: String(policy.maxIterations) } : {}),
    ...("required" in policy ? { required: String(policy.required) } : {}),
    ...("checkId" in policy ? { checkId: policy.checkId } : {}),
    ...("gatedActions" in policy ? { gatedActions: policy.gatedActions } : {}),
    ...("stages" in policy ? { stages: policy.stages.map((stage) => stage.name) } : {}),
  };
}

/** The policy this draft describes, for core to accept or refuse. */
export function policyFromDraft(draft: PolicyDraft): unknown {
  const rounds = Number(draft.maxIterations);
  switch (draft.kind) {
    case "direct":
      return { kind: "direct" };
    case "manager":
    case "peer":
      return { kind: draft.kind, maxIterations: rounds };
    case "quorum":
      return { kind: "quorum", required: Number(draft.required), maxIterations: rounds };
    case "automated":
      return { kind: "automated", checkId: draft.checkId, maxIterations: rounds };
    case "gate":
      return { kind: "gate", gatedActions: draft.gatedActions };
    case "pipeline":
      return {
        kind: "pipeline",
        maxIterations: rounds,
        // A stage needs a name here; who works and reviews it is set where the
        // office's people are, not in a text box.
        stages: draft.stages.map((name) => ({ name })),
      };
  }
}

export const ALL_GATED_ACTIONS: readonly GatedAction[] = GATED_ACTIONS;
