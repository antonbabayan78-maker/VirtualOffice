/**
 * How a turn finds the model the employee was given.
 *
 * An employee's `llm` has always named a provider and a model, and until now
 * only the model reached the wire: the provider was whatever the process had
 * been built with. That was true while every office called one service. An
 * office that has its own services — a hosted one, a box in the company
 * network — has to call the one the employee names, or setting it on the canvas
 * means nothing.
 *
 * **The lookup is handed in, not built here.** Resolving a name means reading
 * the office's services and fetching a key, which this package has no business
 * doing: it would need storage, the vault and an HTTP client. The worker and the
 * CLI know those things and pass the answer in, the same way metering is.
 *
 * **Nothing found means the provider the turn was built with.** An office with
 * no services runs exactly as it did before there were any. A name the office
 * does not know falls back the same way — and the lookup, which is the thing
 * that knows what the office has, is where that is worth saying out loud.
 */
import type { LlmProvider } from "@vo/llm";

export interface ProviderRef {
  /** The service's name, as the employee's `llm.provider` says it. */
  readonly provider: string;
  readonly model: string;
}

/**
 * Answered at once, or after a request.
 *
 * Resolving a name means reading the office's services and fetching a key,
 * which a worker does over the API. A lookup that had to answer immediately
 * would have to hold both in memory for the life of the process and would never
 * notice either changing — a service switched off on the canvas has to take
 * effect on the next turn, not on the next restart.
 */
export type ProviderLookup = (ref: ProviderRef) => LlmProvider | null | Promise<LlmProvider | null>;
