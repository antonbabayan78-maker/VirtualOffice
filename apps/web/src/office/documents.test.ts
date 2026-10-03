import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, unwrap, type Document, type DocumentId, type OfficeId } from "@vo/core";
import type { ApiClient, ApiResult } from "@vo/api-client";
import { createOfficeStore, type OfficeStore } from "./office-store.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-29T09:00:00Z");

const doc = (id: string, overrides: Partial<Document> = {}): Document => ({
  ...unwrap(
    createDocument(
      {
        officeId,
        owner: { kind: "employee", id: "emp-ada" },
        tray: "in",
        name: `${id}.md`,
        mediaType: "text/markdown",
        size: 8,
      },
      { id: () => id as DocumentId, now: () => at },
    ),
  ),
  ...overrides,
});

interface Scripted {
  readonly api: ApiClient;
  readonly uploads: Record<string, unknown>[];
  readonly deletes: string[];
  answerUpload(result: ApiResult<Document>): void;
  answerDelete(result: ApiResult<true>): void;
}

function scriptedApi(): Scripted {
  const uploads: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  let settleUpload: ((result: ApiResult<Document>) => void) | null = null;
  let settleDelete: ((result: ApiResult<true>) => void) | null = null;
  const unused = () => Promise.reject(new Error("not used here"));

  const api: ApiClient = {
    loadOffice: unused,
    getOffice: unused,
    patchOffice: unused,
    getDepartment: unused,
    getEmployee: unused,
    getTask: unused,
    patchConnection: unused,
    patchDepartment: unused,
    patchEmployee: unused,
    postTaskEvent: unused,
    recordContestWin: unused,
    signIn: unused,
    signOut: unused,
    listOffices: unused,
    createOffice: unused,
    getDocument: unused,
    listConnectors: () => Promise.resolve({ ok: true, value: [] }),
    createConnector: unused,
    patchConnector: unused,
    deleteConnector: unused,
    discoverConnectorTools: unused,
    listServices: unused,
    createService: unused,
    patchService: unused,
    deleteService: unused,
    setServiceCredential: unused,
    clearServiceCredential: unused,
    serviceCredential: unused,
    discoverServiceModels: unused,
    studyVoice: unused,
    recordCorrection: unused,
    patchTask: unused,
    loadRunState: unused,
    saveRunCheckpoint: unused,
    setOfficeRunState: unused,
    setDepartmentRunState: unused,
    setEmployeeStatus: unused,
    recordUsage: unused,
    listUsage: unused,
    listApprovals: () => Promise.resolve({ ok: true, value: [] }),
    officeSpend: unused,
    listDocuments: unused,
    uploadDocument: (_officeId, input) => {
      uploads.push({ ...input });
      return new Promise((resolve) => {
        settleUpload = resolve;
      });
    },
    downloadDocument: (id) =>
      Promise.resolve({ ok: true, value: new TextEncoder().encode(`body of ${id}`) }),
    deleteDocument: (id) => {
      deletes.push(id);
      return new Promise((resolve) => {
        settleDelete = resolve;
      });
    },
  };

  return {
    api,
    uploads,
    deletes,
    answerUpload: (result) => settleUpload?.(result),
    answerDelete: (result) => settleDelete?.(result),
  };
}

let store: OfficeStore;
let scripted: Scripted;

const names = (): string[] => store.getState().documents.map((d) => d.name);

beforeEach(() => {
  scripted = scriptedApi();
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    api: scripted.api,
    id: () => "new",
    now: () => at,
    officeId,
  });
});

describe("what the office is holding", () => {
  it("starts out holding nothing", () => {
    expect(store.getState().documents).toEqual([]);
  });

  it("takes the documents the office reports", () => {
    store.getState().loadDocuments([doc("one"), doc("two")]);
    expect(names()).toEqual(["one.md", "two.md"]);
  });

  it("adds one it is told about", () => {
    store.getState().loadDocuments([doc("one")]);
    store.getState().putDocument(doc("two"));
    expect(names()).toEqual(["one.md", "two.md"]);
  });

  it("replaces one it already has rather than holding it twice", () => {
    store.getState().loadDocuments([doc("one")]);
    store.getState().putDocument(doc("one", { name: "renamed.md" }));
    expect(names()).toEqual(["renamed.md"]);
  });

  it("drops one it is told has gone", () => {
    store.getState().loadDocuments([doc("one"), doc("two")]);
    store.getState().dropDocument("one" as DocumentId);
    expect(names()).toEqual(["two.md"]);
  });
});

