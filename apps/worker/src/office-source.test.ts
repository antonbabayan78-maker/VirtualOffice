import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@vo/api-client";
import { officeSource } from "./office-source.js";

const at = new Date("2026-09-28T09:00:00Z");

const office = { id: "office-1", name: "Acme", schedule: { kind: "always" } };
const department = {
  id: "dept-eng",
  officeId: "office-1",
  schedule: { kind: "always" },
  // As the client returns it: a room with no benches has an empty list, never a
  // missing field, so a double that leaves it out is not a real answer.
  benches: [],
  createdAt: at,
};
const ada = {
  id: "emp-ada",
  officeId: "office-1",
  departmentId: "dept-eng",
  status: "active",
  schedule: null,
  createdAt: at,
  statusChangedAt: at,
};
const task = {
  id: "task-1",
  officeId: "office-1",
  departmentId: "dept-eng",
  assigneeId: "emp-ada",
  status: "assigned",
  priority: "normal",
  reviewerIds: [],
  history: [{ type: "created", at }],
};

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    loadOffice: () =>
      Promise.resolve({
        ok: true,
        value: {
          office: office as never,
          departments: [department as never],
          employees: [ada as never],
          tasks: [task as never],
          connections: [],
          connectors: [],
        },
      }),
    getOffice: () => Promise.reject(new Error("not used here")),
    getDepartment: () => Promise.reject(new Error("not used here")),
    getEmployee: () => Promise.reject(new Error("not used here")),
    getTask: () => Promise.reject(new Error("not used here")),
    patchOffice: () => Promise.reject(new Error("not used here")),
    patchConnection: () => Promise.reject(new Error("not used here")),
    patchDepartment: () => Promise.reject(new Error("not used here")),
    patchEmployee: () => Promise.reject(new Error("not used here")),
    getDocument: () => Promise.reject(new Error("not used here")),
    listConnectors: () => Promise.resolve({ ok: true, value: [] }),
    createConnector: () => Promise.reject(new Error("not used here")),
    patchConnector: () => Promise.reject(new Error("not used here")),
    deleteConnector: () => Promise.reject(new Error("not used here")),
    discoverConnectorTools: () => Promise.reject(new Error("not used here")),
    loadRunState: () => Promise.reject(new Error("not used here")),
    listApprovals: () => Promise.reject(new Error("not used here")),
    saveRunCheckpoint: () => Promise.reject(new Error("not used here")),
    setOfficeRunState: () => Promise.reject(new Error("not used here")),
    setDepartmentRunState: () => Promise.reject(new Error("not used here")),
    setEmployeeStatus: () => Promise.reject(new Error("not used here")),
    recordUsage: () => Promise.reject(new Error("not used here")),
    listUsage: () => Promise.reject(new Error("not used here")),
    officeSpend: () =>
      Promise.resolve({
        ok: true as const,
        value: { officeUsd: 0, unpricedCalls: 0, byDepartment: {}, byEmployee: {} },
      }),
    listDocuments: () => Promise.reject(new Error("not used here")),
    uploadDocument: () => Promise.reject(new Error("not used here")),
    downloadDocument: () => Promise.reject(new Error("not used here")),
    deleteDocument: () => Promise.reject(new Error("not used here")),
    postTaskEvent: () => Promise.reject(new Error("not used here")),
    recordContestWin: () => Promise.reject(new Error("not used here")),
    signIn: () => Promise.reject(new Error("not used here")),
    signOut: () => Promise.reject(new Error("not used here")),
    listOffices: () => Promise.reject(new Error("not used here")),
    createOffice: () => Promise.reject(new Error("not used here")),
    ...overrides,
  };
}

describe("reading the office the worker schedules from", () => {
  it("asks the office rather than a database of its own", async () => {
    const base = api();
    const loadOffice = vi.fn((id: string) => base.loadOffice(id));
    await officeSource({ api: api({ loadOffice }), officeId: "office-1" })();
    expect(loadOffice).toHaveBeenCalledWith("office-1");
  });

  it("brings back what the scheduler needs to decide", async () => {
    const snapshot = await officeSource({ api: api(), officeId: "office-1" })();
    expect(snapshot.tasks[0]).toMatchObject({ id: "task-1", assigneeId: "emp-ada" });
    expect(snapshot.employees[0]).toMatchObject({ id: "emp-ada", status: "active" });
    expect(snapshot.offices[0]?.id).toBe("office-1");
  });

  it("schedules nothing when the office cannot be reached, rather than throwing away the tick", async () => {
    const unreachable = api({
      loadOffice: () => Promise.resolve({ ok: false, kind: "transport", message: "refused" }),
    });
    const snapshot = await officeSource({ api: unreachable, officeId: "office-1" })();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.employees).toEqual([]);
    expect(snapshot.offices).toEqual([]);
  });

  it("says so when it could not read the office, instead of looking idle", async () => {
    const problems: string[] = [];
    const unreachable = api({
      loadOffice: () => Promise.resolve({ ok: false, kind: "transport", message: "refused" }),
    });
    await officeSource({
      api: unreachable,
      officeId: "office-1",
      onProblem: (message) => problems.push(message),
    })();
    expect(problems[0]).toMatch(/refused/);
  });
});

describe("a worker that knows what its office has spent", () => {
  it("asks for the spend and puts it on the snapshot", async () => {
    const officeSpend = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          officeUsd: 4,
          unpricedCalls: 0,
          byDepartment: { "dept-eng": 3 },
          byEmployee: { "emp-ada": 2 },
        },
      }),
    );
    const snapshot = await officeSource({ api: api({ officeSpend }), officeId: "office-1" })();

    expect(officeSpend).toHaveBeenCalledWith("office-1", "day");
    expect(snapshot.offices[0]?.spentUsd).toBe(4);
    expect(snapshot.employees[0]?.spentUsd).toBe(2);
  });

  it("schedules as it always did when the spend cannot be read", async () => {
    // The same rule this file already follows for an office it cannot reach:
    // a network blip must not stop work that needs no network — and here it
    // would stop it by pretending nothing had been spent is unknowable.
    const problems: string[] = [];
    const snapshot = await officeSource({
      api: api({
        officeSpend: () => Promise.resolve({ ok: false, kind: "transport", message: "no figures" }),
      } as never),
      officeId: "office-1",
      onProblem: (message) => problems.push(message),
    })();

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.offices[0]?.spentUsd).toBe(0);
    expect(problems.join(" ")).toMatch(/spend|figures/i);
  });
});
