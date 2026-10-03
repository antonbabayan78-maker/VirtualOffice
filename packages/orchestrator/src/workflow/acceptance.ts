/**
 * What work has to achieve, and whether it did.
 *
 * Done used to mean only that somebody said yes. A definition of done is the
 * list the reviewer is actually asked about, so an approval says which of them
 * it verified rather than expressing a general opinion of the work.
 *
 * A criterion the reviewer did not mention is not met. Silence is not assent —
 * the same reason `agent-turn` reads `approved === true` strictly rather than
 * accepting anything truthy. The cost of that strictness is that a reviewer
 * must answer the list; the benefit is that done means what it says.
 *
 * An office that has defined no criteria is not made stricter by any of this:
 * nothing asked, nothing outstanding, and every existing office behaves exactly
 * as it did.
 */

/**
 * Which list applies is a core rule — the engine, the office and the board all
 * have to agree about it — and is re-exported here so this module still reads
 * as the one place acceptance is reasoned about.
 */
export { acceptanceCriteriaFor } from "@vo/core";

/** Trimmed, because a model will pad an answer and nobody means the spaces. */
const normalise = (value: string): string => value.trim();

/** Everything asked for that was not claimed, in the order it was asked. */
export function unmetCriteria(
  criteria: readonly string[],
  met: readonly string[],
): readonly string[] {
  if (criteria.length === 0) return [];
  const claimed = new Set(met.map(normalise));
  return criteria.filter((criterion) => !claimed.has(normalise(criterion)));
}
