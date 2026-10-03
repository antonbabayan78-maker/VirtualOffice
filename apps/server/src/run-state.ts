/**
 * What the office keeps about a run that is in flight.
 *
 * Two records, with one writer each, which is the whole design. The worker
 * writes the **checkpoint**, because it is the thing running the loop. The
 * office writes the **decisions**, because they come from a person. Neither
 * writes the other's, so a step being saved and a decision arriving cannot lose
 * each other — which they would, since a checkpoint is replaced whole.
 *
 * Both live in blobs: there is no schema to migrate, and a run in flight is not
 * an entity anybody queries. `BlobRunCheckpointStore` from the orchestrator
 * already does the checkpoint half and had no caller until now.
 *
 * Both belong to the attempt that is running. When the work moves on — into
 * review, done, cancelled — the office clears them, because a later attempt
 * reading an older attempt's finished checkpoint would hand back the answer
 * from the first one.
 */
import type { ApprovalDecision, CheckpointBlobs } from "@vo/orchestrator";

export interface RunDecisionStore {
  list(taskId: string): Promise<readonly ApprovalDecision[]>;
  /** One answer per call: the same decision twice is still one decision. */
  record(taskId: string, decision: ApprovalDecision): Promise<void>;
  clear(taskId: string): Promise<boolean>;
}

const key = (prefix: string, taskId: string): string =>
  `${prefix}/${encodeURIComponent(taskId)}.decisions.json`;

export function blobRunDecisions(blobs: CheckpointBlobs, prefix = "runs"): RunDecisionStore {
  const read = async (taskId: string): Promise<ApprovalDecision[]> => {
    const blob = await blobs.get(key(prefix, taskId));
    if (blob === null) return [];
    try {
      const parsed: unknown = JSON.parse(Buffer.from(blob.data).toString("utf8"));
      return Array.isArray(parsed) ? (parsed as ApprovalDecision[]) : [];
    } catch {
      // A record nobody can read is a decision nobody made; the run asks again
      // rather than a turn failing on JSON.
      return [];
    }
  };

  return {
    list: (taskId) => read(taskId),

    async record(taskId, decision) {
      const kept = (await read(taskId)).filter((one) => one.key !== decision.key);
      const body = Buffer.from(JSON.stringify([...kept, decision]), "utf8");
      await blobs.put(key(prefix, taskId), body, "application/json");
    },

    clear: (taskId) => blobs.delete(key(prefix, taskId)),
  };
}
