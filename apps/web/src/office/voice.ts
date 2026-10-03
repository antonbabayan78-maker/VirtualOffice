/**
 * Whose voice a piece of work is in, worded once.
 *
 * An office where you cannot tell that something was written in somebody's
 * voice is an office nobody can trust, so the label appears wherever that
 * employee's name does: the board, the trays, the approvals inbox, the canvas.
 * Four screens wording it four ways would be four chances to word it wrongly,
 * which is why the sentence lives here and not in any of them.
 *
 * **Nobody is named until there is actually a voice.** Standing in for somebody
 * with no card yet is an intention; the voice is switched off is a decision.
 * In both cases the work reads as this employee's own, because it is.
 */
import type { Employee } from "@vo/core";

/** The real person this employee is writing as, or null when they write as themselves. */
export function voiceOf(employee: Employee | undefined): string | null {
  const standing = employee?.understudy ?? null;
  if (standing === null || !standing.enabled || standing.card === null) return null;
  return standing.person;
}

/** The label itself, or null when there is nothing to say. */
export function inTheirVoice(employee: Employee | undefined): string | null {
  const person = voiceOf(employee);
  return person === null ? null : `in ${person}'s voice`;
}
