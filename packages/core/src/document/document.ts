/**
 * Document: a piece of work sitting in somebody's tray.
 *
 * An in-tray holds what its owner has been given; an out-tray holds what it
 * produced. Either can belong to the office, a department, an employee or a
 * single task, which is why the owner is a kind and an id rather than four
 * nullable columns.
 *
 * The owner is two flat fields rather than a nested reference because listing
 * one tray is the access path this entity exists for, and the repository layer
 * filters on equality of top-level fields. `DocumentOwnerRef` is the shape
 * callers pass in and the canvas reads back.
 *
 * The body is not here. It lives in the blob store under `blobRef`, which this
 * module works out from the office and the document's own id — deliberately not
 * from the name, because a name is whatever a person typed and the filesystem
 * adapter resolves a key onto a real path.
 *
 * A document somebody put in a tray is material, never instruction. Anything
 * that puts one in a prompt owes it the same posture as tool output.
 */
import { err, ok, type Result, type ValidationError } from "../shared/result.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";

declare const documentIdBrand: unique symbol;
export type DocumentId = string & { readonly [documentIdBrand]: true };

export const DOCUMENT_TRAYS = ["in", "out"] as const;
export type DocumentTray = (typeof DOCUMENT_TRAYS)[number];

export const DOCUMENT_OWNER_KINDS = ["office", "department", "employee", "task"] as const;
export type DocumentOwnerKind = (typeof DOCUMENT_OWNER_KINDS)[number];

export function isDocumentTray(value: unknown): value is DocumentTray {
  return DOCUMENT_TRAYS.includes(value as DocumentTray);
}

export function isDocumentOwnerKind(value: unknown): value is DocumentOwnerKind {
  return DOCUMENT_OWNER_KINDS.includes(value as DocumentOwnerKind);
}

/** Whose tray, as callers name it. Stored as two fields, not as this. */
export interface DocumentOwnerRef {
  readonly kind: DocumentOwnerKind;
  readonly id: string;
}

export interface Document {
  readonly id: DocumentId;
  readonly officeId: OfficeId;
  readonly ownerKind: DocumentOwnerKind;
  readonly ownerId: string;
  readonly tray: DocumentTray;
  /** What it is called on the desk: a file name, never a path. */
  readonly name: string;
  readonly mediaType: string;
  /** Bytes. Held here so a tray can be listed without reading any of them. */
  readonly size: number;
  /** Where the body is kept in the blob store. */
  readonly blobRef: string;
  /** The employee that filed it, or null when a person put it there. */
  readonly addedBy: EmployeeId | null;
  readonly addedAt: Date;
}

/** Loose on the way in, narrow on the entity: this is fed by HTTP and by YAML. */
export interface CreateDocumentInput {
  readonly officeId: OfficeId;
  readonly owner: { readonly kind: string; readonly id: string };
  readonly tray: string;
  readonly name: string;
  /** Defaults to bytes-of-unknown-kind rather than guessing from the name. */
  readonly mediaType?: string;
  readonly size: number;
  readonly addedBy?: EmployeeId | null;
}

export interface DocumentDeps {
  readonly id: () => DocumentId;
  readonly now: () => Date;
}

export const DOCUMENT_NAME_MAX_LENGTH = 200;
/** Two mebibytes, which a whole request body is buffered to carry. */
export const DOCUMENT_SIZE_MAX = 2 * 1024 * 1024;
export const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** `type/subtype`, with the punctuation RFC 6838 allows in a token. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Where a document's body lives.
 *
 * Exported because the storage service reads and deletes by this key and must
 * arrive at the same answer, and because a test that hard-codes the layout in
 * two places would agree with itself while both were wrong.
 */
export function blobRefFor(officeId: OfficeId, id: DocumentId): string {
  return `${officeId}/documents/${id}`;
}

