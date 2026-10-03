/**
 * An office's services, as the things that make a call and price it.
 *
 * `LlmService` is what the owner wrote down; these are the two readings of it
 * that the rest of the office needs — a provider per service, keyed by the name
 * an employee's `llm.provider` says, and a registry that prices every model any
 * of them offers.
 *
 * **A key is fetched here and nowhere else.** The service names a variable or
 * refers to one the office is keeping; this is the one place either is turned
 * into the key itself, and the key never goes back into anything that is
 * stored, logged or sent to the canvas.
 *
 * **One bad service does not stop the office.** A service whose key is missing
 * is left out and said out loud, rather than built into a provider that answers
 * 401 to every call — a turn would spend all its attempts on a settled failure.
 */
import type { LlmService, ModelOffer } from "@vo/core";
import { openAiCompatibleProvider } from "../openai/openai-compatible.js";
import type { LlmProvider } from "../provider/types.js";
import { ANTHROPIC_MODELS } from "../registry/anthropic-models.js";
import {
  ModelRegistry,
  type ModelRegistryOptions,
  type ModelSpec,
} from "../registry/model-registry.js";

export interface ServiceProvidersDeps {
  /** Where a `tokenEnv` is looked up. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so a test never opens a socket. */
  readonly fetch?: typeof fetch;
  /**
   * Turns a `vault://…` reference into the key. Absent where nothing can read
   * the vault — a worker without one asks the office instead.
   */
  readonly secret?: (ref: string) => Promise<string | null>;
  /**
   * Builds the office's own Anthropic provider. Passed in rather than built
   * here so this module carries no vendor SDK, and so a deployment that has no
   * Anthropic key simply does not pass one.
   */
  readonly anthropic?: (service: LlmService, apiKey: string | null) => LlmProvider;
  /** How long to wait on a call; a local model can take minutes over one answer. */
  readonly timeoutMs?: number;
  /** Told why a service was left out, so silence is never mistaken for health. */
  readonly onProblem?: (message: string) => void;
}

/** The providers an office can call, by the name an employee asks for. */
export type ProviderSet = ReadonlyMap<string, LlmProvider>;

async function keyFor(
  service: LlmService,
  deps: ServiceProvidersDeps,
): Promise<{ readonly key: string | null } | { readonly missing: string }> {
  if (service.tokenEnv !== null) {
    const key = deps.env?.[service.tokenEnv];
    if (key === undefined || key.length === 0) {
      return { missing: `the variable ${service.tokenEnv} it names holds nothing` };
    }
    return { key };
  }
  if (service.secretRef !== null) {
    if (deps.secret === undefined) {
      return { missing: `nothing here can read ${service.secretRef}` };
    }
    const key = await deps.secret(service.secretRef);
    if (key === null || key.length === 0) {
      return { missing: `the office no longer holds ${service.secretRef}` };
    }
    return { key };
  }
  // A model on somebody's own machine, which is the case that needs none.
  return { key: null };
}

export async function providersFor(
  services: readonly LlmService[],
  deps: ServiceProvidersDeps = {},
): Promise<ProviderSet> {
  const providers = new Map<string, LlmProvider>();
  for (const service of services) {
    if (!service.enabled) continue;

    const credential = await keyFor(service, deps);
    if ("missing" in credential) {
      deps.onProblem?.(`service "${service.name}" is not available: ${credential.missing}`);
      continue;
    }

    if (service.kind === "anthropic") {
      if (deps.anthropic === undefined) {
        deps.onProblem?.(
          `service "${service.name}" is not available: this process was not given a way to call Anthropic`,
        );
        continue;
      }
      providers.set(service.name, deps.anthropic(service, credential.key));
      continue;
    }

    if (service.baseUrl === null) {
      deps.onProblem?.(`service "${service.name}" is not available: it has no address`);
      continue;
    }

    providers.set(
      service.name,
      openAiCompatibleProvider({
        id: service.name,
        baseUrl: service.baseUrl,
        ...(credential.key === null ? {} : { apiKey: credential.key }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      }),
    );
  }
  return providers;
}

/**
 * How much context to assume when a service never said.
 *
 * Guessed low on purpose: too high and a turn sends a prompt the server refuses
 * outright, where too low only makes it compact sooner than it had to. The
 * discover route fills in the real figures where a service reports them.
 */
const ASSUMED_CONTEXT_WINDOW = 32_768;
const ASSUMED_MAX_OUTPUT = 4_096;

function isLocal(baseUrl: string | null): boolean {
  if (baseUrl === null) return false;
  try {
    return new URL(baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

function specOf(service: LlmService, model: ModelOffer): ModelSpec | null {
  const pricing = model.pricing;
  // No price, no spec: an unpriced call must be reported as unpriced, and a
  // registry that answered zero would quietly call it free.
  if (pricing === undefined) return null;
  const contextWindow = model.contextWindow ?? ASSUMED_CONTEXT_WINDOW;
  return {
    provider: service.name,
    id: model.id,
    displayName: model.displayName ?? model.id,
    contextWindow,
    maxOutputTokens: Math.min(model.maxOutputTokens ?? ASSUMED_MAX_OUTPUT, contextWindow),
    tier: isLocal(service.baseUrl) ? "local" : "balanced",
    capabilities: {
      tools: true,
      streaming: true,
      // Only where the owner priced a cached read: the office reads this to
      // decide whether marking cache breakpoints is worth anything.
      promptCaching: pricing.cacheReadPerMTok !== undefined,
      vision: false,
      thinking: false,
      batch: false,
    },
    pricing: {
      inputPerMTok: pricing.inputPerMTok,
      outputPerMTok: pricing.outputPerMTok,
      // Nothing said means nothing cheaper: a cached read costs the input price.
      cacheReadPerMTok: pricing.cacheReadPerMTok ?? pricing.inputPerMTok,
      // None of these services bills for writing a cache entry.
      cacheWritePerMTok: 0,
    },
  };
}

export interface ServiceRegistryOptions extends ModelRegistryOptions {
  readonly onProblem?: (message: string) => void;
}

/**
 * The models the office knows, plus the ones its services offer.
 *
 * Every service is read, switched off or not: usage is priced long after the
 * call, sometimes after somebody turned the service off, and what it cost then
 * did not change.
 */
export function registryFor(
  services: readonly LlmService[],
  options: ServiceRegistryOptions = {},
): ModelRegistry {
  const { onProblem, ...registryOptions } = options;
  const registry = new ModelRegistry(ANTHROPIC_MODELS, registryOptions);
  for (const service of services) {
    for (const model of service.models) {
      const spec = specOf(service, model);
      if (spec === null) continue;
      if (registry.has({ provider: spec.provider, model: spec.id })) {
        // Refused rather than overwritten: otherwise adding a service would
        // rename what a past call cost, and `register` would throw mid-tick.
        onProblem?.(
          `service "${service.name}" offers "${model.id}", which this office already prices; its own price is ignored`,
        );
        continue;
      }
      registry.register(spec);
    }
  }
  return registry;
}
