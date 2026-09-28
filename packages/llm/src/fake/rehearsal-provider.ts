/**
 * A provider that answers every call the run loop can make, always favourably,
 * and calls nothing.
 *
 * This is what a rehearsal runs on: it proves an office file parses, the
 * schedule lets work through, the review loop closes and the accounting adds
 * up, without spending anything. It is also the only way to try an office with
 * no key to hand.
 *
 * It answers by looking at which tools it was offered rather than importing
 * their definitions, so it stays underneath the orchestrator that defines them.
 */
import { FakeLlmProvider, toolCall } from "./fake-provider.js";
import type { LlmProvider } from "../provider/types.js";

export function rehearsalProvider(): LlmProvider {
  return new FakeLlmProvider({
    // An office prices its models as anthropic ones, so answer as one.
    id: "anthropic",
    handler: (request) => {
      const tools = (request.tools ?? []).map((tool) => tool.name);
      if (tools.includes("review_verdict")) {
        return toolCall("review_verdict", { approved: true, reason: "rehearsal: approved" });
      }
      return toolCall("submit_work", { summary: "rehearsal: work submitted" });
    },
  });
}
