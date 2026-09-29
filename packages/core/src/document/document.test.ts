import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "../shared/result.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import {
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_OWNER_KINDS,
  DOCUMENT_SIZE_MAX,
  DOCUMENT_TRAYS,
  blobRefFor,
  createDocument,
  isDocumentOwnerKind,
  isDocumentTray,
  type CreateDocumentInput,
  type DocumentId,
} from "./document.js";

const officeId = "office-1" as OfficeId;
const deps = { id: () => "doc-1" as DocumentId, now: () => new Date("2026-09-29T09:00:00Z") };

const input = (overrides: Partial<CreateDocumentInput> = {}): CreateDocumentInput => ({
  officeId,
  owner: { kind: "employee", id: "emp-iris" },
  tray: "in",
  name: "market-scan.md",
  mediaType: "text/markdown",
  size: 1024,
  ...overrides,
});

describe("a document on somebody's desk", () => {
  it("records where it is and what it is", () => {
    const document = unwrap(createDocument(input(), deps));

    expect(document).toMatchObject({
      id: "doc-1",
      officeId,
      ownerKind: "employee",
      ownerId: "emp-iris",
      tray: "in",
      name: "market-scan.md",
      mediaType: "text/markdown",
      size: 1024,
      addedAt: new Date("2026-09-29T09:00:00Z"),
    });
  });

  it("says nobody put it there when no employee did", () => {
    // A person dropping a file in is not an employee, and saying so is the only
    // way the audit log can tell the two apart.
    expect(unwrap(createDocument(input(), deps)).addedBy).toBeNull();
  });

  it("records the employee that filed it", () => {
    const document = unwrap(createDocument(input({ addedBy: "emp-theo" as EmployeeId }), deps));
    expect(document.addedBy).toBe("emp-theo");
  });

  it("belongs in a tray on any of the four kinds of desk", () => {
    for (const kind of DOCUMENT_OWNER_KINDS) {
      const document = unwrap(createDocument(input({ owner: { kind, id: "owner-1" } }), deps));
      expect(document.ownerKind).toBe(kind);
    }
  });

  it("goes in either tray", () => {
    for (const tray of DOCUMENT_TRAYS) {
      expect(unwrap(createDocument(input({ tray }), deps)).tray).toBe(tray);
    }
  });

  it("defaults to a media type that claims nothing", () => {
    const { mediaType: _unset, ...withoutMediaType } = input();
    const document = unwrap(createDocument(withoutMediaType, deps));
    expect(document.mediaType).toBe("application/octet-stream");
  });

  it("reads a media type case-insensitively, and keeps it in one case", () => {
    expect(unwrap(createDocument(input({ mediaType: "TEXT/Markdown" }), deps)).mediaType).toBe(
      "text/markdown",
    );
  });

  it("trims a name somebody typed with a space on the end", () => {
    expect(unwrap(createDocument(input({ name: "  brief.txt  " }), deps)).name).toBe("brief.txt");
  });
});

describe("where a document's body is kept", () => {
  it("is named after the office and the document, and nothing else", () => {
    expect(unwrap(createDocument(input(), deps)).blobRef).toBe("office-1/documents/doc-1");
  });

  it("never contains the name the document was given", () => {
    // The filesystem adapter resolves a key onto a real path. A name is what a
    // person typed, so it has no business anywhere near one.
    const document = unwrap(createDocument(input({ name: "report.md" }), deps));
    expect(document.blobRef).not.toContain("report");
  });

  it("is worked out the same way wherever it is asked for", () => {
    expect(blobRefFor(officeId, "doc-1" as DocumentId)).toBe("office-1/documents/doc-1");
  });
});

describe("refusing a document", () => {
  const problems = (overrides: Partial<CreateDocumentInput>): readonly string[] => {
    const result = createDocument(input(overrides), deps);
    if (!isErr(result)) throw new Error("expected this document to be refused");
    return result.error.map((problem) => problem.path);
  };

  it("refuses a name that is only spaces", () => {
    expect(problems({ name: "   " })).toContain("name");
  });

  it("refuses a name longer than a name", () => {
    expect(problems({ name: "a".repeat(DOCUMENT_NAME_MAX_LENGTH + 1) })).toContain("name");
  });

  it("refuses a name that is a path rather than a name", () => {
    for (const name of ["../secrets.env", "notes/brief.md", "a\\b.txt", ".", ".."]) {
      expect(problems({ name })).toContain("name");
    }
  });

  it("refuses a media type that is not one", () => {
    for (const mediaType of ["markdown", "text/", "/markdown", "text markdown"]) {
      expect(problems({ mediaType })).toContain("mediaType");
    }
  });

  it("refuses a tray that is not a tray", () => {
    expect(problems({ tray: "pending" })).toContain("tray");
  });

  it("refuses a kind of owner the office does not have", () => {
    expect(problems({ owner: { kind: "manager", id: "emp-iris" } })).toContain("owner.kind");
  });

  it("refuses an owner with no id", () => {
    expect(problems({ owner: { kind: "employee", id: "  " } })).toContain("owner.id");
  });

  it("refuses a body bigger than the office will hold", () => {
    expect(problems({ size: DOCUMENT_SIZE_MAX + 1 })).toContain("size");
  });

  it("refuses a size that is not a count of bytes", () => {
    for (const size of [-1, 1.5, Number.NaN]) {
      expect(problems({ size })).toContain("size");
    }
  });

  it("allows an empty document, which is a real thing to hand somebody", () => {
    expect(unwrap(createDocument(input({ size: 0 }), deps)).size).toBe(0);
  });

  it("reports everything wrong at once, rather than the first thing", () => {
    const refused = createDocument(input({ name: "", tray: "pending", size: -1 }), deps);
    if (!isErr(refused)) throw new Error("expected this document to be refused");
    expect(refused.error.map((problem) => problem.path).sort()).toEqual(["name", "size", "tray"]);
  });
});

describe("knowing a tray and an owner kind when you see one", () => {
  it("recognises the ones the office has", () => {
    expect(isDocumentTray("out")).toBe(true);
    expect(isDocumentOwnerKind("task")).toBe(true);
  });

  it("does not recognise anything else", () => {
    expect(isDocumentTray("archive")).toBe(false);
    expect(isDocumentOwnerKind("office ")).toBe(false);
  });
});
