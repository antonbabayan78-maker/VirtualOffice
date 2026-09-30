/**
 * Telling the office what a call cost, from a worker that has no store.
 *
 * A worker reaches its office only over HTTP — that is what keeps the server
 * the only writer — so the sink is the usage route, exactly as filing a
 * document is the upload route.
 *
 * **Unlike the document sink, this one never throws.** `@vo/telemetry` promises
 * that metering never fails the work it measures, and it means it: an office
 * that cannot be reached, an event it refuses, a socket that hangs up — none of
 * those are the model's problem, and none of them should turn a measured call
 * into a failed one. What is lost is said out loud instead, with the office and
 * the event named, so a gap in the numbers can be traced rather than guessed at.
 *
 * One post per call. An event sent when it happens is one a dying worker cannot
 * lose, and a turn makes a handful of calls rather than thousands. Batching is
 * VO-93's job, along with the partitions and rollups that make it matter.
 */
import type { ApiClient } from "@vo/api-client";
import type { UsageEvent, UsageSink } from "@vo/telemetry";

export function apiUsageSink(api: ApiClient, onProblem?: (message: string) => void): UsageSink {
  const say = onProblem ?? ((): void => undefined);

  return {
    record: async (event: UsageEvent): Promise<void> => {
      const where = `usage event ${event.id}`;
      try {
        const sent = await api.recordUsage(
          event.attribution.officeId,
          event as unknown as Readonly<Record<string, unknown>>,
        );
        if (sent.ok) return;
        say(
          `could not record ${where}: ${
            sent.kind === "validation"
              ? sent.errors.map((problem) => `${problem.path} ${problem.message}`).join("; ")
              : sent.kind === "transport"
                ? sent.message
                : "the office had a newer version"
          }`,
        );
      } catch (error) {
        say(`could not record ${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
