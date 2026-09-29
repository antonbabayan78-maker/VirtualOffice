/**
 * One tray on one desk.
 *
 * An in-tray holds what its owner was given; an out-tray holds what it produced.
 * The same component is both, and the same component serves a department and an
 * employee, because a tray is a tray.
 *
 * What is in it is filtered out of the documents the store already holds rather
 * than fetched per tray — the same way the arrows and the activity colours are
 * derived — so one request keeps every drawer right and a document that arrives
 * on the event stream appears here without anybody asking again.
 *
 * Filing is the one thing on this canvas that is not instant: bytes have to
 * travel before the office can name what arrived, so there is nothing to show
 * optimistically and the tray says it is sending instead.
 */
import { useState, type DragEvent, type ReactNode } from "react";
import type { DocumentOwnerRef, DocumentTray, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Problems } from "../ui/field.js";

const TRAY_LABEL: Readonly<Record<DocumentTray, string>> = {
  in: "In-tray",
  out: "Out-tray",
};

const TRAY_NOTE: Readonly<Record<DocumentTray, string>> = {
  in: "What this desk has been given to work from.",
  out: "What this desk has produced.",
};

/** A size somebody reads, not a byte count somebody counts. */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Hands the bytes to the browser to save.
 *
 * Deliberately not a link to the office: the office wants a token on every
 * request, and a token in a URL is a token in a log.
 */
export function offerToSave(name: string, body: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([body as BlobPart]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Tray({
  store,
  owner,
  tray,
}: {
  readonly store: OfficeStore;
  readonly owner: DocumentOwnerRef;
  readonly tray: DocumentTray;
}): ReactNode {
  const documents = store((state) => state.documents);
  const uploading = store((state) => state.uploading);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  const held = documents.filter(
    (document) =>
      document.ownerKind === owner.kind && document.ownerId === owner.id && document.tray === tray,
  );

  const file = (chosen: File | undefined): void => {
    if (chosen === undefined) return;
    setProblems([]);
    void chosen.arrayBuffer().then(async (buffer) => {
      const outcome = await store.getState().fileDocument({
        owner,
        tray,
        name: chosen.name,
        // A browser leaves this empty for a kind it does not know; the office
        // has its own default and should be the one to apply it.
        ...(chosen.type.length === 0 ? {} : { mediaType: chosen.type }),
        body: new Uint8Array(buffer),
      });
      if (!outcome.ok) setProblems(outcome.problems);
    });
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    file(event.dataTransfer.files[0]);
  };

  return (
    <section
      role="group"
      aria-label={`${TRAY_LABEL[tray]} for ${owner.kind} ${owner.id}`}
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
      onDrop={onDrop}
      onDragOver={(event) => {
        // Without this the browser navigates to the file instead of handing it over.
        event.preventDefault();
      }}
    >
      <p className="text-xs font-medium text-ink">{TRAY_LABEL[tray]}</p>
      <p className="text-[11px] text-ink-muted">{TRAY_NOTE[tray]}</p>

      <Problems problems={problems} />

      {held.length === 0 ? (
        <p className="text-xs text-ink-muted">Empty — drop a file here to put one in.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {held.map((document) => (
            <li key={document.id} className="flex items-center gap-2 text-xs text-ink">
              <span className="min-w-0 truncate">{document.name}</span>
              <span className="shrink-0 text-[10px] text-ink-muted">
                {readableSize(document.size)}
              </span>
              <button
                type="button"
                aria-label={`Download ${document.name}`}
                className="ml-auto shrink-0 text-ink-muted hover:text-ink"
                onClick={() => {
                  void store
                    .getState()
                    .fetchBody(document.id)
                    .then((body) => {
                      if (body !== null) offerToSave(document.name, body);
                    });
                }}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${document.name}`}
                className="shrink-0 text-ink-muted hover:text-ink"
                onClick={() => {
                  void store.getState().takeDocument(document.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploading && <p className="text-[11px] text-ink-muted">Sending to the office…</p>}

      <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
        Add a document
        <input
          type="file"
          className="text-xs text-ink"
          onChange={(event) => {
            file(event.target.files?.[0]);
            // Cleared so choosing the same file twice is two events, not one.
            event.target.value = "";
          }}
        />
      </label>
    </section>
  );
}
