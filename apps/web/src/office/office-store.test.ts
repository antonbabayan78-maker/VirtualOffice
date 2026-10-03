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
  type LlmService,
  type OfficeId,
  type Task,
  type TaskId,
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
    budget: null,
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
    budget: null,
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
    budget: null,
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
    budget: null,
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

describe("ids for things the canvas makes", () => {
  it("hands out ids from the same generator everything else here uses", () => {
    // A drawer that made its own would be unpredictable in a test and would
    // not follow the office's id scheme when one arrives.
    open([eng]);
    expect(store.getState().newId()).toBe("dept-new");
  });
});

describe("what the office has been spent on", () => {
  const spend = (id: string, taskId: string, employeeId: string, totalUsd: number | null) => ({
    id,
    officeId,
    taskId,
    employeeId,
    at: new Date("2026-10-01T09:00:00Z"),
    event: {
      kind: "llm_call",
      model: "claude-sonnet-5",
      durationMs: 1200,
      cost: totalUsd === null ? null : { totalUsd },
    },
  });

  it("knows about none of it until it is told", () => {
    open([eng]);
    expect(store.getState().usage).toEqual([]);
  });

  it("holds what the office reported", () => {
    open([eng]);
    store.getState().loadUsage([spend("u1", "task-1", "emp-ada", 0.004)] as never);
    expect(store.getState().usage).toHaveLength(1);
  });

  it("replaces the lot rather than adding to it", () => {
    // Loaded whole with the office, like documents: two loads must not double
    // every figure on the canvas.
    open([eng]);
    store.getState().loadUsage([spend("u1", "task-1", "emp-ada", 0.004)] as never);
    store.getState().loadUsage([spend("u1", "task-1", "emp-ada", 0.004)] as never);

    expect(store.getState().usage).toHaveLength(1);
  });
});

describe("what the office has spent, on the canvas", () => {
  it("knows nothing until it is told", () => {
    open([eng]);
    expect(store.getState().spend).toBeNull();
  });

  it("holds what the office reported", () => {
    open([eng]);
    store.getState().loadSpend({
      officeUsd: 9,
      unpricedCalls: 0,
      byDepartment: { [eng.id]: 4 },
      byEmployee: { "emp-ada": 2 },
    });

    expect(store.getState().spend?.officeUsd).toBe(9);
    expect(store.getState().spend?.byDepartment[eng.id]).toBe(4);
  });

  it("stays null when the office could not be asked, which is not nil spent", () => {
    // Zero and unknown look identical on a drawer, and one of them means the
    // figures could not be read.
    open([eng]);
    store.getState().loadSpend(null);
    expect(store.getState().spend).toBeNull();
  });
});

describe("saying which entry won a contest, from the canvas", () => {
  const entry = (id: string, assigneeId: string, status = "done"): Task =>
    ({
      id,
      officeId,
      departmentId: eng.id,
      title: "Draft the launch note",
      brief: "",
      priority: "normal",
      status,
      assigneeId,
      benchId: "bench-draft",
      contestId: "contest-1",
      won: null,
      reviewerIds: [],
      approvals: [],
      stage: null,
      gatedActions: [],
      dependsOn: [],
      artifacts: [],
      route: [],
      acceptanceCriteria: [],
      checkedBy: [],
      tokenBudget: null,
      deadline: null,
      history: [],
      createdAt: new Date("2026-10-01T09:00:00Z"),
      updatedAt: new Date("2026-10-01T09:00:00Z"),
    }) as unknown as Task;

  const withContest = () => {
    open([eng], [ada, grace]);
    store.getState().putTask(entry("task-a", ada.id));
    store.getState().putTask(entry("task-b", grace.id));
  };

  const taskNamed = (id: string) => store.getState().tasks.find((task) => task.id === id);

  it("marks the entry that won, with the reason", async () => {
    withContest();
    const outcome = await store.getState().recordContestWin("task-b" as TaskId, "clearer");

    expect(outcome.ok).toBe(true);
    expect(taskNamed("task-b")?.won?.reason).toBe("clearer");
  });

  it("says a person decided, since nobody else did", async () => {
    withContest();
    await store.getState().recordContestWin("task-b" as TaskId, "clearer");
    expect(taskNamed("task-b")?.won?.decidedBy).toBeNull();
  });

  it("leaves the entries that lost alone", async () => {
    withContest();
    await store.getState().recordContestWin("task-b" as TaskId, "clearer");
    expect(taskNamed("task-a")?.won).toBeNull();
  });

  it("refuses a second verdict, as the office would", async () => {
    withContest();
    await store.getState().recordContestWin("task-b" as TaskId, "clearer");
    const again = await store.getState().recordContestWin("task-a" as TaskId, "on reflection");

    expect(again.ok).toBe(false);
    expect(taskNamed("task-b")?.won?.reason).toBe("clearer");
  });

  it("refuses an entry whose answer is not in", async () => {
    open([eng], [ada, grace]);
    store.getState().putTask(entry("task-a", ada.id, "in_progress"));
    const outcome = await store.getState().recordContestWin("task-a" as TaskId, "a hunch");

    expect(outcome.ok).toBe(false);
  });

  it("says so for work that is not an entry in anything", async () => {
    open([eng], [ada]);
    store.getState().putTask({ ...entry("task-a", ada.id), contestId: null });
    const outcome = await store.getState().recordContestWin("task-a" as TaskId, "clearer");

    expect(outcome.ok).toBe(false);
  });

  it("says so for a task the canvas does not hold", async () => {
    open([eng], [ada]);
    expect((await store.getState().recordContestWin("task-nowhere" as TaskId, "clearer")).ok).toBe(
      false,
    );
  });
});

