/**
 * Minimal Result type for validation and domain operations.
 * Domain code never throws for expected failures; it returns `err(...)`.
 */
export interface ValidationError {
  path: string;
  message: string;
}

export type Result<T, E = ValidationError[]> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { readonly ok: false; readonly error: E } {
  return !r.ok;
}

/** Unwraps a success or throws; intended for tests and boundaries that already validated. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap on error result: ${describeError(r.error)}`);
}

function describeError(error: unknown): string {
  if (Array.isArray(error)) {
    return error
      .map((e: unknown) => (isValidationError(e) ? `${e.path}: ${e.message}` : JSON.stringify(e)))
      .join("; ");
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function isValidationError(e: unknown): e is ValidationError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ValidationError).path === "string" &&
    typeof (e as ValidationError).message === "string"
  );
}

/** Prefixes every error path, for nesting validation results. */
export function prefixErrors(prefix: string, errors: ValidationError[]): ValidationError[] {
  return errors.map((e) => ({
    path: e.path === "" ? prefix : `${prefix}.${e.path}`,
    message: e.message,
  }));
}
