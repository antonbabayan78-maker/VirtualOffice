/**
 * Categories of consequential action a task can involve. A department's review
 * policy gates the categories it wants a person to sign off, and a task records
 * which ones its work actually touched.
 *
 * Whether a particular action falls into a category — how much spend is "spend",
 * which connectors count as an external send — is decided by whoever records it
 * on the task, not here. This module only fixes the vocabulary both sides use.
 */
export const GATED_ACTIONS = ["spend", "external_send", "deploy", "delete"] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

export function isGatedAction(value: unknown): value is GatedAction {
  return typeof value === "string" && (GATED_ACTIONS as readonly string[]).includes(value);
}