describe("answering what the office is waiting for", () => {
  const held = {
    kind: "call" as const,
    taskId: "task-1",
    title: "Tell the customer",
    departmentId: "dept-eng",
    assigneeId: "emp-ada",
    since: new Date("2026-10-03T09:00:00Z"),
    key: "toolu_1",
    name: "post__send_email",
    input: { to: "customer@acme.test" },
    gates: ["external_send"],
    detail: 'tool "post__send_email" (external_send)',
  };

  const parked = (overrides: Record<string, unknown> = {}): Task =>
    ({
      id: "task-1",
      officeId,
      departmentId: eng.id,
      title: "Tell the customer",
      status: "blocked",
      assigneeId: ada.id,
      contestId: null,
      won: null,
      reviewerIds: [],
      approvals: [],
      stage: null,
      gatedActions: [],
      dependsOn: [],
      artifacts: [],
      route: [],
      acceptanceCriteria: [],
      checkedBy: [],
      tokenBudget: null,
      deadline: null,
      history: [],
      createdAt: new Date("2026-10-03T09:00:00Z"),
      updatedAt: new Date("2026-10-03T09:00:00Z"),
      ...overrides,
    }) as unknown as Task;

  /** An office that accepts every event and answers with the task it moved. */
  const answering = (answer: unknown = { ok: true, value: parked({ status: "in_progress" }) }) => {
    const posted: { taskId: string; event: Record<string, unknown> }[] = [];
    open([eng], [ada]);
    store.getState().putTask(parked());
    store.getState().loadWaiting([held]);
    store.getState().connect({
      postTaskEvent: (taskId: string, event: Record<string, unknown>) => {
        posted.push({ taskId, event });
        return Promise.resolve(answer);
      },
    } as never);
    return posted;
  };

  it("holds what the office said it is waiting for", () => {
    answering();
    expect(store.getState().waiting).toHaveLength(1);
  });

  it("allows a held call, naming the call and not the tool", async () => {
    const posted = answering();

    const outcome = await store.getState().decideCall("task-1" as TaskId, "toolu_1", "approved");

    expect(outcome.ok).toBe(true);
    expect(posted).toEqual([
      {
        taskId: "task-1",
        event: { type: "call_decided", key: "toolu_1", decision: "approved" },
      },
    ]);
  });

  it("refuses one with a reason the run is told", async () => {
    const posted = answering();

    await store
      .getState()
      .decideCall("task-1" as TaskId, "toolu_1", "declined", "not that address");

    expect(posted[0]?.event).toMatchObject({ decision: "declined", reason: "not that address" });
  });

  it("takes the answered call off the list, so the badge is right at once", async () => {
    answering();

    await store.getState().decideCall("task-1" as TaskId, "toolu_1", "approved");

    expect(store.getState().waiting).toEqual([]);
  });

  it("keeps the work where the office put it, rather than guessing", async () => {
    answering();

    await store.getState().decideCall("task-1" as TaskId, "toolu_1", "approved");

    expect(store.getState().tasks[0]?.status).toBe("in_progress");
  });

  it("leaves the list alone when the office refuses the decision", async () => {
    const posted = answering({
      ok: false,
      kind: "validation",
      errors: [{ path: "status", message: "that work is not waiting any more" }],
    });

    const outcome = await store.getState().decideCall("task-1" as TaskId, "toolu_1", "approved");

    expect(outcome.ok).toBe(false);
    expect(posted).toHaveLength(1);
    expect(store.getState().waiting).toHaveLength(1);
  });

  it("approves finished work a department held", async () => {
    const posted = answering();

    await store.getState().decideGate("task-1" as TaskId, "approved");

    expect(posted[0]?.event).toEqual({ type: "gate_decided", decision: "approved" });
  });

  it("sends finished work back with the reason the office insists on", async () => {
    const posted = answering();

    await store.getState().decideGate("task-1" as TaskId, "rejected", "not on a Friday");

    expect(posted[0]?.event).toMatchObject({ decision: "rejected", reason: "not on a Friday" });
  });

  it("puts stopped work back to work, which is the one thing to do with it", async () => {
    const posted = answering();

    await store.getState().putBackToWork("task-1" as TaskId);

    expect(posted[0]?.event).toEqual({ type: "unblock" });
  });

  it("says so when there is no office to tell", async () => {
    open([eng], [ada]);
    store.getState().loadWaiting([held]);

    const outcome = await store.getState().decideCall("task-1" as TaskId, "toolu_1", "approved");

    expect(outcome.ok).toBe(false);
    expect(store.getState().waiting).toHaveLength(1);
  });
});

