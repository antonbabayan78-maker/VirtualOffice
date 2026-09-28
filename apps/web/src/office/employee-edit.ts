/**
 * The choices an employee drawer offers.
 *
 * Both lists are derived rather than written down: the models come from the
 * registry the runtime prices work against, and the supervisors come from the
 * office itself. A list typed out here would drift from what the system will
 * actually accept, and the drawer would offer choices that fail on save.
 */
import type { Employee } from "@vo/core";
import { defaultModelRegistry } from "@vo/llm/registry";

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly tier: string;
}

/** Every model an office may put an employee on. */
export function availableModels(): readonly ModelChoice[] {
  return defaultModelRegistry()
    .list()
    .map((spec) => ({
      provider: spec.provider,
      model: spec.id,
      label: spec.displayName,
      tier: spec.tier,
    }));
}

/**
 * Who this employee could report to: anyone else in the office who is still
 * working. Core refuses the rest on save; the drawer simply does not offer them.
 */
export function supervisorChoices(
  employees: readonly Employee[],
  self: Employee,
): readonly Employee[] {
  return employees.filter((candidate) => candidate.id !== self.id && candidate.status === "active");
}
