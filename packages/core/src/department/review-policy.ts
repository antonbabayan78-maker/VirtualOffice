/**
 * Review policy: how finished work in a department gets approved.
 * The workflow engine (P1) interprets these; here we only define and validate them.
 * Automated-reviewer and human-gate kinds are added with the engine.
 */
import type { EmployeeId } from "../employee/employee.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

/**
 * One step of a multi-stage pipeline, e.g. Draft -> QA -> Legal -> Publish.
 * The worker does that step's work and the reviewers sign it off; a stage with
 * no named reviewers is signed off by the supervisor, or failing that the owner.
 */
export interface ReviewStage {
  readonly name: string;
  /** Who does this stage's work; null keeps whoever the task is already with. */
  readonly workerId: EmployeeId | null;
  readonly reviewerIds: readonly EmployeeId[];
  /** Approvals needed to clear this stage; at most one per named reviewer. */
  readonly required: number;
}

export type ReviewPolicy =
  | { readonly kind: "direct" }
  | { readonly kind: "manager"; readonly maxIterations: number }
  | { readonly kind: "peer"; readonly maxIterations: number }
  | { readonly kind: "quorum"; readonly required: number; readonly maxIterations: number }
  | { readonly kind: "automated"; readonly checkId: string; readonly maxIterations: number }
  | {
      readonly kind: "pipeline";
      readonly stages: readonly ReviewStage[];
      readonly maxIterations: number;
    };

export const DEFAULT_MAX_ITERATIONS = 3;
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  kind: "manager",
  maxIterations: DEFAULT_MAX_ITERATIONS,
};

const KINDS = ["direct", "manager", "peer", "quorum", "pipeline", "automated"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(
  value: unknown,
  path: string,
  fallback?: number,
): { value: number; errors: ValidationError[] } {
  if (value === undefined && fallback !== undefined) return { value: fallback, errors: [] };
  if (typeof value === "number" && Number.isInteger(value) && value > 0)
    return { value, errors: [] };
  return { value: Number.NaN, errors: [{ path, message: "must be a positive integer" }] };
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseStages(input: unknown): { value: readonly ReviewStage[]; errors: ValidationError[] } {
  if (!Array.isArray(input) || input.length === 0) {
    return {
      value: [],
      errors: [{ path: "stages", message: "a pipeline needs at least one stage, in order" }],
    };
  }
  const errors: ValidationError[] = [];
  const stages: ReviewStage[] = [];
  const seen = new Set<string>();

  input.forEach((raw: unknown, i) => {
    const at = `stages[${String(i)}]`;
    if (!isRecord(raw)) {
      errors.push({ path: at, message: "must be an object" });
      return;
    }

    const name = nonEmptyId(raw["name"]) ?? "";
    if (name.length === 0) errors.push({ path: `${at}.name`, message: "must be a non-empty name" });
    else if (seen.has(name)) {
      errors.push({ path: `${at}.name`, message: `duplicate stage name "${name}"` });
    }
    seen.add(name);

    const rawReviewers = raw["reviewerIds"] ?? [];
    const reviewerIds: EmployeeId[] = [];
    if (!Array.isArray(rawReviewers)) {
      errors.push({ path: `${at}.reviewerIds`, message: "must be a list of employee ids" });
    } else {
      for (const entry of rawReviewers as readonly unknown[]) {
        const id = nonEmptyId(entry);
        if (id === null) {
          errors.push({ path: `${at}.reviewerIds`, message: "must be a list of employee ids" });
          break;
        }
        reviewerIds.push(id as EmployeeId);
      }
    }

    const rawWorker = raw["workerId"] ?? null;
    const workerId = rawWorker === null ? null : nonEmptyId(rawWorker);
    if (rawWorker !== null && workerId === null) {
      errors.push({ path: `${at}.workerId`, message: "must be an employee id or null" });
    }

    if (new Set(reviewerIds).size !== reviewerIds.length) {
      errors.push({ path: `${at}.reviewerIds`, message: "lists the same reviewer twice" });
    }
    if (workerId !== null && reviewerIds.includes(workerId as EmployeeId)) {
      errors.push({
        path: `${at}.reviewerIds`,
        message: "a stage's worker cannot review their own work",
      });
    }

    const required = positiveInt(raw["required"], `${at}.required`, 1);
    errors.push(...required.errors);
    const ceiling = Math.max(reviewerIds.length, 1);
    if (!Number.isNaN(required.value) && required.value > ceiling) {
      errors.push({
        path: `${at}.required`,
        message:
          reviewerIds.length === 0
            ? "a stage that names no reviewers is signed off by one person"
            : `needs at most ${String(ceiling)} approvals, one per named reviewer`,
      });
    }

    stages.push({
      name,
      workerId: workerId as EmployeeId | null,
      reviewerIds,
      required: required.value,
    });
  });

  return { value: stages, errors };
}

export function parseReviewPolicy(input: unknown): Result<ReviewPolicy> {
  if (input === undefined) return ok(DEFAULT_REVIEW_POLICY);
  if (!isRecord(input)) return err([{ path: "", message: "review policy must be an object" }]);
  const kind = input["kind"];
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return err([{ path: "kind", message: `must be one of ${KINDS.join(", ")}` }]);
  }
  if (kind === "direct") return ok({ kind: "direct" });

  const errors: ValidationError[] = [];
  const iterations = positiveInt(input["maxIterations"], "maxIterations", DEFAULT_MAX_ITERATIONS);
  errors.push(...iterations.errors);

  if (kind === "quorum") {
    const required = positiveInt(input["required"], "required");
    errors.push(...required.errors);
    if (errors.length > 0) return err(errors);
    return ok({ kind: "quorum", required: required.value, maxIterations: iterations.value });
  }

  if (kind === "automated") {
    const checkId = nonEmptyId(input["checkId"]);
    if (checkId === null) {
      errors.push({ path: "checkId", message: "must name the check that decides" });
    }
    if (checkId === null || errors.length > 0) return err(errors);
    return ok({ kind: "automated", checkId, maxIterations: iterations.value });
  }

  if (kind === "pipeline") {
    const stages = parseStages(input["stages"]);
    errors.push(...stages.errors);
    if (errors.length > 0) return err(errors);
    return ok({ kind: "pipeline", stages: stages.value, maxIterations: iterations.value });
  }

  if (errors.length > 0) return err(errors);
  if (kind === "manager") return ok({ kind: "manager", maxIterations: iterations.value });
  return ok({ kind: "peer", maxIterations: iterations.value });
}
