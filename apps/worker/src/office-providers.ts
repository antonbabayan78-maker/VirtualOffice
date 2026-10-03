/**
 * Which model a worker actually calls, on behalf of the office it serves.
 *
 * An employee's `llm.provider` names one of the office's services. Resolving
 * that name means two things this process cannot do on its own: reading what
 * services the office has, and getting the key for one. Both come over the API,
 * the way the office's connectors and checkpoints do — the office is the only
 * reader of its own storage and the only thing that can open its vault.
 *
 * It asks each time rather than remembering, exactly as `officeTools` does: a
 * service added, repriced or switched off on the canvas has to take effect on
 * the next turn and not on the next restart. What it does remember is the set
 * of providers, for as long as the office's answer is the same one — otherwise
 * every call would fetch a key again.
 *
 * An office that cannot be reached resolves nothing, which the turn reads as
 * "use the provider you were built with". That is what a worker did before any
 * of this existed, and it errs towards doing the work rather than towards
 * stopping — said out loud each time, because a run on the wrong model is the
 * kind of thing nobody notices until the bill.
 */
import type { ApiClient } from "@vo/api-client";
import type { LlmService } from "@vo/core";
import {
  providersFor,
  registryFor,
  type LlmProvider,
  type ModelRegistry,
  type ProviderSet,
} from "@vo/llm";
import type { ProviderLookup, ProviderRef } from "@vo/orchestrator";

export interface OfficeProvidersOptions {
  /** Where a service's `tokenEnv` is looked up; this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so a whole tick can be driven offline, as the API client's is. */
  readonly fetch?: typeof globalThis.fetch;
  /** Builds the office's own Anthropic provider, where this deployment has one. */
  readonly anthropic?: (service: LlmService, apiKey: string | null) => LlmProvider;
  /** Told why a service was left out, so a run on the wrong model is never silent. */
  readonly onProblem?: (message: string) => void;
}

export interface OfficeProviders {
  /** The provider the employee named, or null for "the one you were built with". */
  readonly lookup: ProviderLookup;
  /**
   * Every model the office prices, as of the last time it was asked — which is
   * when the turn resolved its provider, a moment before the call being priced.
   *
   * Read synchronously because metering wraps a provider rather than awaiting
   * anything, and a price list that had to be fetched would mean a round trip
   * inside every recorded call.
   */
  readonly prices: () => ModelRegistry;
}

/** What this office's services amount to, as one string: a set is good while it holds. */
function signatureOf(services: readonly LlmService[]): string {
  return JSON.stringify(
    services.map((service) => [
      service.id,
      service.name,
      service.kind,
      service.baseUrl,
      service.tokenEnv,
      service.secretRef,
      service.enabled,
      service.models,
    ]),
  );
}

export function officeProviders(
  api: ApiClient,
  officeId: string,
  options: OfficeProvidersOptions = {},
): OfficeProviders {
  let held: {
    readonly of: string;
    readonly providers: ProviderSet;
    readonly registry: ModelRegistry;
  } | null = null;

  // What the office knows before it has been asked anything: metering has to
  // work on the very first call, which happens before any service is known.
  let prices = registryFor([]);

  const current = async (): Promise<typeof held> => {
    const listed = await api.listServices(officeId);
    if (!listed.ok) {
      options.onProblem?.(`the office did not say which AI services it has`);
      return null;
    }
    const of = signatureOf(listed.value);
    if (held !== null && held.of === of) return held;

    held = {
      of,
      providers: await providersFor(listed.value, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.anthropic === undefined ? {} : { anthropic: options.anthropic }),
        // Asked of the office, because the vault lives where the blobs are and
        // a worker has no storage at all. The office answers a bearer token
        // only, which is what this process holds and a browser does not.
        secret: async (ref) => {
          const service = listed.value.find((one) => one.secretRef === ref);
          if (service === undefined) return null;
          const key = await api.serviceCredential(service.id);
          if (!key.ok) {
            options.onProblem?.(`the office would not hand over the key for "${service.name}"`);
            return null;
          }
          return key.value;
        },
        ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      }),
      // Every service, switched off or not: a call is priced long after it was
      // made, sometimes after somebody turned the service off, and what it
      // cost then did not change.
      registry: registryFor(listed.value, {
        ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      }),
    };
    prices = held.registry;
    return held;
  };

  return {
    lookup: async (ref: ProviderRef) => (await current())?.providers.get(ref.provider) ?? null,
    prices: () => prices,
  };
}
