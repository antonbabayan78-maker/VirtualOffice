import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEPARTMENT_SIZE,
  MIN_DEPARTMENT_SIZE,
  createDepartment,
  createEmployee,
  unwrap,
  type Connection,
  type ConnectionId,
  type Connector,
  type ConnectorId,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "./office-store.js";
import type { StoredLayout } from "./layout-storage.js";

const officeId = "office-acme" as OfficeId;

function department(name: string, x: number, y: number): Department {
  return unwrap(
    createDepartment({ officeId, name, color: "#3366ff", position: { x, y } }, [], {
      id: () => `dept-${name.toLowerCase()}` as DepartmentId,
      now: () => new Date("2026-09-28T09:00:00Z"),
    }),
  );
}

const eng = department("Engineering", 0, 0);
const sales = department("Sales", 600, 0);

const connection = (from: Department, to: Department, kind = "handoff"): Connection => ({
  id: `conn-${from.name}-${to.name}` as ConnectionId,
  officeId,
  fromId: from.id,
  toId: to.id,
  kind: kind as Connection["kind"],
  enabled: true,
  rules: {},
  createdAt: new Date("2026-09-28T09:00:00Z"),
});
const engToSales = connection(eng, sales);
const salesToEng = connection(sales, eng);

function staff(name: string, department: Department): Employee {
  return unwrap(
    createEmployee(
      {
        name,
        role: "Engineer",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: department.id, officeId }, supervisor: null },
      {
        id: () => `emp-${name.toLowerCase()}` as EmployeeId,
        now: () => new Date("2026-09-28T09:00:00Z"),
      },
    ),
  );
}
const ada = staff("Ada", eng);
const grace = staff("Grace", eng);

function memoryStorage(initial: StoredLayout | null = null) {
  let saved = initial;
  return {
    port: {
      readLayout: () => saved,
      writeLayout: (layout: StoredLayout) => {
        saved = layout;
      },
    },
    saved: () => saved,
  };
}

let store: OfficeStore;
let storage: ReturnType<typeof memoryStorage>;

function open(
  departments: readonly Department[] = [eng, sales],
  employees: readonly Employee[] = [],
  initial: StoredLayout | null = null,
) {
  storage = memoryStorage(initial);
  store = createOfficeStore({
    storage: storage.port,
    id: () => "dept-new",
    now: () => new Date("2026-09-28T10:00:00Z"),
  });
  store.getState().load(departments, employees);
  return store;
}

beforeEach(() => {
  open();
});

describe("loading an office", () => {
  it("shows the departments the office has", () => {
    expect(store.getState().departments.map((d) => d.name)).toEqual(["Engineering", "Sales"]);
  });

  it("puts each one where the office file says", () => {
    expect(store.getState().departments[0]?.position).toEqual({ x: 0, y: 0 });
    expect(store.getState().departments[1]?.position).toEqual({ x: 600, y: 0 });
  });

  it("gives a department the default size when the file gave none", () => {
    expect(store.getState().departments[0]?.size).toEqual(DEFAULT_DEPARTMENT_SIZE);
  });
});

describe("moving a department", () => {
  it("moves it", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(store.getState().departments[0]?.position).toEqual({ x: 120, y: 80 });
  });

  it("leaves the others alone", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(store.getState().departments[1]?.position).toEqual({ x: 600, y: 0 });
  });

  it("ignores a department that is not there", () => {
    const before = store.getState().departments;
    store.getState().moveDepartment("dept-nowhere" as DepartmentId, { x: 1, y: 1 });
    expect(store.getState().departments).toEqual(before);
  });

  it("snaps to the grid when snapping is on", () => {
    store.getState().setSnapToGrid(true);
    store.getState().moveDepartment(eng.id, { x: 97, y: 33 });
    // A 20px grid: 97 -> 100, 33 -> 40.
    expect(store.getState().departments[0]?.position).toEqual({ x: 100, y: 40 });
  });

  it("leaves the position exactly where it was put when snapping is off", () => {
    store.getState().moveDepartment(eng.id, { x: 97, y: 33 });
    expect(store.getState().departments[0]?.position).toEqual({ x: 97, y: 33 });
  });
});

