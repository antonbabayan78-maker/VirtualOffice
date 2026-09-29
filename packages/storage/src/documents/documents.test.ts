import { beforeEach, describe, expect, it } from "vitest";
import { isErr, unwrap, type DocumentId, type EmployeeId, type OfficeId } from "@vo/core";
import { InMemoryRelationalStore } from "../relational/in-memory.js";
import { InMemoryBlobStore } from "../stores/in-memory.js";
import type { RelationalStore } from "../relational/types.js";
import {
  fileDocument,
  listTray,
  readDocument,
  removeDocument,
  type DocumentStores,
  type FileDocumentInput,
} from "./documents.js";

const officeId = "o1" as OfficeId;
const T0 = new Date("2026-09-29T09:00:00Z");

let store: RelationalStore;
let blobs: InMemoryBlobStore;
let stores: DocumentStores;
let ids = 0;

const deps = { id: () => `doc-${String(++ids)}` as DocumentId, now: () => T0 };

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const read = (data: Uint8Array): string => new TextDecoder().decode(data);

const input = (overrides: Partial<FileDocumentInput> = {}): FileDocumentInput => ({
  officeId,
  owner: { kind: "employee", id: "e1" },
  tray: "in",
  name: "brief.md",
  mediaType: "text/markdown",
  body: bytes("# Brief\n"),
  ...overrides,
});

beforeEach(() => {
  ids = 0;
  store = new InMemoryRelationalStore();
  blobs = new InMemoryBlobStore();
  stores = { documents: store.documents, blobs };
});

describe("putting a document in a tray", () => {
  it("keeps the body where the document says it is", async () => {
    const document = unwrap(await fileDocument(stores, input(), deps));

    const blob = await blobs.get(document.blobRef);
    expect(read(blob?.data ?? new Uint8Array())).toBe("# Brief\n");
  });

  it("measures the body rather than being told how big it is", async () => {
    const document = unwrap(await fileDocument(stores, input({ body: bytes("12345") }), deps));
    expect(document.size).toBe(5);
  });

  it("is findable afterwards", async () => {
    const document = unwrap(await fileDocument(stores, input(), deps));
    expect(await store.documents.get(document.id)).toEqual(document);
  });

  it("remembers the employee that filed it", async () => {
    const document = unwrap(
      await fileDocument(stores, input({ addedBy: "e2" as EmployeeId }), deps),
    );
    expect(document.addedBy).toBe("e2");
  });

  it("tells the blob store what kind of thing it is holding", async () => {
    const document = unwrap(await fileDocument(stores, input(), deps));
    expect((await blobs.get(document.blobRef))?.contentType).toBe("text/markdown");
  });

  it("takes bytes that are not text at all", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const document = unwrap(
      await fileDocument(
        stores,
        input({ name: "chart.png", mediaType: "image/png", body: png }),
        deps,
      ),
    );
    expect((await blobs.get(document.blobRef))?.data).toEqual(png);
  });

  it("refuses a document the office would not accept, and files nothing", async () => {
    const refused = await fileDocument(stores, input({ name: "../escape.md" }), deps);

    expect(isErr(refused)).toBe(true);
    expect(await store.documents.count()).toBe(0);
    // Nothing written anywhere: a refused document must not leave a body behind.
    expect(await blobs.list("")).toEqual([]);
  });

  it("refuses a body bigger than a document may be", async () => {
    const refused = await fileDocument(
      stores,
      input({ body: new Uint8Array(3 * 1024 * 1024) }),
      deps,
    );
    expect(isErr(refused)).toBe(true);
    expect(await blobs.list("")).toEqual([]);
  });
});

