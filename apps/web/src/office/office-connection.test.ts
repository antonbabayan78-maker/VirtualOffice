import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@vo/api-client";
import { createOfficeStore, type OfficeStore } from "./office-store.js";
import { connectOffice } from "./office-connection.js";

const at = new Date("2026-10-01T09:00:00Z");

const emptyStore = (): OfficeStore =>
  createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });

const snapshot = {
  office: { id: "office-1", name: "Acme", schedule: { kind: "always" } },
  departments: [{ id: "dept-eng", officeId: "office-1", name: "Engineering" }],
  employees: [],
  tasks: [],
  connections: [],
  connectors: [],
};

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const nothing = () => Promise.resolve({ ok: true as const, value: [] as never });
  return {
    loadOffice: () => Promise.resolve({ ok: true, value: snapshot as never }),
    listDocuments: nothing,
    listUsage: nothing,
    listServices: nothing,
    listApprovals: () => Promise.resolve({ ok: true, value: [] }),
    listProposals: nothing,
    officeSpend: () =>
      Promise.resolve({
        ok: true as const,
        value: { officeUsd: 0, unpricedCalls: 0, byDepartment: {}, byEmployee: {} },
      }),
    ...overrides,
  } as unknown as ApiClient;
}

const config = {
  baseUrl: "http://office.test",
  streamUrl: "ws://office.test/ws",
  token: "sk-owner",
  officeId: "office-1",
};

/** A stream this test drives, standing in for the office's own. */
const fakeStream = () => {
  const closed = { count: 0 };
  return {
    closed,
    open: () => ({
      close: () => {
        closed.count += 1;
      },
    }),
  };
};

describe("connecting a canvas to its office", () => {
  it("tells the store who to save to, before anything is loaded", async () => {
    // Until this happens every drawer save stops in the browser, and the user
    // is told it worked.
    const store = emptyStore();
    const api = fakeApi();
    const connection = connectOffice({ store, config, api, openStream: fakeStream().open });
    await connection.ready;

    expect(store.getState().departments).toHaveLength(1);
    connection.close();
  });

  it("loads the office once, however many screens are showing", async () => {
    const loadOffice = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: snapshot as never }),
    );
    const store = emptyStore();
    const connection = connectOffice({
      store,
      config,
      api: fakeApi({ loadOffice }),
      openStream: fakeStream().open,
    });
    await connection.ready;

    expect(loadOffice).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("follows the office's events", async () => {
    let heard: ((event: Record<string, unknown>) => void) | null = null;
    const getDepartment = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { id: "dept-eng", officeId: "office-1", name: "Platform" } as never,
      }),
    );
    const store = emptyStore();
    const connection = connectOffice({
      store,
      config,
      api: fakeApi({ getDepartment }),
      openStream: (options) => {
        heard = options.onEvent;
        return { close: () => undefined };
      },
    });
    await connection.ready;

    await (heard as unknown as (event: Record<string, unknown>) => Promise<void>)({
      offset: 1,
      officeId: "office-1",
      at: 0,
      data: { kind: "department.updated", id: "dept-eng" },
    });
    expect(getDepartment).toHaveBeenCalled();
    connection.close();
  });

  it("closes the stream when it is let go", async () => {
    const stream = fakeStream();
    const connection = connectOffice({
      store: emptyStore(),
      config,
      api: fakeApi(),
      openStream: stream.open,
    });
    await connection.ready;
    connection.close();

    expect(stream.closed.count).toBe(1);
  });

  it("says what went wrong rather than leaving a blank canvas", async () => {
    const store = emptyStore();
    const connection = connectOffice({
      store,
      config,
      api: fakeApi({
        loadOffice: () => Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
      }),
      openStream: fakeStream().open,
    });
    await connection.ready;

    expect(store.getState().notice).toMatch(/unreachable/);
    connection.close();
  });
});
