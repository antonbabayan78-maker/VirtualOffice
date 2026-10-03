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
 *
 * It also **calls one tool it was granted**, once. A rehearsal that never calls
 * anything cannot rehearse an office with tools: the grants, the broker, the
 * server behind it and the gate in front of it are all untried until something
 * asks. It calls with no arguments, because it has no idea what the tool wants
 * — a tool that needs some answers with a complaint, and being able to complain
 * is itself proof it was reached.
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

/** The office's own tools, which a rehearsal is not trying to prove. */
const OFFICE_TOOLS: readonly string[] = ["find_tool", "file_document", "submit_work"];

/**
 * A tool named in the catalogue index the lazy toolset writes into the prompt.
 *
 * Read out of the prompt rather than imported, for the same reason the criteria
 * are: this package sits underneath the one that builds the index. The shape is
 * `connector__tool (connectorId): description`, one per line.
 */
/** Whether this run has already called a connector's tool. */
function alreadyCalled(request: CompletionRequest): boolean {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.name.includes("__")) return true;
    }
  }
  return false;
}

function firstCatalogued(request: CompletionRequest): string | null {
  for (const line of systemText(request.system).split("\n")) {
    const match = /^([a-z0-9][a-z0-9_-]*__[a-z0-9_-]+) \(/i.exec(line.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

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
      // A reviewer is given no tools of its own, and reaching for one here
      // would be a reviewer redoing the work it was asked to judge.
      if (tools.includes("review_verdict")) {
        return toolCall("review_verdict", { approved: true, reason: "rehearsal: approved", met });
      }

      // One granted tool, once per run — read out of the conversation rather
      // than remembered here. A worker builds one provider and uses it for
      // every job it ever does, so a flag in this closure would mean the first
      // task of the day tried a tool and none of the others did.
      if (!alreadyCalled(request)) {
        const offered = tools.find((name) => !OFFICE_TOOLS.includes(name));
        if (offered !== undefined) {
          return toolCall(offered, {});
        }
        const named = firstCatalogued(request);
        if (named !== null && tools.includes("find_tool")) {
          return toolCall("find_tool", { query: named });
        }
      }

      return toolCall("submit_work", { summary: "rehearsal: work submitted", met });
    },
  });
}
