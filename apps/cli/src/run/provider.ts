/**
 * Which model backs `vo run`.
 *
 * A rehearsal uses a scripted provider that calls nothing: it proves the office
 * file parses, the schedule lets work through, the review loop closes and the
 * accounting adds up, without spending anything. Useful before a real run, and
 * the only way to try an office with no key to hand.
 */
import { createAnthropicProvider, rehearsalProvider, type LlmProvider } from "@vo/llm";

export interface RunProviderOptions {
  readonly dryRun: boolean;
  readonly apiKey: string | undefined;
}

export function createRunProvider(options: RunProviderOptions): LlmProvider {
  if (options.dryRun) return rehearsalProvider();
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    throw new Error(
      "no model to run with: set ANTHROPIC_API_KEY, or pass --dry-run to rehearse without calling one",
    );
  }
  return createAnthropicProvider({ apiKey: options.apiKey });
}
