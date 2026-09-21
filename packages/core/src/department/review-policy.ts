/**
 * Review policy: how finished work in a department gets approved.
 * The workflow engine (P1) interprets these; here we only define and validate them.
 * Pipeline, automated-reviewer and human-gate kinds are added with the engine.
 */
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

export type ReviewPolicy =
  | { readonly kind: "direct" }
  | { readonly kind: "manager"; readonly maxIterations: number }
  | { readonly kind: "peer"; readonly maxIterations: number }
  | { readonly kind: "quorum"; readonly required: number; readonly maxIterations: number };

export const DEFAULT_MAX_ITERATIONS = 3;
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  kind: "manager",
  maxIterations: DEFAULT_MAX_ITERATIONS,
};

const KINDS = ["direct", "manager", "peer", "quorum"] as const;

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

  if (errors.length > 0) return err(errors);
  if (kind === "manager") return ok({ kind: "manager", maxIterations: iterations.value });
  return ok({ kind: "peer", maxIterations: iterations.value });
}
