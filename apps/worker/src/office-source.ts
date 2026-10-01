/**
 * Where a worker reads the office it schedules from.
 *
 * Over the API, not out of a database: the server is the only writer, so a
 * worker that read storage directly would be a second one, and the two would
 * disagree about a task the moment somebody moved it on the canvas.
 *
 * An office it cannot reach schedules nothing rather than throwing. Throwing
 * here would abandon the whole tick, including the jobs already queued and the
 * leases waiting to be recovered — a network blip would stop work that needs no
 * network. Nothing due is the truthful answer when nothing is known to be due.
 */
import type { ApiClient } from "@vo/api-client";
import { officeSnapshot, type SchedulerSnapshot } from "@vo/orchestrator";

export interface OfficeSourceOptions {
  readonly api: ApiClient;
  readonly officeId: string;
  /** Told why a tick had nothing to schedule, so silence is never mistaken for calm. */
  readonly onProblem?: (message: string) => void;
}

const NOTHING: SchedulerSnapshot = {
  offices: [],
  departments: [],
  employees: [],
  tasks: [],
  recurring: [],
};

export function officeSource(options: OfficeSourceOptions): () => Promise<SchedulerSnapshot> {
  return async () => {
    const loaded = await options.api.loadOffice(options.officeId);
    if (!loaded.ok) {
      const detail =
        loaded.kind === "validation"
          ? loaded.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
          : loaded.kind === "conflict"
            ? "the office changed while it was being read"
            : loaded.kind === "unauthorized"
              ? "this office does not accept our token"
              : loaded.message;
      options.onProblem?.(`could not read office ${options.officeId}: ${detail}`);
      return NOTHING;
    }

    // What has been spent, for the budgets. A summary rather than the rows:
    // a tick needs a handful of numbers to decide what to queue.
    //
    // An office whose figures cannot be read schedules as it always did, for
    // the same reason the whole function does above — a network blip must not
    // stop work that needs no network. Nothing known spent is the truthful
    // answer, and it errs towards working rather than towards stopping.
    const spend = await options.api.officeSpend(options.officeId, "day");
    if (!spend.ok) {
      options.onProblem?.(
        `could not read spend for office ${options.officeId}: ${
          spend.kind === "transport" ? spend.message : "the office refused the question"
        }`,
      );
    }

    return officeSnapshot({
      office: loaded.value.office,
      departments: loaded.value.departments,
      employees: loaded.value.employees,
      tasks: loaded.value.tasks,
      ...(spend.ok ? { spend: spend.value } : {}),
    });
  };
}
