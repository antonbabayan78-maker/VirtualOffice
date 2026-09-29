/**
 * The seam between an employee filing a document and whatever actually holds
 * one — a store here, the office API from a worker.
 *
 * A port rather than a workflow effect, and for two reasons. The tool has to
 * hand an id back to the model during the turn, which nothing deferred can do.
 * And a worker has no store at all: it reaches its office only over HTTP, so an
 * effect performed by the caller would be this same request with an extra hop
 * and nothing to return. This is the shape `CheckRunner` already uses for the
 * same problem.
 *
 * Where a filed document goes is decided here rather than by each caller: the
 * out-tray of the task the work belongs to. A sink that could be told a
 * different owner would eventually be told a different one by each of them.
 */
import type { EmployeeId, OfficeId, Result, TaskId } from "@vo/core";

export interface FileRequest {
  readonly officeId: OfficeId;
  /** Whose tray: the work, not the worker, so a handoff can carry it. */
  readonly taskId: TaskId;
  /**
   * Which tray. Work the employee produced goes in the out-tray; material a
   * tool brought back goes in the in-tray, where what was handed over lives and
   * where the fence around untrusted text already is.
   */
  readonly tray: "in" | "out";
  readonly actorId: EmployeeId;
  readonly name: string;
  readonly mediaType: string;
  /** Text. A model cannot emit bytes; an upload is the way anything else arrives. */
  readonly content: string;
}

export interface FiledDocument {
  readonly id: string;
  readonly name: string;
}

export interface DocumentSink {
  file(request: FileRequest): Promise<Result<FiledDocument>>;
}

/** A document somebody handed this turn, already read by whoever asked. */
export interface HandedOver {
  readonly name: string;
  readonly text: string;
}

/** A sink that keeps what it was given, for tests and for dry runs. */
export function recordingDocumentSink(): {
  readonly sink: DocumentSink;
  readonly filed: FileRequest[];
} {
  const filed: FileRequest[] = [];
  let next = 0;
  return {
    filed,
    sink: {
      file(request) {
        filed.push(request);
        next += 1;
        return Promise.resolve({
          ok: true,
          value: { id: `doc-${String(next)}`, name: request.name },
        });
      },
    },
  };
}