describe("resizing a department", () => {
  it("resizes it", () => {
    store.getState().resizeDepartment(eng.id, { width: 640, height: 400 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 640, height: 400 });
  });

  it("will not go below the size core allows", () => {
    store.getState().resizeDepartment(eng.id, { width: 10, height: 10 });
    expect(store.getState().departments[0]?.size).toEqual(MIN_DEPARTMENT_SIZE);
  });

  it("snaps the size to the grid too", () => {
    store.getState().setSnapToGrid(true);
    store.getState().resizeDepartment(eng.id, { width: 453, height: 328 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 460, height: 320 });
  });
});

describe("adding a department", () => {
  it("adds one where it was dropped", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Legal", color: "#884400", position: { x: 40, y: 500 } });
    expect(added.ok).toBe(true);
    expect(store.getState().departments.map((d) => d.name)).toContain("Legal");
    expect(store.getState().departments.at(-1)?.position).toEqual({ x: 40, y: 500 });
  });

  it("refuses a name the office already uses, and says why", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Engineering", color: "#884400", position: { x: 0, y: 0 } });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error[0]?.message).toMatch(/name/i);
    expect(store.getState().departments).toHaveLength(2);
  });

  it("refuses a colour that is not a colour", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Legal", color: "nope", position: { x: 0, y: 0 } });
    expect(added.ok).toBe(false);
    expect(store.getState().departments).toHaveLength(2);
  });
});

describe("the people in the office", () => {
  it("has nobody until an office is loaded with employees", () => {
    expect(store.getState().employees).toEqual([]);
  });

  it("keeps everyone idle until there is work in flight", () => {
    open([eng], [], undefined);
    expect(store.getState().activityOf("emp-ada" as EmployeeId)).toBe("idle");
  });

  it("shows somebody working once a task of theirs is under way", () => {
    store.getState().putTask({
      id: "task-1",
      status: "in_progress",
      assigneeId: "emp-ada",
      reviewerIds: [],
    } as never);
    expect(store.getState().activityOf("emp-ada" as EmployeeId)).toBe("working");
  });

  it("leaves everyone else alone", () => {
    store.getState().putTask({
      id: "task-1",
      status: "escalated",
      assigneeId: "emp-ada",
      reviewerIds: [],
    } as never);
    expect(store.getState().activityOf("emp-bob" as EmployeeId)).toBe("idle");
  });

  it("puts somebody back to idle when their task is finished", () => {
    const task = { id: "task-1", status: "in_progress", assigneeId: "emp-ada", reviewerIds: [] };
    store.getState().putTask(task as never);
    store.getState().putTask({ ...task, status: "done" } as never);
    expect(store.getState().activityOf("emp-ada" as EmployeeId)).toBe("idle");
  });
});

describe("selection", () => {
  it("selects and deselects", () => {
    store.getState().select(eng.id);
    expect(store.getState().selectedId).toBe(eng.id);
    store.getState().select(null);
    expect(store.getState().selectedId).toBeNull();
  });
});

describe("remembering the layout", () => {
  it("writes a move to storage", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(storage.saved()?.departments[eng.id]).toMatchObject({ position: { x: 120, y: 80 } });
  });

  it("writes a resize to storage", () => {
    store.getState().resizeDepartment(eng.id, { width: 640, height: 400 });
    expect(storage.saved()?.departments[eng.id]).toMatchObject({
      size: { width: 640, height: 400 },
    });
  });

  it("remembers whether snapping was on", () => {
    store.getState().setSnapToGrid(true);
    expect(storage.saved()?.snapToGrid).toBe(true);
  });

  it("puts departments back where they were left", () => {
    open([eng, sales], [], {
      departments: {
        [eng.id]: { position: { x: 300, y: 200 }, size: { width: 500, height: 340 } },
      },
      snapToGrid: true,
    });
    expect(store.getState().departments[0]?.position).toEqual({ x: 300, y: 200 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 500, height: 340 });
    expect(store.getState().settings.snapToGrid).toBe(true);
  });

  it("ignores a remembered layout for a department the office no longer has", () => {
    open([eng], [], {
      departments: { "dept-gone": { position: { x: 1, y: 1 }, size: { width: 300, height: 300 } } },
      snapToGrid: false,
    });
    expect(store.getState().departments).toHaveLength(1);
    expect(store.getState().departments[0]?.name).toBe("Engineering");
  });
});