function validateName(raw: unknown, errors: ValidationError[]): string {
  if (typeof raw !== "string") {
    errors.push({ path: "name", message: "must be a string" });
    return "";
  }
  const name = raw.trim();
  if (name.length === 0) {
    errors.push({ path: "name", message: "must not be empty" });
  } else if (name.length > DOCUMENT_NAME_MAX_LENGTH) {
    errors.push({
      path: "name",
      message: `must be at most ${String(DOCUMENT_NAME_MAX_LENGTH)} characters`,
    });
  } else if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    // A name, not a path. Nothing downstream should have to defend itself
    // against a document called "../secrets.env".
    errors.push({ path: "name", message: "must be a file name, not a path" });
  }
  return name;
}

export function createDocument(input: CreateDocumentInput, deps: DocumentDeps): Result<Document> {
  const errors: ValidationError[] = [];

  const name = validateName(input.name, errors);

  const mediaType = (input.mediaType ?? DEFAULT_MEDIA_TYPE).trim().toLowerCase();
  if (!MEDIA_TYPE.test(mediaType)) {
    errors.push({ path: "mediaType", message: "must look like text/markdown" });
  }

  const tray = input.tray;
  if (!isDocumentTray(tray)) {
    errors.push({ path: "tray", message: `must be one of ${DOCUMENT_TRAYS.join(", ")}` });
  }

  const ownerKind = input.owner.kind;
  if (!isDocumentOwnerKind(ownerKind)) {
    errors.push({
      path: "owner.kind",
      message: `must be one of ${DOCUMENT_OWNER_KINDS.join(", ")}`,
    });
  }

  const ownerId = typeof input.owner.id === "string" ? input.owner.id.trim() : "";
  if (ownerId.length === 0) errors.push({ path: "owner.id", message: "must not be empty" });

  const size = input.size;
  if (!Number.isInteger(size) || size < 0) {
    errors.push({ path: "size", message: "must be a count of bytes" });
  } else if (size > DOCUMENT_SIZE_MAX) {
    errors.push({
      path: "size",
      message: `must be at most ${String(DOCUMENT_SIZE_MAX)} bytes`,
    });
  }

  if (errors.length > 0 || !isDocumentTray(tray) || !isDocumentOwnerKind(ownerKind)) {
    return err(errors);
  }

  const id = deps.id();
  return ok({
    id,
    officeId: input.officeId,
    ownerKind,
    ownerId,
    tray,
    name,
    mediaType,
    size,
    blobRef: blobRefFor(input.officeId, id),
    addedBy: input.addedBy ?? null,
    addedAt: deps.now(),
  });
}

/** Who is handing a document on, when it is not whoever filed it. */
export interface CopyDocumentInput {
  readonly addedBy?: EmployeeId | null;
}

/**
 * The same document, on another desk.
 *
 * A copy keeps the source's `blobRef` rather than deriving its own, which is the
 * whole point: two desks holding one document that was written once. That is
 * also why removing a document counts the rows still naming its body before
 * deleting it — a rule written before anything could make a copy, for this.
 *
 * Its own id and its own arrival time, though, because the audit log has to be
 * able to say when this landed here rather than when the original was written.
 * Sharing a row between two owners would make that unanswerable, which is the
 * argument against sharing rather than copying.
 */
export function copyDocument(
  source: Document,
  to: DocumentOwnerRef,
  tray: DocumentTray,
  deps: DocumentDeps,
  input: CopyDocumentInput = {},
): Result<Document> {
  const errors: ValidationError[] = [];
  if (!isDocumentOwnerKind(to.kind)) {
    errors.push({
      path: "owner.kind",
      message: `must be one of ${DOCUMENT_OWNER_KINDS.join(", ")}`,
    });
  }
  const ownerId = typeof to.id === "string" ? to.id.trim() : "";
  if (ownerId.length === 0) errors.push({ path: "owner.id", message: "must not be empty" });
  if (!isDocumentTray(tray)) {
    errors.push({ path: "tray", message: `must be one of ${DOCUMENT_TRAYS.join(", ")}` });
  }
  if (errors.length > 0 || !isDocumentOwnerKind(to.kind) || !isDocumentTray(tray)) {
    return err(errors);
  }

  return ok({
    ...source,
    id: deps.id(),
    ownerKind: to.kind,
    ownerId,
    tray,
    addedBy: input.addedBy ?? source.addedBy,
    addedAt: deps.now(),
  });
}
