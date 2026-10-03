/**
 * Pre-execution approval gate.
 *
 * The review gate in `workflow/gate-policy.ts` holds finished work. That is the
 * wrong moment for two of the categories it names: approving a deploy, a delete
 * or an external send after the fact is not a gate, and neither is approving
 * money already spent. Those have to be stopped between the model asking for a
 * tool and the tool running, which is here.
 *
 * This module is pure: it decides what needs a person and reports it. The run
 * loop suspends on that report and resumes with the decisions. Which categories
 * a tool falls into is supplied by the caller, because the connector layer is
 * what knows whether `post_message` leaves the building.
 */
import type { GatedAction } from "@vo/core";
import type { ToolUse } from "./agent-run-loop.js";

/** The key of the run-level spend approval, as opposed to a single call's. */
export const SPEND_APPROVAL_KEY = "run:spend";

export type ToolClassifier = (call: ToolUse) => readonly GatedAction[];

export interface RunApprovalGate {
  /** Categories that need a person before the call runs. */
  readonly gatedActions: readonly GatedAction[];
  /** Ask once the run has cost this much, in USD. Needs "spend" to be gated. */
  readonly spendThresholdUsd?: number;
  readonly classify: ToolClassifier;
  /**
   * The real person this run acts in the name of, where there is one.
   *
   * Named in what the inbox reads, because "may this task call read_notes" and
   * "may this task call read_notes as Anna Petrova" are different questions and
   * only the second one is the decision somebody is being asked to make.
   */
  readonly asPerson?: string;
}

/** The common case: the connector layer declares categories per tool name. */
export function toolGateFromMap(
  map: Readonly<Record<string, readonly GatedAction[]>>,
): ToolClassifier {
  return (call) => map[call.name] ?? [];
}

export interface ApprovalDecision {
  /** A tool_use id, or SPEND_APPROVAL_KEY for the run's spend. */
  readonly key: string;
  readonly decision: "approved" | "declined";
  readonly decidedBy: string;
  readonly reason?: string;
}

export interface PendingItem {
  readonly key: string;
  readonly name: string;
  readonly gates: readonly GatedAction[];
  /** One line for the approvals inbox. */
  readonly detail: string;
  /**
   * The call's own arguments — the thing a person is actually deciding about.
   * Empty for the run's spending, which is not a call.
   *
   * Recorded here because this is where they are in hand. Without them an inbox
   * can only offer "may this task send email", which is approving the tool in
   * advance and is the thing this gate exists not to be.
   */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface PendingApproval {
  readonly items: readonly PendingItem[];
  /** Every category involved, without repeats. */
  readonly gates: readonly GatedAction[];
  readonly summary: string;
}

export interface GateState {
  readonly spentUsd: number;
  /** Set once the run's spend has already been approved, so it is asked once. */
  readonly spendApproved: boolean;
}

export function decisionFor(
  decisions: readonly ApprovalDecision[],
  key: string,
): ApprovalDecision | undefined {
  return decisions.find((decision) => decision.key === key);
}

/** What this call does that the gate covers, in the order the gate declares. */
function gatesForCall(call: ToolUse, gate: RunApprovalGate): readonly GatedAction[] {
  const categories = gate.classify(call);
  return gate.gatedActions.filter((action) => categories.includes(action));
}

function spendIsDue(gate: RunApprovalGate, state: GateState): boolean {
  if (state.spendApproved) return false;
  if (!gate.gatedActions.includes("spend")) return false;
  const threshold = gate.spendThresholdUsd;
  return threshold !== undefined && state.spentUsd >= threshold;
}

/**
 * What still needs a person before this turn may run, or null when nothing does.
 * An item that already has a decision — either way — is not pending any more.
 */
export function pendingApprovalFor(
  calls: readonly ToolUse[],
  gate: RunApprovalGate,
  state: GateState,
  decisions: readonly ApprovalDecision[],
): PendingApproval | null {
  const items: PendingItem[] = [];

  if (spendIsDue(gate, state) && decisionFor(decisions, SPEND_APPROVAL_KEY) === undefined) {
    const threshold = gate.spendThresholdUsd ?? 0;
    items.push({
      key: SPEND_APPROVAL_KEY,
      name: "continued spending",
      gates: ["spend"],
      detail:
        `this run has cost $${state.spentUsd.toFixed(2)}, at or past the ` +
        `$${threshold.toFixed(2)} approval threshold`,
      input: {},
    });
  }

  for (const call of calls) {
    if (decisionFor(decisions, call.id) !== undefined) continue;
    const gates = gatesForCall(call, gate);
    if (gates.length === 0) continue;
    const inSomebodysName =
      gate.asPerson !== undefined && gates.includes("as_person") ? `, as ${gate.asPerson}` : "";
    items.push({
      key: call.id,
      name: call.name,
      gates,
      detail: `tool "${call.name}" (${gates.join(", ")}${inSomebodysName})`,
      input: call.input,
    });
  }

  if (items.length === 0) return null;

  const gates: GatedAction[] = [];
  for (const item of items) {
    for (const action of item.gates) if (!gates.includes(action)) gates.push(action);
  }

  return {
    items,
    gates,
    summary: `approval needed before this run continues: ${items.map((i) => i.detail).join("; ")}`,
  };
}

/** The same approvals-inbox effect the review gate emits, so there is one inbox. */
export function pendingApprovalEffect(pending: PendingApproval): {
  readonly type: "request_approval";
  readonly gates: readonly GatedAction[];
  readonly summary: string;
} {
  return { type: "request_approval", gates: pending.gates, summary: pending.summary };
}
