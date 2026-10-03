/**
 * A run kept at the office rather than in this process.
 *
 * The point of it is the gate: a run that stops before a consequential call has
 * to survive long enough for a person to answer, and that person may answer
 * minutes later, after this worker has been restarted or replaced. The office
 * holds the checkpoint; this is the worker's side of that.
 *
 * Through the API, like everything else a worker writes, so the server stays
 * the only writer. A failure is reported and swallowed: a run must not die
 * because a checkpoint could not be written — the work is still being done, it
 * just cannot be picked up elsewhere, and saying so is better than a job that
 * fails for a reason the model cannot do anything about.
 */
import type { ApiClient, RunDecision } from "@vo/api-client";
import type { RunCheckpoint, RunCheckpointStore } from "@vo/orchestrator";

export type OnProblem = (message: string) => void;

export function apiRunCheckpoints(api: ApiClient, onProblem?: OnProblem): RunCheckpointStore {
  return {
    async load(runId: string): Promise<RunCheckpoint | null> {
      const answer = await api.loadRunState(runId);
      if (!answer.ok) {
        onProblem?.(
          `could not read where run ${runId} got to: ${
            answer.kind === "transport" ? answer.message : answer.kind
          }`,
        );
        return null;
      }
      return (answer.value.checkpoint ?? null) as RunCheckpoint | null;
    },

    async save(checkpoint: RunCheckpoint): Promise<void> {
      const answer = await api.saveRunCheckpoint(
        checkpoint.runId,
        checkpoint as unknown as Readonly<Record<string, unknown>>,
      );
      if (!answer.ok) {
        onProblem?.(
          `could not keep where run ${checkpoint.runId} got to: ${
            answer.kind === "transport" ? answer.message : answer.kind
          }`,
        );
      }
    },

    delete(): Promise<boolean> {
      // Not the worker's to do. A checkpoint belongs to the attempt that is
      // running, and the office clears it when the work moves on — it is the
      // one applying the transition that makes it spent.
      return Promise.resolve(false);
    },
  };
}

/** What a person has decided about the calls this run is holding. */
export async function runDecisions(
  api: ApiClient,
  taskId: string,
  onProblem?: OnProblem,
): Promise<readonly RunDecision[]> {
  const answer = await api.loadRunState(taskId);
  if (answer.ok) return answer.value.decisions;
  onProblem?.(
    `could not read what was decided about ${taskId}: ${
      answer.kind === "transport" ? answer.message : answer.kind
    }`,
  );
  // Nothing decided means the run parks again, which is the safe direction:
  // the alternative is a held call running because a request failed.
  return [];
}