describe("reading a document back", () => {
  it("hands back what it is and what is in it", async () => {
    const filed = unwrap(await fileDocument(stores, input(), deps));

    const found = await readDocument(stores, filed.id);
    expect(found?.document).toEqual(filed);
    expect(read(found?.body ?? new Uint8Array())).toBe("# Brief\n");
  });

  it("says nothing for a document that was never filed", async () => {
    expect(await readDocument(stores, "doc-nope" as DocumentId)).toBeNull();
  });

  it("says nothing when the row is there and the body is gone", async () => {
    // Half a document is not a document. Reporting it missing is honest; handing
    // back an empty body would look like an empty document.
    const filed = unwrap(await fileDocument(stores, input(), deps));
    await blobs.delete(filed.blobRef);

    expect(await readDocument(stores, filed.id)).toBeNull();
  });
});

describe("listing a tray", () => {
  beforeEach(async () => {
    unwrap(await fileDocument(stores, input({ tray: "in", name: "first.md" }), deps));
    unwrap(await fileDocument(stores, input({ tray: "in", name: "second.md" }), deps));
    unwrap(await fileDocument(stores, input({ tray: "out", name: "mine.md" }), deps));
    unwrap(
      await fileDocument(
        stores,
        input({ owner: { kind: "employee", id: "e2" }, name: "theirs.md" }),
        deps,
      ),
    );
    unwrap(
      await fileDocument(
        stores,
        input({ owner: { kind: "task", id: "e1" }, name: "task.md" }),
        deps,
      ),
    );
  });

  const names = async (kind: string, id: string, tray: "in" | "out"): Promise<string[]> =>
    (await listTray(stores.documents, { kind: kind as never, id }, tray)).map((d) => d.name);

  it("holds what that owner was given", async () => {
    expect(await names("employee", "e1", "in")).toEqual(["first.md", "second.md"]);
  });

  it("holds what that owner produced, separately", async () => {
    expect(await names("employee", "e1", "out")).toEqual(["mine.md"]);
  });

  it("is nobody else's tray", async () => {
    expect(await names("employee", "e2", "in")).toEqual(["theirs.md"]);
  });

  it("does not mistake a task for an employee with the same id", async () => {
    expect(await names("task", "e1", "in")).toEqual(["task.md"]);
  });

  it("is empty for an owner that has never been given anything", async () => {
    expect(await names("department", "d1", "in")).toEqual([]);
  });

  it("puts the oldest first, so a tray reads like a tray", async () => {
    expect(await names("employee", "e1", "in")).toEqual(["first.md", "second.md"]);
  });
});

describe("taking a document out of a tray", () => {
  it("removes the row and the body together", async () => {
    const filed = unwrap(await fileDocument(stores, input(), deps));

    expect(await removeDocument(stores, filed.id)).toBe(true);
    expect(await store.documents.get(filed.id)).toBeNull();
    expect(await blobs.exists(filed.blobRef)).toBe(false);
  });

  it("says so when there was nothing to remove", async () => {
    expect(await removeDocument(stores, "doc-nope" as DocumentId)).toBe(false);
  });

  it("is safe to ask for twice", async () => {
    const filed = unwrap(await fileDocument(stores, input(), deps));
    expect(await removeDocument(stores, filed.id)).toBe(true);
    expect(await removeDocument(stores, filed.id)).toBe(false);
  });

  it("leaves a body alone while another document is still holding it", async () => {
    // What a handoff will do: the same body in two trays. Taking one copy off a
    // desk must not empty the other.
    const filed = unwrap(await fileDocument(stores, input(), deps));
    const copy = { ...filed, id: "doc-copy" as DocumentId, ownerId: "e2" };
    await store.documents.put(copy);

    expect(await removeDocument(stores, filed.id)).toBe(true);
    expect(await blobs.exists(filed.blobRef)).toBe(true);
    expect(read((await blobs.get(copy.blobRef))?.data ?? new Uint8Array())).toBe("# Brief\n");
  });

  it("removes the body once the last document holding it is gone", async () => {
    const filed = unwrap(await fileDocument(stores, input(), deps));
    const copy = { ...filed, id: "doc-copy" as DocumentId, ownerId: "e2" };
    await store.documents.put(copy);

    await removeDocument(stores, filed.id);
    await removeDocument(stores, copy.id);
    expect(await blobs.exists(filed.blobRef)).toBe(false);
  });
});
