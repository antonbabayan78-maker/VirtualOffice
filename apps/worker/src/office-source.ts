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
            : loaded.message;
      options.onProblem?.(`could not read office ${options.officeId}: ${detail}`);
      return NOTHING;
    }

    return officeSnapshot({
      office: loaded.value.office,
      departments: loaded.value.departments,
      employees: loaded.value.employees,
      tasks: loaded.value.tasks,
    });
  };
}
