/**
 * Which model backs `vo run` when the office file names none.
 *
 * A rehearsal uses a scripted provider that calls nothing: it proves the office
 * file parses, the schedule lets work through, the review loop closes and the
 * accounting adds up, without spending anything. Useful before a real run, and
 * the only way to try an office with no key to hand.
 *
 * This is the fallback, not the choice. An employee who names one of the
 * office's own services is called on that service; this is what is used when
 * nobody said otherwise, which is still `provider: anthropic` for most people.
 */
import { createAnthropicProvider, rehearsalProvider, type LlmProvider } from "@vo/llm";

export interface RunProviderOptions {
  readonly dryRun: boolean;
  readonly apiKey: string | undefined;
}

const NO_KEY =
  "no model to run with: set ANTHROPIC_API_KEY, name a service in the office file," +
  " or pass --dry-run to rehearse without calling one";

/**
 * Stands in for a provider this process cannot build, and says so when asked.
 *
 * Refusing at the start would make an office file's `services:` block useless:
 * a run whose employees all name a model on this machine needs no Anthropic key
 * at all, and should not be stopped for the want of one it will never use. This
 * is the honest middle — the run proceeds, and the one turn that actually needs
 * the missing key fails with the reason.
 */
function unavailableProvider(reason: string): LlmProvider {
  const refuse = (): never => {
    throw new Error(reason);
  };
  return { id: "anthropic", complete: () => Promise.reject(new Error(reason)), stream: refuse };
}

export function createRunProvider(options: RunProviderOptions): LlmProvider {
  if (options.dryRun) return rehearsalProvider();
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    return unavailableProvider(NO_KEY);
  }
  return createAnthropicProvider({ apiKey: options.apiKey });
}