describe("the connections between departments", () => {
  it("starts with none, since an office file may have none", () => {
    expect(store.getState().connections).toEqual([]);
  });

  it("holds what the office was loaded with", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    expect(store.getState().connections).toEqual([engToSales]);
  });

  it("draws them as arrows, one per relationship", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    expect(store.getState().links).toHaveLength(1);
    expect(store.getState().links[0]).toMatchObject({ from: eng.id, to: sales.id, twoWay: false });
  });

  it("redraws when a connection arrives from somewhere else", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    store.getState().putConnection(salesToEng);
    expect(store.getState().links).toHaveLength(1);
    expect(store.getState().links[0]?.twoWay).toBe(true);
  });

  it("replaces a connection rather than listing it twice", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    store.getState().putConnection({ ...engToSales, kind: "reviews" });
    expect(store.getState().connections).toHaveLength(1);
    expect(store.getState().connections[0]?.kind).toBe("reviews");
  });

  it("takes an arrow away when its connection goes", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    store.getState().removeConnection(engToSales.id);
    expect(store.getState().links).toEqual([]);
  });

  it("forgets connections to a department that is no longer there", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    store.getState().load([eng], [], [], [engToSales]);
    // An arrow to nowhere cannot be drawn, whatever the office still holds.
    expect(store.getState().links).toEqual([]);
  });
});

describe("closing a department down", () => {
  it("removes an empty one", () => {
    store.getState().load([eng, sales], []);
    const result = store.getState().removeDepartment(sales.id);
    expect(result.ok).toBe(true);
    expect(store.getState().departments.map((d) => d.id)).toEqual([eng.id]);
  });

  it("will not remove one that still has people in it", () => {
    store.getState().load([eng, sales], [ada]);
    const result = store.getState().removeDepartment(eng.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/1 person|people|employee/i);
    expect(store.getState().departments).toHaveLength(2);
  });

  it("says how many people are in the way, so the message is actionable", () => {
    store.getState().load([eng, sales], [ada, grace]);
    const result = store.getState().removeDepartment(eng.id);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/2/);
  });

  it("takes its connections with it, rather than leaving arrows to nowhere", () => {
    store.getState().load([eng, sales], [], [], [engToSales]);
    store.getState().removeDepartment(sales.id);
    expect(store.getState().connections).toEqual([]);
  });

  it("clears the selection when the selected department goes", () => {
    store.getState().load([eng, sales], []);
    store.getState().select(sales.id);
    store.getState().removeDepartment(sales.id);
    expect(store.getState().selectedId).toBeNull();
  });

  it("refuses a department that is not there rather than pretending it worked", () => {
    store.getState().load([eng], []);
    expect(store.getState().removeDepartment(sales.id).ok).toBe(false);
  });
});

describe("changes that change nothing", () => {
  it("leaves the departments alone when a move lands where it already was", () => {
    open([eng, sales]);
    const before = store.getState().departments;
    store.getState().moveDepartment(eng.id, eng.position);

    // Same array, not an equal one: a new array re-renders the canvas, which
    // re-measures, which reports another change — a loop that never settles.
    expect(store.getState().departments).toBe(before);
  });

  it("leaves them alone when a resize reports the size they already are", () => {
    open([eng, sales]);
    const before = store.getState().departments;
    store.getState().resizeDepartment(eng.id, eng.size);
    expect(store.getState().departments).toBe(before);
  });

  it("still applies a move that actually moves something", () => {
    open([eng, sales]);
    store.getState().moveDepartment(eng.id, { x: 120, y: 240 });
    expect(store.getState().departments.find((d) => d.id === eng.id)?.position).toEqual({
      x: 120,
      y: 240,
    });
  });

  it("does not write the layout out again when nothing moved", () => {
    open([eng, sales]);
    const written = storage.saved();
    store.getState().moveDepartment(eng.id, eng.position);
    expect(storage.saved()).toBe(written);
  });
});

describe("the office itself", () => {
  const acme = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  it("is unknown until the office is loaded", () => {
    open([eng]);
    expect(store.getState().office).toBeNull();
  });

  it("is held once it is loaded", () => {
    open([eng]);
    store.getState().loadOffice(acme);
    expect(store.getState().office?.name).toBe("Acme");
  });

  it("takes a change, so the organisation can set its own priority", async () => {
    open([eng]);
    store.getState().loadOffice(acme);
    const result = await store.getState().saveOffice({ priority: "urgent" });

    expect(result.ok).toBe(true);
    expect(store.getState().office?.priority).toBe("urgent");
  });

  it("refuses a change the office model would refuse, without asking the server", async () => {
    open([eng]);
    store.getState().loadOffice(acme);
    const result = await store.getState().saveOffice({ priority: "asap" });

    expect(result.ok).toBe(false);
    expect(store.getState().office?.priority).toBe("normal");
  });

  it("says so when there is no office to change", async () => {
    open([eng]);
    expect((await store.getState().saveOffice({ priority: "high" })).ok).toBe(false);
  });
});

