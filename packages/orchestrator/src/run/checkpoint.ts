/**
 * Run checkpoints.
 *
 * A run that takes minutes across many model turns must not start over because
 * the worker holding it died. After each step the loop writes where it got to,
 * and a fresh worker picks the run up from there (§2.5).
 *
 * Delivery is at-least-once, so the same run may be handed out twice. Two rules
 * make that safe. A checkpoint holds the conversation *including* the results of
 * tools that already ran, so resuming does not call them again. And a finished
 * run records its result, so a redelivery returns that instead of doing the work
 * and the transitions a second time.
 *
 * What a checkpoint cannot undo is a tool that ran just before the crash, before
 * its result was written down. That call happens twice, which is what
 * at-least-once means; tool implementations carry their own idempotency.
 */
import type { Message } from "@vo/llm";
import type { PendingApproval } from "./approval-gate.js";
import type { BudgetSnapshot } from "./token-budget.js";
import type { RunStopReason } from "./agent-run-loop.js";

/** Checkpoints past this are trimmed, so one run cannot fill the store. */
export const MAX_CHECKPOINT_BYTES = 262_144;

export interface FinishedRun {
  readonly stopReason: RunStopReason;
  readonly text: string;
  readonly structuredResult?: Readonly<Record<string, unknown>>;
}

export interface RunCheckpoint {
  readonly runId: string;
  /** Model turns completed when this was written. */
  readonly step: number;
  readonly messages: readonly Message[];
  readonly budget: BudgetSnapshot;
  readonly spendApproved: boolean;
  /** Set while the run waits on a person. */
  readonly pendingApproval?: PendingApproval;
  /** Set once the run is over; a redelivery reads this rather than running. */
  readonly finished?: FinishedRun;
  /** Messages trimmed away to keep this checkpoint inside its size bound. */
  readonly droppedMessages: number;
  readonly updatedAt: number;
}

export interface RunCheckpointStore {
  load(runId: string): Promise<RunCheckpoint | null>;
  /** Replaces whatever was there: only the newest checkpoint for a run matters. */
  save(checkpoint: RunCheckpoint): Promise<void>;
  delete(runId: string): Promise<boolean>;
}

export function checkpointBytes(checkpoint: RunCheckpoint): number {
  return Buffer.byteLength(JSON.stringify(checkpoint), "utf8");
}

function toolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === "tool_use") ids.add(block.id);
  }
  return ids;
}

/** True when the tail refers to a tool call that is no longer in it. */
function hasOrphanToolResult(tail: readonly Message[]): boolean {
  const produced = toolUseIds(tail);
  for (const message of tail) {
    for (const block of message.content) {
      if (block.type === "tool_result" && !produced.has(block.toolUseId)) return true;
    }
  }
  return false;
}

/**
 * Trims a checkpoint to fit `maxBytes` by dropping from the middle: the brief
 * and the newest exchanges are what a resumed run needs. A tool result is never
 * left behind without the call that produced it, and the brief is never dropped
 * even when the checkpoint still will not fit — a short checkpoint beats none.
 */
export function boundCheckpoint(
  checkpoint: RunCheckpoint,
  maxBytes: number = MAX_CHECKPOINT_BYTES,
): RunCheckpoint {
  if (checkpointBytes(checkpoint) <= maxBytes) return checkpoint;

  const [brief, ...rest] = checkpoint.messages;
  if (brief === undefined) return checkpoint;

  // Keep as long a tail as fits, shrinking it until the whole thing is small enough.
  for (let keep = rest.length - 1; keep >= 0; keep--) {
    let tail = rest.slice(rest.length - keep);
    // Walk the boundary back rather than splitting a call from its result.
    while (tail.length > 0 && hasOrphanToolResult(tail)) {
      tail = tail.slice(1);
    }
    const candidate: RunCheckpoint = {
      ...checkpoint,
      messages: [brief, ...tail],
      droppedMessages: checkpoint.droppedMessages + (rest.length - tail.length),
    };
    if (checkpointBytes(candidate) <= maxBytes) return candidate;
  }

  return {
    ...checkpoint,
    messages: [brief],
    droppedMessages: checkpoint.droppedMessages + rest.length,
  };
}

export class InMemoryRunCheckpointStore implements RunCheckpointStore {
  private readonly saved = new Map<string, RunCheckpoint>();

  load(runId: string): Promise<RunCheckpoint | null> {
    return Promise.resolve(this.saved.get(runId) ?? null);
  }

  save(checkpoint: RunCheckpoint): Promise<void> {
    this.saved.set(checkpoint.runId, checkpoint);
    return Promise.resolve();
  }

  delete(runId: string): Promise<boolean> {
    return Promise.resolve(this.saved.delete(runId));
  }
}

/**
 * The part of a blob store a checkpoint needs. `@vo/storage`'s BlobStore
 * satisfies it, so a checkpoint can live anywhere blobs do without this package
 * depending on storage.
 */
export interface CheckpointBlobs {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<{ readonly data: Uint8Array } | null>;
  delete(key: string): Promise<boolean>;
}

/** Checkpoints as blobs: durable, and no schema to migrate. */
export class BlobRunCheckpointStore implements RunCheckpointStore {
  constructor(
    private readonly blobs: CheckpointBlobs,
    private readonly prefix = "runs",
  ) {}

  async load(runId: string): Promise<RunCheckpoint | null> {
    const blob = await this.blobs.get(this.key(runId));
    if (blob === null) return null;
    return JSON.parse(Buffer.from(blob.data).toString("utf8")) as RunCheckpoint;
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    const body = Buffer.from(JSON.stringify(checkpoint), "utf8");
    await this.blobs.put(this.key(checkpoint.runId), body, "application/json");
  }

  delete(runId: string): Promise<boolean> {
    return this.blobs.delete(this.key(runId));
  }

  private key(runId: string): string {
    return `${this.prefix}/${encodeURIComponent(runId)}.json`;
  }
}
