import { describe, expect, it } from "vitest";
import { isErr, unwrap, type EmployeeId, type OfficeId, type TaskId } from "@vo/core";
import type { ApiClient, ApiResult, UploadDocument } from "@vo/api-client";
import type { Document } from "@vo/core";
import { apiDocumentSink } from "./document-sink.js";

const officeId = "office-1" as OfficeId;

const request = {
  officeId,
  taskId: "task-1" as TaskId,
  actorId: "emp-ada" as EmployeeId,
  name: "notes.md",
  mediaType: "text/markdown",
  content: "# Notes\n",
  tray: "out" as const,
};

function api(answer: ApiResult<Document>, sent: { value?: UploadDocument } = {}): ApiClient {
  const unused = () => Promise.reject(new Error("not used here"));
  return {
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
    loadRunState: unused,
    listApprovals: unused,
    patchTask: unused,
    saveRunCheckpoint: unused,
    setOfficeRunState: unused,
    setDepartmentRunState: unused,
    setEmployeeStatus: unused,
    recordUsage: unused,
    listUsage: unused,
    officeSpend: unused,
    listDocuments: unused,
    downloadDocument: unused,
    deleteDocument: unused,
    uploadDocument: (_officeId, input) => {
      sent.value = input;
      return Promise.resolve(answer);
    },
  };
}

const filed = { id: "doc-1", name: "notes.md" } as unknown as Document;

describe("a worker filing what its agent wrote", () => {
  it("puts it in the out-tray of the work, not of the worker", async () => {
    const sent: { value?: UploadDocument } = {};
    await apiDocumentSink(api({ ok: true, value: filed }, sent)).file(request);

    expect(sent.value).toMatchObject({
      ownerKind: "task",
      ownerId: "task-1",
      tray: "out",
      name: "notes.md",
      addedBy: "emp-ada",
    });
  });

  it("sends the text as bytes, since that is what a document is", async () => {
    const sent: { value?: UploadDocument } = {};
    await apiDocumentSink(api({ ok: true, value: filed }, sent)).file(request);

    expect(new TextDecoder().decode(sent.value?.body)).toBe("# Notes\n");
  });

  it("hands back what the office called it", async () => {
    const answer = await apiDocumentSink(api({ ok: true, value: filed })).file(request);
    expect(unwrap(answer)).toEqual({ id: "doc-1", name: "notes.md" });
  });

  it("passes a refusal back, so the agent can name it something else", async () => {
    const refused = await apiDocumentSink(
      api({
        ok: false,
        kind: "validation",
        errors: [{ path: "name", message: "must be a file name, not a path" }],
      }),
    ).file(request);

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) expect(refused.error[0]?.path).toBe("name");
  });

  it("throws when the office could not be reached at all", async () => {
    // Not a refusal: there is nothing the agent can do differently, and the
    // turn treats a throw as the office being down rather than as bad input.
    const sink = apiDocumentSink(api({ ok: false, kind: "transport", message: "unreachable" }));
    await expect(sink.file(request)).rejects.toThrow(/unreachable/);
  });
});

describe("which tray a filed document lands in", () => {
  it("puts work the employee produced in the out-tray", async () => {
    const sent: { value?: UploadDocument } = {};
    await apiDocumentSink(api({ ok: true, value: filed }, sent)).file(request);
    expect(sent.value?.tray).toBe("out");
  });

  it("puts material a tool brought back in the in-tray", async () => {
    // A fetched page is not something this work produced; it is something it
    // was handed, which is also where the fence around untrusted text is.
    const sent: { value?: UploadDocument } = {};
    await apiDocumentSink(api({ ok: true, value: filed }, sent)).file({
      ...request,
      tray: "in",
    });
    expect(sent.value?.tray).toBe("in");
  });
});
