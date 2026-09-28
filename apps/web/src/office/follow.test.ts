import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import type { ApiClient, ApiResult, OfficeSnapshot } from "@vo/api-client";
import { createOfficeStore, type OfficeStore } from "./office-store.js";
import { followOffice } from "./follow.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");

const eng: Department = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);
const ada: Employee = unwrap(
  createEmployee(
    {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    },
    { department: { id: eng.id, officeId }, supervisor: null },
    { id: () => "emp-ada" as EmployeeId, now: () => at },
  ),
);

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    loadOffice: () =>
      Promise.resolve({
        ok: true,
        value: {
          office: { id: officeId } as never,
          departments: [eng],
          employees: [ada],
          tasks: [],
          connections: [],
        },
      } satisfies ApiResult<OfficeSnapshot>),
    getDepartment: (id) =>
      Promise.resolve({ ok: true, value: { ...eng, id: id as DepartmentId, name: "Platform" } }),
    getOffice: () => Promise.reject(new Error("not used here")),
    patchOffice: () => Promise.reject(new Error("not used here")),
    getEmployee: (id) =>
      Promise.resolve({
        ok: true,
        value: { ...ada, id: id as EmployeeId, role: "Staff engineer" },
      }),
    getTask: (id) =>
      Promise.resolve({
        ok: true,
        value: {
          id,
          status: "in_progress",
          assigneeId: ada.id,
          reviewerIds: [],
          history: [],
        } as never,
      }),
    patchDepartment: () => Promise.reject(new Error("not used here")),
    postTaskEvent: () => Promise.reject(new Error("not used here")),
    patchEmployee: () => Promise.reject(new Error("not used here")),
    ...overrides,
  };
}

let store: OfficeStore;

beforeEach(() => {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([eng], [ada]);
});

const follow = (api: ApiClient) => followOffice({ store, api, officeId });

describe("following what the office says happened", () => {
  it("fetches the department that changed and shows it", async () => {
    await follow(fakeApi()).apply({
      offset: 4,
      officeId,
      at: 0,
      data: { kind: "department.updated", id: eng.id },
    });
    expect(store.getState().departments[0]?.name).toBe("Platform");
  });

  it("fetches the employee that changed", async () => {
    await follow(fakeApi()).apply({
      offset: 4,
      officeId,
      at: 0,
      data: { kind: "employee.updated", id: ada.id },
    });
    expect(store.getState().employees[0]?.role).toBe("Staff engineer");
  });

  it("lights somebody up when a task of theirs starts moving", async () => {
    expect(store.getState().activityOf(ada.id)).toBe("idle");
    await follow(fakeApi()).apply({
      offset: 4,
      officeId,
      at: 0,
      data: { kind: "task.updated", id: "task-1" },
    });
    expect(store.getState().activityOf(ada.id)).toBe("working");
  });

  it("remembers how far it has got, so a reconnect asks for the rest", async () => {
    await follow(fakeApi()).apply({
      offset: 9,
      officeId,
      at: 0,
      data: { kind: "department.updated", id: eng.id },
    });
    expect(store.getState().seenOffset).toBe(9);
  });

  it("adds something created elsewhere rather than ignoring it", async () => {
    const sales = { ...eng, id: "dept-sales" as DepartmentId, name: "Sales" };
    const api = fakeApi({ getDepartment: () => Promise.resolve({ ok: true, value: sales }) });
    await follow(api).apply({
      offset: 5,
      officeId,
      at: 0,
      data: { kind: "department.created", id: sales.id },
    });
    expect(store.getState().departments.map((d) => d.name)).toEqual(["Engineering", "Sales"]);
  });

  it("takes away something deleted elsewhere", async () => {
    await follow(fakeApi()).apply({
      offset: 5,
      officeId,
      at: 0,
      data: { kind: "department.deleted", id: eng.id },
    });
    expect(store.getState().departments).toEqual([]);
  });

  it("does not ask the office about an event it cannot act on", async () => {
    const getDepartment = vi.fn(() => Promise.resolve({ ok: true as const, value: eng }));
    await follow(fakeApi({ getDepartment })).apply({
      offset: 5,
      officeId,
      at: 0,
      data: { kind: "office.created", id: officeId },
    });
    expect(getDepartment).not.toHaveBeenCalled();
  });

  it("leaves the canvas alone when the office cannot be reached", async () => {
    const api = fakeApi({
      getDepartment: () =>
        Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
    });
    await follow(api).apply({
      offset: 5,
      officeId,
      at: 0,
      data: { kind: "department.updated", id: eng.id },
    });
    expect(store.getState().departments[0]?.name).toBe("Engineering");
  });

  it("still moves on from an event it could not fetch, rather than asking forever", async () => {
    const api = fakeApi({
      getDepartment: () =>
        Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
    });
    await follow(api).apply({
      offset: 5,
      officeId,
      at: 0,
      data: { kind: "department.updated", id: eng.id },
    });
    expect(store.getState().seenOffset).toBe(5);
  });
});

