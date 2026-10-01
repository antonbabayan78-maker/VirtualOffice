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
 * It reads the acceptance criteria out of the prompt for the same reason: a
 * rehearsal has to answer the question it was asked, or an office with a
 * definition of done would send every task back forever.
 */
import { FakeLlmProvider, toolCall } from "./fake-provider.js";
import { systemText, type CompletionRequest, type LlmProvider } from "../provider/types.js";

/**
 * The acceptance criteria the office wrote into this prompt.
 *
 * The wording is the orchestrator's, and duplicated here rather than imported
 * because this package sits underneath it. It is one line and it is covered by
 * a test that would fail the day the wording changed.
 */
const CRITERIA_PREFIX = "This work is done when:";

function criteriaIn(request: CompletionRequest): readonly string[] {
  const said = systemText(request.system);
  const at = said.indexOf(CRITERIA_PREFIX);
  if (at === -1) return [];
  const listed = said.slice(at + CRITERIA_PREFIX.length).split("\n")[0] ?? "";
  return listed
    .split("|")
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);
}

export function rehearsalProvider(): LlmProvider {
  return new FakeLlmProvider({
    // An office prices its models as anthropic ones, so answer as one.
    id: "anthropic",
    handler: (request) => {
      const tools = (request.tools ?? []).map((tool) => tool.name);
      const met = criteriaIn(request);
      // Deciding a shootout is a call the run loop can make, so this answers it:
      // the first answer, because A is the one label every contest has and this
      // provider has no way to read the answers and no opinion about them.
      if (tools.includes("shootout_verdict")) {
        return toolCall("shootout_verdict", {
          winner: "A",
          reason: "rehearsal: the first answer",
        });
      }
      if (tools.includes("review_verdict")) {
        return toolCall("review_verdict", { approved: true, reason: "rehearsal: approved", met });
      }
      return toolCall("submit_work", { summary: "rehearsal: work submitted", met });
    },
  });
}