describe("changes that change nothing, revisited", () => {
  it("still lets an edit through that only touches a field the move guard ignores", () => {
    open([eng, sales]);
    const result = store.getState().updateDepartment(eng.id, { priority: "urgent" });
    expect(result.ok).toBe(true);
    expect(store.getState().departments.find((d) => d.id === eng.id)?.priority).toBe("urgent");
  });
});

describe("being told where the office actually lives", () => {
  const acme = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  /** Records what was sent, so a save that never leaves the browser is visible. */
  function spyApi() {
    const sent: { what: string; changes: Record<string, unknown> }[] = [];
    return {
      sent,
      api: {
        patchDepartment: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "department", changes });
          return Promise.resolve({ ok: true as const, value: { ...eng, ...changes } as never });
        },
        patchEmployee: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "employee", changes });
          return Promise.resolve({ ok: true as const, value: { ...ada, ...changes } as never });
        },
        patchOffice: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "office", changes });
          return Promise.resolve({ ok: true as const, value: { ...acme, ...changes } as never });
        },
      } as never,
    };
  }

  it("keeps a save in the browser until it is told who to send it to", async () => {
    open([eng, sales]);
    const result = await store.getState().saveDepartment(eng.id, { priority: "urgent" });
    // Locally applied and honestly reported, but nobody was told.
    expect(result.ok).toBe(true);
  });

  it("sends a department change once it has been connected", async () => {
    open([eng, sales]);
    const spy = spyApi();
    store.getState().connect(spy.api);
    await store.getState().saveDepartment(eng.id, { priority: "urgent" });

    expect(spy.sent).toEqual([{ what: "department", changes: { priority: "urgent" } }]);
  });

  it("sends an employee change too", async () => {
    open([eng, sales], [ada]);
    const spy = spyApi();
    store.getState().connect(spy.api);
    await store.getState().saveEmployee(ada.id, { priority: "low" });

    expect(spy.sent[0]?.what).toBe("employee");
  });

  it("sends an office change too", async () => {
    open([eng, sales]);
    store.getState().loadOffice(acme);
    const spy = spyApi();
    store.getState().connect(spy.api);
    await store.getState().saveOffice({ priority: "high" });

    expect(spy.sent[0]?.what).toBe("office");
  });
});

describe("changing an arrow from the canvas", () => {
  const arrow = {
    ...engToSales,
    kind: "watches" as const,
    enabled: true,
    rules: { for: ["work_went_wrong"] },
  };

  function spyApi() {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      api: {
        patchConnection: (_id: string, changes: Record<string, unknown>) => {
          sent.push(changes);
          return Promise.resolve({ ok: true as const, value: { ...arrow, ...changes } as never });
        },
      } as never,
    };
  }

  it("switches one off, and shows it off at once", async () => {
    open([eng, sales]);
    store.getState().load([eng, sales], [], [], [arrow]);
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store.getState().saveConnection(arrow.id, { enabled: false });
    expect(result.ok).toBe(true);
    expect(store.getState().connections[0]?.enabled).toBe(false);
    expect(spy.sent).toEqual([{ enabled: false }]);
  });

  it("stops drawing a switched-off arrow as if it were in force", async () => {
    open([eng, sales]);
    store.getState().load([eng, sales], [], [], [arrow]);
    store.getState().connect(spyApi().api);
    await store.getState().saveConnection(arrow.id, { enabled: false });

    expect(store.getState().links[0]?.enabled).toBe(false);
  });

  it("puts it back when the office refuses the change", async () => {
    open([eng, sales]);
    store.getState().load([eng, sales], [], [], [arrow]);
    store.getState().connect({
      patchConnection: () =>
        Promise.resolve({
          ok: false as const,
          kind: "validation" as const,
          errors: [{ path: "rules.for", message: "no such moment" }],
        }),
    } as never);

    const result = await store.getState().saveConnection(arrow.id, { enabled: false });
    expect(result.ok).toBe(false);
    expect(store.getState().connections[0]?.enabled).toBe(true);
  });

  it("says so when there is no such arrow", async () => {
    open([eng, sales]);
    expect((await store.getState().saveConnection(arrow.id, { enabled: false })).ok).toBe(false);
  });
});

