/**
 * A usage event as the office keeps it.
 *
 * `@vo/telemetry` decides what a usage event means and what it costs; this is
 * the row a store can hold and a repository can filter. It lives here for the
 * same reason `MemoryItem` and `Skill` do: storage depends on `@vo/core` and
 * nothing else, so anything storage persists is defined here whatever package
 * owns its behaviour.
 *
 * **The event itself is opaque.** Core promotes the three fields somebody
 * actually filters on — the office, the task, the person — and keeps the rest
 * as data it never reads, the way a connector's configuration is kept. A new
 * kind of usage event therefore never touches core or storage.
 *
 * Only what a query needs is promoted. The department is not: "what did this
 * department spend" is answered by the tasks or the people in it, and a fourth
 * column that duplicates the event would be a fourth thing to keep in step.
 */
import type { OfficeId } from "../office/office.js";
import type { EmployeeId } from "../employee/employee.js";
import type { TaskId } from "../task/task.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

export interface UsageRecord {
  readonly id: string;
  readonly officeId: OfficeId;
  /** Null for a call not spent on a piece of work. */
  readonly taskId: TaskId | null;
  readonly employeeId: EmployeeId | null;
  /** When the call finished, taken from the event rather than from arrival. */
  readonly at: Date;
  readonly event: Readonly<Record<string, unknown>>;
}

export interface UsageRecordDeps {
  readonly id: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optional = (raw: unknown): string | null =>
  typeof raw === "string" && raw.length > 0 ? raw : null;

/**
 * Builds the row from an event, or says why it cannot.
 *
 * The moment comes from the event, never from the clock: a row is written after
 * the call it measures, sometimes much later if the office could not be
 * reached, and stamping it on arrival would put the spend in the wrong day.
 */
export function usageRecordOf(
  event: Readonly<Record<string, unknown>>,
  deps: UsageRecordDeps,
): Result<UsageRecord> {
  const errors: ValidationError[] = [];
  if (!isRecord(event)) {
    return err([{ path: "event", message: "must be an object" }]);
  }

  const attribution = isRecord(event["attribution"]) ? event["attribution"] : {};
  const officeId = optional(attribution["officeId"]);
  if (officeId === null) {
    errors.push({ path: "attribution.officeId", message: "is required to file a usage event" });
  }

  const at = event["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) {
    errors.push({ path: "at", message: "must be the epoch milliseconds the call finished" });
  }

  if (errors.length > 0 || officeId === null || typeof at !== "number") return err(errors);

  return ok({
    id: deps.id(),
    officeId: officeId as OfficeId,
    taskId: optional(attribution["taskId"]) as TaskId | null,
    employeeId: optional(attribution["employeeId"]) as EmployeeId | null,
    at: new Date(at),
    event: { ...event },
  });
}