describe("changing a piece of work from the board", () => {
  const at = new Date("2026-09-28T09:00:00Z");
  const work = (overrides: Record<string, unknown> = {}): Task =>
    ({
      id: "task-1",
      officeId,
      departmentId: eng.id,
      title: "Write the parser",
      brief: "",
      priority: "normal",
      status: "assigned",
      assigneeId: ada.id,
      contestId: null,
      won: null,
      reviewerIds: [],
      approvals: [],
      stage: null,
      gatedActions: [],
      dependsOn: [],
      artifacts: [],
      route: [],
      acceptanceCriteria: [],
      checkedBy: [],
      tokenBudget: null,
      deadline: null,
      history: [],
      createdAt: at,
      updatedAt: at,
      ...overrides,
    }) as unknown as Task;

  const board = (answers: Record<string, unknown> = {}) => {
    const asked: { what: string; body: unknown }[] = [];
    open([eng], [ada, grace]);
    store.getState().putTask(work());
    store.getState().connect({
      patchTask: (id: string, changes: Record<string, unknown>) => {
        asked.push({ what: "patch", body: { id, changes } });
        return Promise.resolve(
          answers["patch"] ?? { ok: true, value: work({ ...changes, updatedAt: at }) },
        );
      },
      postTaskEvent: (id: string, event: Record<string, unknown>) => {
        asked.push({ what: "event", body: { id, event } });
        return Promise.resolve(
          answers["event"] ?? { ok: true, value: work({ assigneeId: grace.id }) },
        );
      },
    } as never);
    return asked;
  };

  const taskNow = () => store.getState().tasks[0];

  it("changes what the work is for, and keeps what the office answered", async () => {
    const asked = board();

    const outcome = await store.getState().saveTask("task-1" as TaskId, { title: "Write it well" });

    expect(outcome.ok).toBe(true);
    expect(asked[0]).toEqual({
      what: "patch",
      body: { id: "task-1", changes: { title: "Write it well" } },
    });
    expect(taskNow()?.title).toBe("Write it well");
  });

  it("shows the change at once, because a card that waits looks broken", () => {
    board({ patch: new Promise(() => undefined) });

    void store.getState().saveTask("task-1" as TaskId, { title: "Write it well" });

    expect(taskNow()?.title).toBe("Write it well");
  });

  it("puts it back when the office refuses the change", async () => {
    const asked = board({
      patch: {
        ok: false,
        kind: "validation",
        errors: [{ path: "title", message: "must not be empty" }],
      },
    });

    // A change this canvas is happy with and the office is not: the office is
    // asked, says no, and the card goes back to what it was.
    const outcome = await store.getState().saveTask("task-1" as TaskId, { title: "Write it well" });

    expect(outcome.ok).toBe(false);
    expect(asked).toHaveLength(1);
    expect(taskNow()?.title).toBe("Write the parser");
  });

  it("refuses a change core would refuse, without asking the office", async () => {
    const asked = board();

    const outcome = await store.getState().saveTask("task-1" as TaskId, { title: "   " });

    expect(outcome.ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it("hands work to somebody else, which is a transition rather than an edit", async () => {
    const asked = board();

    const outcome = await store
      .getState()
      .reassignTask("task-1" as TaskId, grace.id, "Ada is away");

    expect(outcome.ok).toBe(true);
    expect(asked[0]).toEqual({
      what: "event",
      body: {
        id: "task-1",
        event: { type: "reassign", toEmployeeId: grace.id, reason: "Ada is away" },
      },
    });
    expect(taskNow()?.assigneeId).toBe(grace.id);
  });

  it("does not move the work itself, since the office decides whether it may", async () => {
    board({ event: { ok: false, kind: "validation", errors: [] } });

    await store.getState().reassignTask("task-1" as TaskId, grace.id);

    expect(taskNow()?.assigneeId).toBe(ada.id);
  });

  it("says so when there is no office to tell", async () => {
    open([eng], [ada, grace]);
    store.getState().putTask(work());

    expect((await store.getState().reassignTask("task-1" as TaskId, grace.id)).ok).toBe(false);
  });
});

describe("the AI services an office can reach, on the canvas", () => {
  const acmeOffice = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    budget: null,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  const service = (overrides: Record<string, unknown> = {}): LlmService =>
    ({
      id: "svc-openai",
      officeId,
      kind: "openai-compatible",
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      tokenEnv: null,
      secretRef: null,
      models: [],
      enabled: true,
      createdAt: new Date("2026-09-28T09:00:00Z"),
      ...overrides,
    }) as unknown as LlmService;

  /** Every call the canvas made, so a click is checked by its effect. */
  function spyApi(answers: Record<string, unknown> = {}) {
    const sent: { what: string; body: unknown }[] = [];
    return {
      sent,
      api: {
        createService: (_officeId: string, input: Record<string, unknown>) => {
          sent.push({ what: "create", body: input });
          return Promise.resolve(
            answers["create"] ?? { ok: true, value: service({ id: "svc-new", ...input }) },
          );
        },
        patchService: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "patch", body: { id, changes } });
          return Promise.resolve(answers["patch"] ?? { ok: true, value: service(changes) });
        },
        deleteService: (id: string) => {
          sent.push({ what: "delete", body: id });
          return Promise.resolve(answers["delete"] ?? { ok: true, value: true });
        },
        setServiceCredential: (id: string, credential: Record<string, unknown>) => {
          sent.push({ what: "credential", body: { id, credential } });
          return Promise.resolve(
            answers["credential"] ?? { ok: true, value: service({ secretRef: "vault://abc" }) },
          );
        },
        clearServiceCredential: (id: string) => {
          sent.push({ what: "clear", body: id });
          return Promise.resolve(answers["clear"] ?? { ok: true, value: service() });
        },
        discoverServiceModels: (id: string) => {
          sent.push({ what: "discover", body: id });
          return Promise.resolve(
            answers["discover"] ?? {
              ok: true,
              value: service({ models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
            },
          );
        },
      } as never,
    };
  }

  const connected = (answers: Record<string, unknown> = {}) => {
    open([eng]);
    store.getState().loadOffice(acmeOffice);
    const spy = spyApi(answers);
    store.getState().connect(spy.api);
    return spy;
  };

  it("knows about none of them until it is told", () => {
    open([eng]);
    expect(store.getState().services).toEqual([]);
  });

  it("lists them by name, so a settings panel does not reorder itself", () => {
    open([eng]);
    store.getState().loadServices([service({ id: "svc-z", name: "workshop" }), service()]);
    expect(store.getState().services.map((one) => one.name)).toEqual(["openai", "workshop"]);
  });

  it("replaces one it already knows rather than listing it twice", () => {
    open([eng]);
    store.getState().loadServices([service()]);
    store.getState().putService(service({ enabled: false }));

    expect(store.getState().services).toHaveLength(1);
    expect(store.getState().services[0]?.enabled).toBe(false);
  });

  it("takes one it is told has gone", () => {
    open([eng]);
    store.getState().loadServices([service()]);
    store.getState().dropService("svc-openai" as never);
    expect(store.getState().services).toEqual([]);
  });

  it("adds one at the office, and never sends a key with it", async () => {
    const spy = connected();

    const result = await store.getState().addService({
      kind: "openai-compatible",
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(result.ok).toBe(true);
    expect(spy.sent[0]?.what).toBe("create");
    expect(JSON.stringify(spy.sent[0]?.body)).not.toContain("apiKey");
    expect(store.getState().services.map((one) => one.name)).toEqual(["openai"]);
  });

  it("says which field the office objected to", async () => {
    const spy = connected({
      create: {
        ok: false,
        kind: "validation",
        errors: [{ path: "baseUrl", message: "must be https" }],
      },
    });

    const result = await store.getState().addService({
      kind: "openai-compatible",
      name: "openai",
      baseUrl: "http://api.openai.com/v1",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems[0]?.path).toBe("baseUrl");
    expect(spy.sent).toHaveLength(1);
  });

  it("switches one off here and then at the office", async () => {
    const spy = connected();
    store.getState().loadServices([service()]);

    await store.getState().saveService("svc-openai" as never, { enabled: false });

    expect(store.getState().services[0]?.enabled).toBe(false);
    expect(spy.sent[0]).toEqual({
      what: "patch",
      body: { id: "svc-openai", changes: { enabled: false } },
    });
  });

  it("puts a refused change back, so the panel never shows what the office rejected", async () => {
    const spy = connected({
      patch: { ok: false, kind: "validation", errors: [{ path: "name", message: "taken" }] },
    });
    store.getState().loadServices([service()]);

    const result = await store.getState().saveService("svc-openai" as never, { name: "other" });

    expect(result.ok).toBe(false);
    expect(store.getState().services[0]?.name).toBe("openai");
    expect(spy.sent).toHaveLength(1);
  });

  it("takes one off the canvas and then at the office", async () => {
    const spy = connected();
    store.getState().loadServices([service()]);

    await store.getState().removeService("svc-openai" as never);

    expect(store.getState().services).toEqual([]);
    expect(spy.sent[0]).toEqual({ what: "delete", body: "svc-openai" });
  });

  it("puts one back when the office refuses to forget it", async () => {
    const spy = connected({ delete: { ok: false, kind: "transport", message: "down" } });
    store.getState().loadServices([service()]);

    await store.getState().removeService("svc-openai" as never);

    expect(store.getState().services.map((one) => one.name)).toEqual(["openai"]);
    expect(spy.sent).toHaveLength(1);
  });

  it("sets a key and keeps only what the office answered with", async () => {
    // The key goes to the office and never into the canvas's own state: what
    // comes back is the service, which holds a reference and not a key.
    const spy = connected();
    store.getState().loadServices([service()]);

    const result = await store.getState().setServiceKey("svc-openai" as never, {
      apiKey: "sk-live-1",
    });

    expect(result.ok).toBe(true);
    expect(spy.sent[0]).toEqual({
      what: "credential",
      body: { id: "svc-openai", credential: { apiKey: "sk-live-1" } },
    });
    expect(store.getState().services[0]?.secretRef).toBe("vault://abc");
    expect(JSON.stringify(store.getState().services)).not.toContain("sk-live-1");
  });

  it("names a variable instead of pasting one", async () => {
    const spy = connected();
    store.getState().loadServices([service()]);

    await store.getState().setServiceKey("svc-openai" as never, { tokenEnv: "OPENAI_API_KEY" });

    expect(spy.sent[0]?.body).toEqual({
      id: "svc-openai",
      credential: { tokenEnv: "OPENAI_API_KEY" },
    });
  });

  it("carries back an office that will not keep a key, since the panel must say so", async () => {
    const spy = connected({
      credential: { ok: false, kind: "transport", message: "this office cannot keep a key" },
    });
    store.getState().loadServices([service()]);

    const result = await store.getState().setServiceKey("svc-openai" as never, {
      apiKey: "sk-live-1",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problems[0]?.message).toMatch(/cannot keep a key/);
    expect(spy.sent).toHaveLength(1);
  });

  it("gives a key back", async () => {
    const spy = connected();
    store.getState().loadServices([service({ secretRef: "vault://abc" })]);

    await store.getState().clearServiceKey("svc-openai" as never);

    expect(spy.sent[0]).toEqual({ what: "clear", body: "svc-openai" });
    expect(store.getState().services[0]?.secretRef).toBeNull();
  });

  it("asks a service what models it has and keeps what the office wrote down", async () => {
    const spy = connected();
    store.getState().loadServices([service()]);

    const result = await store.getState().discoverServiceModels("svc-openai" as never);

    expect(result.ok).toBe(true);
    expect(spy.sent[0]).toEqual({ what: "discover", body: "svc-openai" });
    expect(store.getState().services[0]?.models.map((model) => model.id)).toEqual([
      "gpt-5",
      "gpt-5-mini",
    ]);
  });

  it("says why a service could not be asked, because somebody pressed a button", async () => {
    const spy = connected({
      discover: { ok: false, kind: "transport", message: "connection refused" },
    });
    store.getState().loadServices([service()]);

    const result = await store.getState().discoverServiceModels("svc-openai" as never);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problems[0]?.message).toContain("connection refused");
    expect(spy.sent).toHaveLength(1);
  });

  it("does nothing to a service it does not have", async () => {
    connected();

    expect((await store.getState().saveService("nope" as never, { enabled: false })).ok).toBe(
      false,
    );
    expect((await store.getState().removeService("nope" as never)).ok).toBe(false);
    expect((await store.getState().discoverServiceModels("nope" as never)).ok).toBe(false);
  });
});

describe("standing in for a real person, from the canvas", () => {
  const acmeOffice = {
    id: officeId,
    name: "Acme",
    schedule: { kind: "always" as const },
    priority: "normal" as const,
    runState: "running" as const,
    budget: null,
    configVersion: 1,
    createdAt: new Date("2026-09-28T09:00:00Z"),
  };

  const taught = (employee: Employee): Employee => ({
    ...employee,
    understudy: {
      person: "Anna Petrova",
      recordedBy: "owner-1",
      recordedAt: new Date("2026-09-28T09:00:00Z"),
      enabled: true,
      card: "Opens with the first name.",
      cardMadeAt: new Date("2026-09-28T09:00:00Z"),
      cardFromSamples: 3,
      corrections: [],
    },
  });

  function spyApi(answers: Record<string, unknown> = {}) {
    const sent: { what: string; body: unknown }[] = [];
    return {
      sent,
      api: {
        studyVoice: (id: string) => {
          sent.push({ what: "study", body: id });
          return Promise.resolve(answers["study"] ?? { ok: true, value: taught(ada) });
        },
        recordCorrection: (id: string, correction: Record<string, unknown>) => {
          sent.push({ what: "correction", body: { id, correction } });
          return Promise.resolve(answers["correction"] ?? { ok: true, value: taught(ada) });
        },
        patchEmployee: (id: string, changes: Record<string, unknown>) => {
          sent.push({ what: "patch", body: { id, changes } });
          return Promise.resolve(answers["patch"] ?? { ok: true, value: { ...ada, ...changes } });
        },
      } as never,
    };
  }

  const connected = (answers: Record<string, unknown> = {}) => {
    open([eng], [ada]);
    store.getState().loadOffice(acmeOffice);
    const spy = spyApi(answers);
    store.getState().connect(spy.api);
    return spy;
  };

  it("asks the office to study them and keeps what it answered", async () => {
    const spy = connected();

    const result = await store.getState().studyVoice(ada.id);

    expect(result.ok).toBe(true);
    expect(spy.sent[0]).toEqual({ what: "study", body: ada.id });
    expect(store.getState().employees.find((one) => one.id === ada.id)?.understudy?.card).toBe(
      "Opens with the first name.",
    );
  });

  it("says why a study could not happen, because somebody pressed a button", async () => {
    const spy = connected({
      study: { ok: false, kind: "transport", message: "this office has no model to study with" },
    });

    const result = await store.getState().studyVoice(ada.id);

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.problems[0]?.message).toMatch(/no model to study with/);
    expect(spy.sent).toHaveLength(1);
  });

  it("records what the real person changed", async () => {
    const spy = connected();

    await store.getState().recordCorrection(ada.id, {
      before: "Dear Sir,",
      after: "Hi Tom,",
      taskId: "task-1",
    });

    expect(spy.sent[0]).toEqual({
      what: "correction",
      body: { id: ada.id, correction: { before: "Dear Sir,", after: "Hi Tom,", taskId: "task-1" } },
    });
  });

  it("does nothing for somebody it does not have", async () => {
    connected();

    expect((await store.getState().studyVoice("nope" as never)).ok).toBe(false);
    expect(
      (await store.getState().recordCorrection("nope" as never, { before: "a", after: "b" })).ok,
    ).toBe(false);
  });
});