describe("what the office can reach", () => {
  const web = (overrides: Partial<Connector> = {}): Connector => ({
    id: "conn-web" as ConnectorId,
    officeId,
    kind: "web",
    name: "design-web",
    config: { hosts: ["help.figma.com"] },
    secretRef: null,
    tools: ["fetch_url"],
    enabled: true,
    createdAt: new Date("2026-09-28T09:00:00Z"),
    ...overrides,
  });

  it("knows about none of them until it is told", () => {
    open([eng]);
    expect(store.getState().connectors).toEqual([]);
  });

  it("holds the ones the office listed", () => {
    open([eng]);
    store.getState().loadConnectors([web()]);
    expect(store.getState().connectors.map((c) => c.name)).toEqual(["design-web"]);
  });

  it("lists them by name, so a panel does not reorder itself", () => {
    // Creation order is whatever the office happens to answer with; a settings
    // panel that rearranges while you use it is worse than a slow one.
    open([eng]);
    store.getState().loadConnectors([web({ id: "conn-z" as ConnectorId, name: "ops-web" }), web()]);
    expect(store.getState().connectors.map((c) => c.name)).toEqual(["design-web", "ops-web"]);
  });

  it("replaces one it already knows rather than listing it twice", () => {
    open([eng]);
    store.getState().loadConnectors([web()]);
    store.getState().putConnector(web({ enabled: false }));

    expect(store.getState().connectors).toHaveLength(1);
    expect(store.getState().connectors[0]?.enabled).toBe(false);
  });

  it("takes one it is told has gone", () => {
    open([eng]);
    store.getState().loadConnectors([web()]);
    store.getState().dropConnector("conn-web" as ConnectorId);
    expect(store.getState().connectors).toEqual([]);
  });
});

