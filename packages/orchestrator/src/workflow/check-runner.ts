/**
 * The seam between the automated reviewer policy and whatever actually runs a
 * check — a test suite, a lint run, a validation script. The policy never runs
 * anything: it asks for a check by id and decides on the report it gets back,
 * so the workflow engine stays pure and tests never execute a real command.
 *
 * A check is named, not spelled out as a command, so an office configuration
 * cannot smuggle in an arbitrary shell line; resolving a name to something
 * runnable (and sandboxing it) belongs to the layer that owns the runner.
 */
import type { Task } from "@vo/core";

export type CheckOutcome = "passed" | "failed" | "errored";

export interface CheckReport {
  readonly checkId: string;
  readonly outcome: CheckOutcome;
  /** Test or script output: what makes a change request actionable. */
  readonly output: string;
}

export interface CheckRunner {
  run(checkId: string, task: Task): Promise<CheckReport>;
}

/** A runner with canned reports, for tests and for dry runs. */
export function fixedCheckRunner(reports: Readonly<Record<string, CheckReport>>): CheckRunner {
  return {
    run(checkId) {
      const report = reports[checkId];
      if (report === undefined) {
        return Promise.reject(new Error(`no check registered as "${checkId}"`));
      }
      return Promise.resolve(report);
    },
  };
}

/**
 * Runs a check and always comes back with a report. A runner that throws, or
 * answers about some other check, yields `errored` — never a pass — so a broken
 * checker escalates instead of waving work through.
 */
export async function reportCheck(
  runner: CheckRunner,
  checkId: string,
  task: Task,
): Promise<CheckReport> {
  try {
    const report = await runner.run(checkId, task);
    if (report.checkId !== checkId) {
      return {
        checkId,
        outcome: "errored",
        output: `the runner reported on check "${report.checkId}" but "${checkId}" was requested`,
      };
    }
    return report;
  } catch (error) {
    return {
      checkId,
      outcome: "errored",
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
