import { beforeEach, describe, expect, it } from "vitest";
import {
  createDepartment,
  unwrap,
  type Department,
  type DepartmentId,
  type OfficeId,
} from "@vo/core";
import type { ApiClient, ApiResult } from "@vo/api-client";
import { createOfficeStore, type OfficeStore } from "./office-store.js";

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

/** An API whose answer this test decides, and decides when. */
function scriptedApi(): {
  readonly api: ApiClient;
  answer(result: ApiResult<Department>): void;
  readonly calls: { id: string; changes: Record<string, unknown>; sinceOffset: number }[];
} {
  const calls: { id: string; changes: Record<string, unknown>; sinceOffset: number }[] = [];
  let settle: ((result: ApiResult<Department>) => void) | null = null;

  const api: ApiClient = {
    loadOffice: () => Promise.reject(new Error("not used here")),
    getOffice: () => Promise.reject(new Error("not used here")),
    patchOffice: () => Promise.reject(new Error("not used here")),
    getDepartment: () => Promise.reject(new Error("not used here")),
    getEmployee: () => Promise.reject(new Error("not used here")),
    getTask: () => Promise.reject(new Error("not used here")),
    patchConnection: () => Promise.reject(new Error("not used here")),
    patchDepartment: (id, changes, sinceOffset) => {
      calls.push({ id, changes, sinceOffset });
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    patchEmployee: () => Promise.reject(new Error("not used here")),
    getDocument: () => Promise.reject(new Error("not used here")),
    listConnectors: () => Promise.resolve({ ok: true, value: [] }),
    createConnector: () => Promise.reject(new Error("not used here")),
    patchConnector: () => Promise.reject(new Error("not used here")),
    deleteConnector: () => Promise.reject(new Error("not used here")),
    listDocuments: () => Promise.reject(new Error("not used here")),
    uploadDocument: () => Promise.reject(new Error("not used here")),
    downloadDocument: () => Promise.reject(new Error("not used here")),
    deleteDocument: () => Promise.reject(new Error("not used here")),
    postTaskEvent: () => Promise.reject(new Error("not used here")),
  };

  return {
    api,
    calls,
    answer: (result) => {
      settle?.(result);
    },
  };
}

let store: OfficeStore;
let scripted: ReturnType<typeof scriptedApi>;

const nameNow = (): string | undefined =>
  store.getState().departments.find((d) => d.id === eng.id)?.name;

beforeEach(() => {
  scripted = scriptedApi();
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
    api: scripted.api,
  });
  store.getState().load([eng], []);
  store.getState().setSeenOffset(7);
});

describe("saving a department through the office", () => {
  it("shows the change before the office has answered", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    expect(nameNow()).toBe("Platform");

    scripted.answer({ ok: true, value: { ...eng, name: "Platform" } });
    await saving;
    expect(nameNow()).toBe("Platform");
  });

  it("tells the office what it was working from", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    expect(scripted.calls[0]).toMatchObject({ id: eng.id, sinceOffset: 7 });
    scripted.answer({ ok: true, value: { ...eng, name: "Platform" } });
    await saving;
  });

  it("takes what the office holds as the truth, not what was sent", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    // The office tidied the colour on the way through.
    scripted.answer({ ok: true, value: { ...eng, name: "Platform", color: "#112233" } });
    await saving;
    expect(store.getState().departments[0]?.color).toBe("#112233");
  });

  it("puts it back when the office refuses the change", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    expect(nameNow()).toBe("Platform");

    scripted.answer({
      ok: false,
      kind: "validation",
      errors: [{ path: "name", message: "already exists" }],
    });
    const result = await saving;

    expect(nameNow()).toBe("Engineering");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/already exists/);
  });

  it("shows what somebody else wrote when the change clashed", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    scripted.answer({
      ok: false,
      kind: "conflict",
      current: { ...eng, name: "Infrastructure" } as never,
    });
    const result = await saving;

    // Not the old name and not the attempted one: what the office actually holds.
    expect(nameNow()).toBe("Infrastructure");
    expect(result.ok).toBe(false);
    expect(store.getState().notice).toMatch(/somebody else|changed/i);
  });

  it("puts it back when the office could not be reached, and says so", async () => {
    const saving = store.getState().saveDepartment(eng.id, { name: "Platform" });
    scripted.answer({ ok: false, kind: "transport", message: "took too long" });
    const result = await saving;

    expect(nameNow()).toBe("Engineering");
    expect(result.ok).toBe(false);
    expect(store.getState().notice).toMatch(/took too long/);
  });

  it("does not trouble the office with a change it would refuse anyway", async () => {
    const result = await store.getState().saveDepartment(eng.id, { name: "" });
    expect(result.ok).toBe(false);
    expect(scripted.calls).toHaveLength(0);
    expect(nameNow()).toBe("Engineering");
  });

  it("works on its own when there is no office to talk to", async () => {
    const offline = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    offline.getState().load([eng], []);
    const result = await offline.getState().saveDepartment(eng.id, { name: "Platform" });
    expect(result.ok).toBe(true);
    expect(offline.getState().departments[0]?.name).toBe("Platform");
  });
});

describe("what the client has seen", () => {
  it("starts having seen nothing", () => {
    const fresh = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    expect(fresh.getState().seenOffset).toBe(0);
  });

  it("moves forward as the office reports what happened", () => {
    store.getState().setSeenOffset(12);
    expect(store.getState().seenOffset).toBe(12);
  });

  it("never goes backwards, since an older event is not newer news", () => {
    store.getState().setSeenOffset(12);
    store.getState().setSeenOffset(5);
    expect(store.getState().seenOffset).toBe(12);
  });
});
