/**
 * Filing a document from a worker, which has no store to file into.
 *
 * A worker reaches its office only over HTTP — that is what keeps the server
 * the only writer — so the sink is the upload route. What the office refuses
 * comes back as a refusal the model can act on; what it could not be told at
 * all is thrown, because a network that was not there is not the model's
 * problem and the work it did still gets submitted.
 */
import type { ApiClient } from "@vo/api-client";
import type { DocumentSink } from "@vo/orchestrator";
import { err, ok } from "@vo/core";

export function apiDocumentSink(api: ApiClient): DocumentSink {
  const encoder = new TextEncoder();

  return {
    file: async (request) => {
      const filed = await api.uploadDocument(request.officeId, {
        ownerKind: "task",
        ownerId: request.taskId,
        tray: "out",
        name: request.name,
        mediaType: request.mediaType,
        body: encoder.encode(request.content),
        addedBy: request.actorId,
      });

      if (filed.ok) return ok({ id: filed.value.id, name: filed.value.name });
      if (filed.kind === "validation") return err([...filed.errors]);
      throw new Error(
        `could not file "${request.name}": ${
          filed.kind === "transport" ? filed.message : "the office had a newer version"
        }`,
      );
    },
  };
}
