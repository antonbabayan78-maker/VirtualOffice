/**
 * What a worker needs to be told before it can start.
 *
 * Everything is checked up front and reported together. A worker that starts
 * with half a configuration and discovers the rest on its first job has already
 * claimed that job, and failing it there looks like the office is broken rather
 * than like the worker was never told where to go.
 */
import { err, ok, type Result, type ValidationError } from "@vo/core";
import { DEFAULT_TICK_INTERVAL_MS } from "./index.js";

export interface WorkerConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly officeId: string;
  /** Run on a scripted provider that calls nothing and costs nothing. */
  readonly dryRun: boolean;
  readonly apiKey: string | undefined;
  readonly tickMs: number;
  readonly batchSize: number;
}

export const DEFAULT_BATCH_SIZE = 4;

type Env = Readonly<Record<string, string | undefined>>;

/** A positive number, or the default: a tick of NaN would spin. */
function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readWorkerConfig(env: Env): Result<WorkerConfig> {
  const errors: ValidationError[] = [];
  const required = (name: string): string => {
    const value = env[name] ?? "";
    if (value.length === 0) errors.push({ path: name, message: `${name} is required` });
    return value;
  };

  const baseUrl = required("VO_API_URL").replace(/\/+$/, "");
  const token = required("VO_API_TOKEN");
  const officeId = required("VO_OFFICE_ID");

  const dryRun = (env["VO_DRY_RUN"] ?? "") !== "";
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!dryRun && (apiKey === undefined || apiKey.length === 0)) {
    errors.push({
      path: "ANTHROPIC_API_KEY",
      message: "no model to work with: set ANTHROPIC_API_KEY, or set VO_DRY_RUN to rehearse",
    });
  }

  if (errors.length > 0) return err(errors);
  return ok({
    baseUrl,
    token,
    officeId,
    dryRun,
    apiKey,
    tickMs: positive(env["VO_TICK_MS"], DEFAULT_TICK_INTERVAL_MS),
    batchSize: Math.floor(positive(env["VO_BATCH_SIZE"], DEFAULT_BATCH_SIZE)),
  });
}