describe("putting a document in a tray from the canvas", () => {
  const file = () =>
    store.getState().fileDocument({
      owner: { kind: "employee", id: "emp-ada" },
      tray: "in",
      name: "brief.md",
      mediaType: "text/markdown",
      body: new TextEncoder().encode("# Brief\n"),
    });

  it("sends it to the office, bytes and all", async () => {
    const pending = file();
    scripted.answerUpload({ ok: true, value: doc("filed") });
    await pending;

    expect(scripted.uploads[0]).toMatchObject({
      ownerKind: "employee",
      ownerId: "emp-ada",
      tray: "in",
      name: "brief.md",
    });
  });

  it("says it is busy until the office answers", async () => {
    const pending = file();
    // An upload is the one thing here that is not instant, so the canvas has to
    // be able to say so rather than looking as though nothing happened.
    expect(store.getState().uploading).toBe(true);

    scripted.answerUpload({ ok: true, value: doc("filed") });
    await pending;
    expect(store.getState().uploading).toBe(false);
  });

  it("holds it only once the office has it, since only the office can name it", async () => {
    const pending = file();
    expect(names()).toEqual([]);

    scripted.answerUpload({ ok: true, value: doc("filed") });
    await pending;
    expect(names()).toEqual(["filed.md"]);
  });

  it("hands back what the office refused, to show against the field", async () => {
    const pending = file();
    scripted.answerUpload({
      ok: false,
      kind: "validation",
      errors: [{ path: "name", message: "must be a file name, not a path" }],
    });

    const outcome = await pending;
    expect(outcome).toEqual({
      ok: false,
      problems: [{ path: "name", message: "must be a file name, not a path" }],
    });
    expect(names()).toEqual([]);
  });

  it("says so out loud when the office could not be reached", async () => {
    const pending = file();
    scripted.answerUpload({ ok: false, kind: "transport", message: "could not reach the office" });
    await pending;

    expect(store.getState().notice).toBe("could not reach the office");
    expect(store.getState().uploading).toBe(false);
  });

  it("files into the office it is showing, which it only learns at runtime", async () => {
    // The app builds its store before it has read its configuration, so the
    // office id is not a construction-time dep — it arrives with the office.
    const late = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      api: scripted.api,
      id: () => "new",
      now: () => at,
    });
    late.getState().loadOffice({ id: officeId, name: "Acme" } as never);

    const pending = late.getState().fileDocument({
      owner: { kind: "employee", id: "emp-ada" },
      tray: "in",
      name: "brief.md",
      body: new Uint8Array(),
    });
    scripted.answerUpload({ ok: true, value: doc("filed") });

    expect(await pending).toEqual({ ok: true });
    expect(scripted.uploads).toHaveLength(1);
  });

  it("keeps it in the browser when there is nobody to send it to", async () => {
    const offline = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });

    // A canvas with no office behind it still works; it just cannot file
    // anything, and saying it succeeded would be a lie.
    const outcome = await offline.getState().fileDocument({
      owner: { kind: "employee", id: "emp-ada" },
      tray: "in",
      name: "brief.md",
      body: new Uint8Array(),
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("taking a document off a desk", () => {
  beforeEach(() => {
    store.getState().loadDocuments([doc("one"), doc("two")]);
  });

  it("goes from the canvas at once, before the office has answered", () => {
    void store.getState().takeDocument("one" as DocumentId);
    expect(names()).toEqual(["two.md"]);
  });

  it("stays gone once the office agrees", async () => {
    const pending = store.getState().takeDocument("one" as DocumentId);
    scripted.answerDelete({ ok: true, value: true });
    await pending;

    expect(names()).toEqual(["two.md"]);
    expect(scripted.deletes).toEqual(["one"]);
  });

  it("comes back when the office would not let it go", async () => {
    const pending = store.getState().takeDocument("one" as DocumentId);
    scripted.answerDelete({ ok: false, kind: "transport", message: "the office answered 500" });
    await pending;

    expect(names()).toEqual(["one.md", "two.md"]);
    expect(store.getState().notice).toBe("the office answered 500");
  });

  it("refuses to take a document it has never heard of", async () => {
    const outcome = await store.getState().takeDocument("nope" as DocumentId);
    expect(outcome.ok).toBe(false);
    expect(scripted.deletes).toEqual([]);
  });
});

describe("reading a document", () => {
  it("fetches the body, which the store is the only thing able to ask for", async () => {
    // The API client lives in a closure here, so a component cannot reach past
    // the store to download something.
    const body = await store.getState().fetchBody("one" as DocumentId);
    expect(new TextDecoder().decode(body ?? new Uint8Array())).toBe("body of one");
  });

  it("says nothing when there is nobody to ask", async () => {
    const offline = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    expect(await offline.getState().fetchBody("one" as DocumentId)).toBeNull();
  });
});