describe("wiring an office up from the canvas", () => {
  const acme = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  const web = (overrides: Partial<Connector> = {}): Connector => ({
    id: "conn-web" as ConnectorId,
    officeId,
    kind: "web",
    name: "design-web",
    config: { hosts: ["help.figma.com"] },
    secretRef: null,
    tools: ["fetch_url"],
    enabled: true,
    createdAt: new Date("2026-09-28T09:00:00Z"),
    ...overrides,
  });

  function spyApi(answers: Readonly<Record<string, unknown>> = {}) {
    const sent: { what: string; body: unknown }[] = [];
    return {
      sent,
      api: {
        createConnector: (_officeId: string, input: Record<string, unknown>) => {
          sent.push({ what: "create", body: input });
          return Promise.resolve(
            answers["create"] ?? { ok: true as const, value: web({ name: String(input["name"]) }) },
          );
        },
        patchConnector: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "patch", body: { id, changes } });
          return Promise.resolve(
            answers["patch"] ?? { ok: true as const, value: { ...web(), ...changes } },
          );
        },
        deleteConnector: (id: string) => {
          sent.push({ what: "delete", body: id });
          return Promise.resolve(answers["delete"] ?? { ok: true as const, value: true as const });
        },
      } as never,
    };
  }

  const opened = (connectors: readonly Connector[] = []) => {
    open([eng]);
    store.getState().loadOffice(acme);
    store.getState().loadConnectors(connectors);
  };

  it("refuses to add one on a canvas that has no office yet", async () => {
    open([eng]);
    const result = await store.getState().addConnector({ kind: "web", name: "design-web" });
    expect(result.ok).toBe(false);
  });

  it("adds one at the office and shows what came back", async () => {
    opened();
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store.getState().addConnector({ kind: "web", name: "design-web" });
    expect(result.ok).toBe(true);
    expect(store.getState().connectors.map((c) => c.name)).toEqual(["design-web"]);
  });

  it("names the tools the kind offers, so what it adds can be granted", async () => {
    // A connector with no tools is one the office can grant nothing of, which
    // is how adding one from the canvas would otherwise achieve nothing.
    opened();
    const spy = spyApi();
    store.getState().connect(spy.api);
    await store.getState().addConnector({ kind: "web", name: "design-web" });

    expect((spy.sent[0]?.body as Record<string, unknown>)["tools"]).toEqual(["fetch_url"]);
  });

  it("does not put one on the canvas the office never made", async () => {
    // Nothing optimistic here: the office decides the id, and a connector with
    // an invented one cannot be switched off or granted.
    opened();
    store.getState().connect({
      createConnector: () =>
        Promise.resolve({
          ok: false as const,
          kind: "validation" as const,
          errors: [{ path: "name", message: "must be a kebab-case identifier" }],
        }),
    } as never);

    const result = await store.getState().addConnector({ kind: "web", name: "Design Web" });
    expect(result.ok).toBe(false);
    expect(store.getState().connectors).toEqual([]);
  });

  it("switches one off, and shows it off at once", async () => {
    opened([web()]);
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store.getState().saveConnector("conn-web" as ConnectorId, {
      enabled: false,
    });
    expect(result.ok).toBe(true);
    expect(store.getState().connectors[0]?.enabled).toBe(false);
    expect(spy.sent).toEqual([
      { what: "patch", body: { id: "conn-web", changes: { enabled: false } } },
    ]);
  });

  it("refuses a change core would refuse, without asking the office", async () => {
    opened([web()]);
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store
      .getState()
      .saveConnector("conn-web" as ConnectorId, { name: "Design Web" });
    expect(result.ok).toBe(false);
    expect(spy.sent).toEqual([]);
  });

  it("refuses a name another connector already has", async () => {
    // The office would refuse it too; refusing here says so while the panel is
    // still open rather than after a round trip.
    opened([web(), web({ id: "conn-ops" as ConnectorId, name: "ops-web" })]);
    store.getState().connect(spyApi().api);

    const result = await store
      .getState()
      .saveConnector("conn-web" as ConnectorId, { name: "ops-web" });
    expect(result.ok).toBe(false);
  });

  it("lets a connector keep its own name", async () => {
    opened([web()]);
    store.getState().connect(spyApi().api);
    const result = await store
      .getState()
      .saveConnector("conn-web" as ConnectorId, { name: "design-web", config: { hosts: [] } });
    expect(result.ok).toBe(true);
  });

  it("puts it back when the office refuses the change", async () => {
    opened([web()]);
    store.getState().connect({
      patchConnector: () =>
        Promise.resolve({
          ok: false as const,
          kind: "validation" as const,
          errors: [{ path: "config", message: "must be an object" }],
        }),
    } as never);

    const result = await store
      .getState()
      .saveConnector("conn-web" as ConnectorId, { enabled: false });
    expect(result.ok).toBe(false);
    expect(store.getState().connectors[0]?.enabled).toBe(true);
  });

  it("says so when there is no such connector", async () => {
    opened();
    expect(
      (await store.getState().saveConnector("conn-web" as ConnectorId, { enabled: false })).ok,
    ).toBe(false);
  });

  it("removes one, and puts it back if the office refuses", async () => {
    opened([web()]);
    store.getState().connect({
      deleteConnector: () =>
        Promise.resolve({ ok: false as const, kind: "transport" as const, message: "offline" }),
    } as never);

    const result = await store.getState().removeConnector("conn-web" as ConnectorId);
    expect(result.ok).toBe(false);
    expect(store.getState().connectors).toHaveLength(1);
  });

  it("removes one for good when the office agrees", async () => {
    opened([web()]);
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store.getState().removeConnector("conn-web" as ConnectorId);
    expect(result.ok).toBe(true);
    expect(store.getState().connectors).toEqual([]);
    expect(spy.sent).toEqual([{ what: "delete", body: "conn-web" }]);
  });

  it("leaves grants that named a removed connector alone", async () => {
    // They resolve to nothing without it, and pruning grants across two other
    // entities from here would be a change nobody asked this panel to make.
    opened([web()]);
    store.getState().connect(spyApi().api);
    await store.getState().removeConnector("conn-web" as ConnectorId);

    expect(store.getState().departments[0]?.toolGrants).toEqual([]);
  });
});

