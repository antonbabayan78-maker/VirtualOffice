/**
 * LLM configuration for an employee: primary provider/model, sampling params and an
 * ordered fallback chain. The llm package resolves these against the model registry.
 */
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface LlmParams {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface LlmConfig extends ModelRef {
  readonly params: LlmParams;
  readonly fallbacks: readonly ModelRef[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseModelRef(
  input: unknown,
  prefix: string,
): { ref?: ModelRef; errors: ValidationError[] } {
  const at = (field: string): string => (prefix.length > 0 ? `${prefix}.${field}` : field);
  if (!isRecord(input))
    return { errors: [{ path: prefix, message: "must be an object with provider and model" }] };
  const errors: ValidationError[] = [];
  const provider = input["provider"];
  const model = input["model"];
  if (!nonBlank(provider))
    errors.push({ path: at("provider"), message: "must be a non-empty string" });
  if (!nonBlank(model)) errors.push({ path: at("model"), message: "must be a non-empty string" });
  if (!nonBlank(provider) || !nonBlank(model)) return { errors };
  return { ref: { provider: provider.trim(), model: model.trim() }, errors };
}

function parseParams(input: unknown): { params: LlmParams; errors: ValidationError[] } {
  if (input === undefined) return { params: {}, errors: [] };
  if (!isRecord(input))
    return { params: {}, errors: [{ path: "params", message: "must be an object" }] };
  const errors: ValidationError[] = [];
  const params: { temperature?: number; maxOutputTokens?: number } = {};
  const t = input["temperature"];
  if (t !== undefined) {
    if (typeof t === "number" && t >= 0 && t <= 2) params.temperature = t;
    else errors.push({ path: "params.temperature", message: "must be a number between 0 and 2" });
  }
  const m = input["maxOutputTokens"];
  if (m !== undefined) {
    if (typeof m === "number" && Number.isInteger(m) && m > 0) params.maxOutputTokens = m;
    else errors.push({ path: "params.maxOutputTokens", message: "must be a positive integer" });
  }
  return { params, errors };
}

export function parseLlmConfig(input: unknown): Result<LlmConfig> {
  if (!isRecord(input)) return err([{ path: "", message: "llm config must be an object" }]);
  const errors: ValidationError[] = [];

  const primary = parseModelRef(input, "");
  errors.push(...primary.errors);

  const params = parseParams(input["params"]);
  errors.push(...params.errors);

  const fallbacks: ModelRef[] = [];
  const rawFallbacks = input["fallbacks"];
  if (rawFallbacks !== undefined) {
    if (!Array.isArray(rawFallbacks)) {
      errors.push({ path: "fallbacks", message: "must be a list of { provider, model }" });
    } else {
      rawFallbacks.forEach((f: unknown, i) => {
        const parsed = parseModelRef(f, `fallbacks[${String(i)}]`);
        errors.push(...parsed.errors);
        if (parsed.ref) fallbacks.push(parsed.ref);
      });
    }
  }

  if (errors.length > 0 || !primary.ref) return err(errors);
  return ok({ ...primary.ref, params: params.params, fallbacks });
}
