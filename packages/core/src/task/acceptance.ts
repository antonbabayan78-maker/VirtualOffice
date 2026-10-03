/**
 * Which list a piece of work is judged against.
 *
 * A task states its own only when its work needs something the department does
 * not always ask for — at which point it is stating the whole list, not adding
 * to one, because a reviewer answering two lists would have to be told which
 * took precedence and nothing in the office says.
 *
 * In core because it is a rule about what work is for, and because everybody
 * has to agree about it: the engine applies it, the office hands it to a
 * reviewer, and the board shows it. A browser cannot import the orchestrator,
 * which is where this used to live.
 */
export function acceptanceCriteriaFor(
  taskCriteria: readonly string[],
  departmentCriteria: readonly string[],
): readonly string[] {
  return taskCriteria.length > 0 ? taskCriteria : departmentCriteria;
}
