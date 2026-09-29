/**
 * Trays over the repository layer: filing a document, reading one back, listing
 * a tray and taking a document off a desk.
 *
 * A document is two writes — a body in the blob store and a row that says where
 * the body is — and the order matters in both directions. Filing writes the body
 * first, because a row pointing at nothing is a broken document while a body
 * nobody points at is only wasted space. Removing deletes the row first, for the
 * same reason read the other way round.
 *
 * Whether a body may go is decided by counting the rows that still name it,
 * rather than by a stored count: there is nothing to migrate, nothing to keep in
 * sync, and two removals racing both see zero and both ask the blob store to
 * delete, which it reports honestly the second time. Checking before deleting
 * the row is the version that leaks.
 *
 * This lives here rather than in a route so that the server, the CLI and a
 * worker cannot come to different conclusions about any of it.
 */
import {
  copyDocument,
  createDocument,
  isErr,
  type Document,
  type DocumentId,
  type DocumentOwnerRef,
  type DocumentTray,
  type EmployeeId,
  type OfficeId,
  type Result,
} from "@vo/core";
import type { EntityRepository } from "../relational/types.js";
import type { BlobStore } from "../stores/types.js";

/** Both halves of a document: the row and the body. */
export interface DocumentStores {
  readonly documents: EntityRepository<Document>;
  readonly blobs: BlobStore;
}

export interface FileDocumentInput {
  readonly officeId: OfficeId;
  readonly owner: { readonly kind: string; readonly id: string };
  readonly tray: string;
  readonly name: string;
  readonly mediaType?: string;
  /** The document itself. Its length is the size; nobody is asked to declare one. */
  readonly body: Uint8Array;
  readonly addedBy?: EmployeeId | null;
}

export interface DocumentDeps {
  readonly id: () => DocumentId;
  readonly now: () => Date;
}

/** A document and its body, which is the only useful way to have either. */
export interface FetchedDocument {
  readonly document: Document;
  readonly body: Uint8Array;
}

const PAGE = 100;

export async function fileDocument(
  stores: DocumentStores,
  input: FileDocumentInput,
  deps: DocumentDeps,
): Promise<Result<Document>> {
  const document = createDocument(
    {
      officeId: input.officeId,
      owner: input.owner,
      tray: input.tray,
      name: input.name,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      size: input.body.byteLength,
      ...(input.addedBy === undefined ? {} : { addedBy: input.addedBy }),
    },
    deps,
  );
  // Refused before anything is written: a document the office will not accept
  // must not leave a body behind for nobody to find.
  if (isErr(document)) return document;

  await stores.blobs.put(document.value.blobRef, input.body, document.value.mediaType);
  await stores.documents.put(document.value);
  return document;
}

export async function readDocument(
  stores: DocumentStores,
  id: DocumentId,
): Promise<FetchedDocument | null> {
  const document = await stores.documents.get(id);
  if (document === null) return null;
  const blob = await stores.blobs.get(document.blobRef);
  // Half a document is not a document. An empty body would read as an empty
  // document, which is a different and perfectly legitimate thing.
  if (blob === null) return null;
  return { document, body: blob.data };
}

/**
 * Everything in one tray, oldest first — the order a tray is worked through.
 *
 * Paged internally: a tray is small, and a caller that had to paginate would
 * paginate it wrong once.
 */
export async function listTray(
  documents: EntityRepository<Document>,
  owner: DocumentOwnerRef,
  tray: DocumentTray,
): Promise<readonly Document[]> {
  const where = { ownerKind: owner.kind, ownerId: owner.id, tray };
  const found: Document[] = [];
  let cursor: string | null = null;
  do {
    const page = await documents.list({
      where,
      orderBy: { field: "addedAt", direction: "asc" },
      limit: PAGE,
      ...(cursor === null ? {} : { cursor }),
    });
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return found;
}

/** True when there was a document to take. */
export async function removeDocument(stores: DocumentStores, id: DocumentId): Promise<boolean> {
  const document = await stores.documents.get(id);
  if (document === null) return false;

  const removed = await stores.documents.delete(id);
  if (!removed) return false;

  const stillHeld = await stores.documents.count({ blobRef: document.blobRef });
  if (stillHeld === 0) await stores.blobs.delete(document.blobRef);
  return true;
}

/**
 * The same documents, on another desk.
 *
 * Takes the repository alone rather than both stores, because no body is
 * written: a copy names the body the original already named. That is what makes
 * carrying a document across a handoff cost one row and nothing else, and it is
 * why the delete path counts the rows naming a body before removing it.
 *
 * An id that no longer resolves is skipped rather than failing the lot. Work
 * crossing into another department matters more than one document somebody took
 * off a desk while it was in flight, and a handoff refused for that reason would
 * leave the next department with nothing at all.
 */
export async function copyIntoTray(
  documents: EntityRepository<Document>,
  ids: readonly DocumentId[],
  to: DocumentOwnerRef,
  tray: DocumentTray,
  deps: DocumentDeps,
): Promise<readonly Document[]> {
  const copies: Document[] = [];
  for (const id of ids) {
    const source = await documents.get(id);
    if (source === null) continue;

    const copy = copyDocument(source, to, tray, deps);
    if (isErr(copy)) continue;
    await documents.put(copy.value);
    copies.push(copy.value);
  }
  return copies;
}
