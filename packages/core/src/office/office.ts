/**
 * Office: the tenant. Owns the schedule that gates when its employees may work.
 * Budget, memory policy and storage references are added by their own tasks.
 */
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { parseSchedule, type Schedule } from "./schedule.js";

declare const officeIdBrand: unique symbol;
export type OfficeId = string & { readonly [officeIdBrand]: true };

export interface Office {
  readonly id: OfficeId;
  readonly name: string;
  readonly schedule: Schedule;
  /** Incremented on every configuration change; snapshots key off it. */
  readonly configVersion: number;
  readonly createdAt: Date;
}

export interface CreateOfficeInput {
  readonly name: string;
  /** Defaults to 24/7. Accepts unvalidated input (e.g. from YAML or the API). */
  readonly schedule?: unknown;
}

export interface OfficeDeps {
  readonly id: () => OfficeId;
  readonly now: () => Date;
}

export const OFFICE_NAME_MAX_LENGTH = 100;

export function validateOfficeName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return err([{ path: "name", message: "must be a string" }]);
  const name = raw.trim();
  if (name.length === 0) return err([{ path: "name", message: "must not be empty" }]);
  if (name.length > OFFICE_NAME_MAX_LENGTH) {
    return err([
      { path: "name", message: `must be at most ${String(OFFICE_NAME_MAX_LENGTH)} characters` },
    ]);
  }
  return ok(name);
}

export function createOffice(input: CreateOfficeInput, deps: OfficeDeps): Result<Office> {
  const errors: ValidationError[] = [];

  const name = validateOfficeName(input.name);
  if (!name.ok) errors.push(...name.error);

  const schedule = parseSchedule(input.schedule ?? { kind: "always" });
  if (!schedule.ok) errors.push(...prefixErrors("schedule", schedule.error));

  if (errors.length > 0 || !name.ok || !schedule.ok) return err(errors);

  return ok({
    id: deps.id(),
    name: name.value,
    schedule: schedule.value,
    configVersion: 1,
    createdAt: deps.now(),
  });
}