describe("stopping and starting work from the canvas", () => {
  const acme = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  function spyApi(answers: Readonly<Record<string, unknown>> = {}) {
    const sent: { what: string; id: string; to: string }[] = [];
    return {
      sent,
      api: {
        setOfficeRunState: (id: string, runState: string) => {
          sent.push({ what: "office", id, to: runState });
          return Promise.resolve(answers["office"] ?? { ok: true, value: { ...acme, runState } });
        },
        setDepartmentRunState: (id: string, runState: string) => {
          sent.push({ what: "department", id, to: runState });
          return Promise.resolve(
            answers["department"] ?? { ok: true, value: { ...eng, runState } },
          );
        },
        setEmployeeStatus: (id: string, status: string) => {
          sent.push({ what: "employee", id, to: status });
          return Promise.resolve(answers["employee"] ?? { ok: true, value: { ...ada, status } });
        },
      } as never,
    };
  }

  it("stops the office, and shows it stopped at once", async () => {
    open([eng]);
    store.getState().loadOffice(acme);
    const spy = spyApi();
    store.getState().connect(spy.api);

    const result = await store.getState().saveOfficeRunState("paused");
    expect(result.ok).toBe(true);
    expect(store.getState().office?.runState).toBe("paused");
    expect(spy.sent).toEqual([{ what: "office", id: officeId, to: "paused" }]);
  });

  it("puts the office back when the office refuses", async () => {
    open([eng]);
    store.getState().loadOffice(acme);
    store.getState().connect({
      setOfficeRunState: () =>
        Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
    } as never);

    const result = await store.getState().saveOfficeRunState("paused");
    expect(result.ok).toBe(false);
    expect(store.getState().office?.runState).toBe("running");
  });

  it("says so on a canvas with no office", async () => {
    open([eng]);
    expect((await store.getState().saveOfficeRunState("paused")).ok).toBe(false);
  });

  it("stops one room without touching the office", async () => {
    open([eng, sales]);
    store.getState().loadOffice(acme);
    const spy = spyApi();
    store.getState().connect(spy.api);

    await store.getState().saveDepartmentRunState(eng.id, "paused");
    expect(store.getState().departments[0]?.runState).toBe("paused");
    expect(store.getState().office?.runState).toBe("running");
    expect(spy.sent).toEqual([{ what: "department", id: eng.id, to: "paused" }]);
  });

  it("leaves the other rooms alone", async () => {
    open([eng, sales]);
    store.getState().connect(spyApi().api);
    await store.getState().saveDepartmentRunState(eng.id, "paused");

    expect(store.getState().departments[1]?.runState).toBe("running");
  });

  it("puts a room back when the office refuses", async () => {
    open([eng, sales]);
    store.getState().connect({
      setDepartmentRunState: () =>
        Promise.resolve({
          ok: false,
          kind: "validation",
          errors: [{ path: "runState", message: "must be one of running, paused" }],
        }),
    } as never);

    const result = await store.getState().saveDepartmentRunState(eng.id, "paused");
    expect(result.ok).toBe(false);
    expect(store.getState().departments[0]?.runState).toBe("running");
  });

  it("pauses a person", async () => {
    open([eng], [ada]);
    const spy = spyApi();
    store.getState().connect(spy.api);

    await store.getState().saveEmployeeStatus(ada.id, "paused");
    expect(store.getState().employees[0]?.status).toBe("paused");
    expect(spy.sent).toEqual([{ what: "employee", id: ada.id, to: "paused" }]);
  });

  it("leaves their open work where it is", async () => {
    // Pausing somebody is not reassigning their desk.
    open([eng], [ada]);
    store.getState().connect(spyApi().api);
    store.getState().putTask({
      id: "task-1",
      officeId,
      departmentId: eng.id,
      assigneeId: ada.id,
      status: "in_progress",
      reviewerIds: [],
      history: [],
    } as never);

    await store.getState().saveEmployeeStatus(ada.id, "paused");
    expect(store.getState().tasks[0]?.assigneeId).toBe(ada.id);
  });

  it("puts somebody back when the office refuses to move them", async () => {
    open([eng], [ada]);
    store.getState().connect({
      setEmployeeStatus: () =>
        Promise.resolve({
          ok: false,
          kind: "validation",
          errors: [{ path: "status", message: "employee is terminated" }],
        }),
    } as never);

    const result = await store.getState().saveEmployeeStatus(ada.id, "active");
    expect(result.ok).toBe(false);
    expect(store.getState().employees[0]?.status).toBe("active");
  });

  it("says so when there is no such person", async () => {
    open([eng]);
    expect((await store.getState().saveEmployeeStatus(ada.id, "paused")).ok).toBe(false);
  });

  it("applies a change with nobody to send it to", async () => {
    // A canvas with no server still works, as every other save here does.
    open([eng]);
    store.getState().loadOffice(acme);
    expect((await store.getState().saveOfficeRunState("paused")).ok).toBe(true);
    expect(store.getState().office?.runState).toBe("paused");
  });
});