describe("falling too far behind", () => {
  it("loads the office again from scratch", async () => {
    const loadOffice = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          office: { id: officeId } as never,
          departments: [{ ...eng, name: "Renamed while away" }],
          employees: [],
          tasks: [],
          connections: [],
        },
      }),
    );
    await follow(fakeApi({ loadOffice })).reload();
    expect(loadOffice).toHaveBeenCalledWith(officeId);
    expect(store.getState().departments[0]?.name).toBe("Renamed while away");
  });

  it("says nothing changed when the office cannot be reached", async () => {
    const api = fakeApi({
      loadOffice: () => Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
    });
    await follow(api).reload();
    expect(store.getState().departments[0]?.name).toBe("Engineering");
    expect(store.getState().notice).toMatch(/unreachable/);
  });
});

describe("the arrows the office says are there", () => {
  it("draws them when the office is loaded", async () => {
    const sales = { ...eng, id: "dept-sales" as DepartmentId, name: "Sales" };
    const api = fakeApi({
      loadOffice: () =>
        Promise.resolve({
          ok: true,
          value: {
            office: { id: officeId } as never,
            departments: [eng, sales],
            employees: [],
            tasks: [],
            connections: [
              {
                id: "conn-1",
                officeId,
                fromId: eng.id,
                toId: sales.id,
                kind: "handoff",
                rules: {},
                createdAt: at,
              },
            ] as never,
          },
        }),
    });

    await follow(api).reload();
    expect(store.getState().links).toHaveLength(1);
    expect(store.getState().links[0]).toMatchObject({ from: eng.id, to: sales.id });
  });
});

describe("the office itself changing", () => {
  const acme = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" },
    priority: "normal",
    configVersion: 1,
    createdAt: at,
  } as never;

  it("holds the office when it is loaded, so its priority can be shown", async () => {
    const api = fakeApi({
      loadOffice: () =>
        Promise.resolve({
          ok: true,
          value: { office: acme, departments: [eng], employees: [], tasks: [], connections: [] },
        }),
    });
    await follow(api).reload();
    expect(store.getState().office?.name).toBe("Acme");
  });

  it("fetches the office again when it is told the office changed", async () => {
    const api = fakeApi({
      getOffice: () =>
        Promise.resolve({ ok: true, value: { ...(acme as object), priority: "urgent" } as never }),
    });
    await follow(api).apply({
      offset: 4,
      officeId,
      at: 0,
      data: { kind: "office.updated", id: officeId },
    });
    expect(store.getState().office?.priority).toBe("urgent");
  });

  it("leaves the office alone when it cannot be reached", async () => {
    store.getState().loadOffice(acme);
    const api = fakeApi({
      getOffice: () => Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
    });
    await follow(api).apply({
      offset: 4,
      officeId,
      at: 0,
      data: { kind: "office.updated", id: officeId },
    });
    expect(store.getState().office?.priority).toBe("normal");
  });
});
