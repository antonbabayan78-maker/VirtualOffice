/**
 * Manager review policy (plan §3, scenario 2).
 *
 * Submitted work goes to the department's supervisor, or to the office owner
 * when the department has none. The review mechanics themselves (rounds,
 * reviewer authority, approval, escalation cap) are shared with the other
 * review policies in review-common.ts.
 */
import {
  approveReview,
  rejectPolicyEvent,
  requestChangesOrEscalate,
  submitForReview,
  supervisorChoice,
} from "./review-common.js";
import type { PolicyHandler } from "./workflow-types.js";

export { reviewRounds } from "./review-common.js";

export const MANAGER_POLICY_HANDLER: PolicyHandler = {
  kind: "manager",
  handle(task, event, context) {
    switch (event.type) {
      case "submit": {
        const choice = supervisorChoice(task, context);
        if (!choice.ok) return choice;
        return submitForReview(task, event, context, choice.value);
      }
      case "approve":
        return approveReview(task, event, context);
      case "request_changes":
        return requestChangesOrEscalate(task, event, context, event.reason);
      case "check_reported":
      case "gate_decided":
        return rejectPolicyEvent("manager", event);
    }
  },
};
