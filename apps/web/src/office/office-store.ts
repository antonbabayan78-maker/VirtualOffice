/**
 * What the canvas knows about the office.
 *
 * Every rule the canvas has — where a department may sit, how small it may be,
 * whether a move snaps to the grid — lives here rather than in a component, so
 * it can be tested without a DOM and so the same rule applies however the change
 * arrives: a drag, a keyboard nudge, or later the API.
 *
 * Departments are the core entity, not a canvas-shaped copy of one. A new
 * department goes through the same factory the office file and the API use, so
 * the canvas cannot create something the rest of the system would reject.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  DEFAULT_DEPARTMENT_SIZE,
  MIN_DEPARTMENT_SIZE,
  createDepartment,
  createEmployee,
  err,
  recordContestWin,
  setRunState,
  TOOLS_BY_KIND,
  isErr,
  updateDepartment,
  updateConnection,
  updateConnector,
  updateEmployee,
  updateOffice,
  type Connection,
  type ConnectionId,
  type UpdateConnectionInput,
  type Connector,
  type ConnectorId,
  type ConnectorKind,
  type EmployeeStatus,
  type RunState,
  type UsageRecord,
  type UpdateConnectorInput,
  type Department,
  type DepartmentId,
  type Document,
  type DocumentId,
  type DocumentOwnerRef,
  type Office,
  type UpdateOfficeInput,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Result,
  type Task,
  type TaskId,
  type UpdateDepartmentInput,
  type UpdateEmployeeInput,
  type ValidationError,
} from "@vo/core";
import type { ApiClient, SpendSummary, Waiting } from "@vo/api-client";
import type { ActivityState } from "../canvas/EmployeeAvatar.js";
import { activityFromTasks } from "./activity.js";
import type { LayoutStorage, StoredLayout } from "./layout-storage.js";
import { linksFrom, type DepartmentLink } from "./links.js";

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface CanvasSettings {
  readonly snapToGrid: boolean;
  readonly gridSize: number;
}

export interface AddDepartmentInput {
  readonly name: string;
  readonly color: string;
  readonly position: Position;
}

export interface AddEmployeeInput {
  readonly name: string;
  readonly role: string;
  readonly color: string;
  readonly departmentId: DepartmentId;
}

export interface OfficeStoreState {
  /**
   * The office everything else belongs to, once it is known. Null on a canvas
   * that has not been told which office it is showing.
   */
  readonly office: Office | null;
  /** Whether the office's own settings panel is showing. */
  readonly officeOpen: boolean;
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
  readonly connections: readonly Connection[];
  /**
   * Every document the office holds, kept whole rather than per tray. A tray is
   * a filter over this, the way `links` and `activity` are filters over what is
   * already here — so one request keeps every drawer right.
   */
  readonly documents: readonly Document[];
  /**
   * What this office can reach outside itself, granted to anybody or not. Flat
   * like `documents` rather than paired with a derived companion the way
   * `connections` is with `links`: a connector has no geometry, and nothing on
   * the canvas is recomputed from one.
   */
  readonly connectors: readonly Connector[];
  /**
   * What the office has been spent on. Loaded whole with the office, like the
   * documents, and replaced rather than added to — two loads must not double
   * every figure on the canvas.
   */
  readonly usage: readonly UsageRecord[];
  /**
   * What each level has spent in the current period, or null when the office
   * has not been asked. Null rather than zeroes: nothing spent and never asked
   * look identical as numbers, and one of them means the office was unreachable.
   */
  readonly spend: SpendSummary | null;
  /**
   * Whether a document is on its way to the office. The only thing the canvas
   * does that is not instant: bytes have to travel before the office can name
   * what arrived, so there is nothing to show optimistically.
   */
  readonly uploading: boolean;
  /**
   * The arrows to draw: one per relationship, with two heads where the work
   * goes both ways. Derived from the connections rather than stored beside
   * them, so an arrow cannot survive the connection it stands for.
   */
  readonly links: readonly DepartmentLink[];
  /**
   * What each employee is doing right now, worked out from the office's tasks
   * rather than reported separately. Runtime state, not employment status: a
   * paused employee is not the same thing as an idle one.
   */
  readonly activity: Readonly<Record<string, ActivityState>>;
  readonly settings: CanvasSettings;
  readonly selectedId: DepartmentId | null;
  load(
    departments: readonly Department[],
    employees?: readonly Employee[],
    tasks?: readonly Task[],
    connections?: readonly Connection[],
  ): void;
  loadOffice(office: Office): void;
  /**
   * Says which office to send changes to. Until this is called a save is
   * applied here and goes no further, which is right for a canvas with no
   * server and wrong for one that has just found its own.
   */
  connect(api: ApiClient): void;
  openOffice(open: boolean): void;
  /** Changes the office here and then at the office, like any other save. */
  saveOffice(changes: UpdateOfficeInput): Promise<SaveOutcome>;
  putConnection(connection: Connection): void;
  /** Changes an arrow here and then at the office, like any other save. */
  saveConnection(id: ConnectionId, changes: UpdateConnectionInput): Promise<SaveOutcome>;
  removeConnection(id: ConnectionId): void;
  /** Closes a department down. Refused while anybody still works there. */
  removeDepartment(id: DepartmentId): SaveOutcome;
  activityOf(id: EmployeeId): ActivityState;
  /** Replaces one task and works out what that means for everyone's colour. */
  putTask(task: Task): void;
  /**
   * Says which entry in a shootout won, and why.
   *
   * Not optimistic. A verdict is a judgement, and the office is what refuses a
   * second one — showing a winner the office then rejected would mean the canvas
   * had told somebody the contest was settled when it was not.
   */
  recordContestWin(taskId: TaskId, reason: string): Promise<SaveOutcome>;
  removeTask(id: TaskId): void;
  /**
   * What the office is waiting on a person for, as the office works it out.
   *
   * Held here rather than derived: half of it lives in the run checkpoints,
   * which only the office can read, and a canvas deriving the other half would
   * be two answers to one question.
   */
  readonly waiting: readonly Waiting[];
  loadWaiting(waiting: readonly Waiting[]): void;
  /**
   * Answers one held call — the call, not the tool, which is the whole point of
   * holding it. Not optimistic: the office decides whether the work is still
   * waiting, and a canvas that moved it on its own would be guessing.
   */
  decideCall(
    taskId: TaskId,
    key: string,
    decision: "approved" | "declined",
    reason?: string,
  ): Promise<SaveOutcome>;
  /** Answers for finished work a department held. A refusal needs a reason. */
  decideGate(
    taskId: TaskId,
    decision: "approved" | "rejected",
    reason?: string,
  ): Promise<SaveOutcome>;
  /** Starts stopped work again, which is the one thing to do with it from here. */
  putBackToWork(taskId: TaskId): Promise<SaveOutcome>;
  loadUsage(usage: readonly UsageRecord[]): void;
  loadSpend(spend: SpendSummary | null): void;
  loadConnectors(connectors: readonly Connector[]): void;
  /** Told about one, from the office's event stream. */
  putConnector(connector: Connector): void;
  dropConnector(id: ConnectorId): void;
  /**
   * Adds one at the office. Not optimistic: the office names it, and a connector
   * with an id this canvas invented could be neither granted nor switched off.
   */
  addConnector(input: AddConnectorInput): Promise<SaveOutcome>;
  /** Changes one here and then at the office, like any other save. */
  saveConnector(id: ConnectorId, changes: UpdateConnectorInput): Promise<SaveOutcome>;
  /**
   * Asks a connector what tools it offers and keeps what the office wrote down.
   *
   * Not optimistic, and nothing to roll back: only the server knows its tools,
   * so there is nothing to show until it has answered. A failure comes back as
   * a problem rather than a notice, because somebody pressed a button and is
   * waiting for this particular answer.
   */
  discoverConnectorTools(id: ConnectorId): Promise<SaveOutcome>;
  /** Takes one off the canvas first, and puts it back if the office refuses. */
  removeConnector(id: ConnectorId): Promise<SaveOutcome>;
  loadDocuments(documents: readonly Document[]): void;
  /** Told about one, from the office's event stream. */
  putDocument(document: Document): void;
  dropDocument(id: DocumentId): void;
  /**
   * Puts a document in a tray at the office. Not optimistic: until the office
   * answers there is no document, only some bytes and an intention.
   */
  fileDocument(input: FileDocumentInput): Promise<SaveOutcome>;
  /** Takes one off a desk here first, and puts it back if the office refuses. */
  takeDocument(id: DocumentId): Promise<SaveOutcome>;
  /**
   * The bytes of a document, for saving or showing. The store asks, because the
   * API client lives in here and a component has no way to reach it.
   */
  fetchBody(id: DocumentId): Promise<Uint8Array | null>;
  moveDepartment(id: DepartmentId, position: Position): void;
  resizeDepartment(id: DepartmentId, size: Size): void;
  addDepartment(input: AddDepartmentInput): Result<Department>;
  addEmployee(input: AddEmployeeInput): Result<Employee>;
  /** Something the canvas should say out loud, such as why a drop was refused. */
  readonly notice: string | null;
  setNotice(notice: string | null): void;
  select(id: DepartmentId | null): void;
  readonly selectedEmployeeId: EmployeeId | null;
  /** The arrow whose settings are open, if any. */
  readonly selectedConnectionId: ConnectionId | null;
  selectConnection(id: ConnectionId | null): void;
  selectEmployee(id: EmployeeId | null): void;
  updateEmployee(id: EmployeeId, changes: UpdateEmployeeInput): Result<Employee>;
  updateDepartment(id: DepartmentId, changes: UpdateDepartmentInput): Result<Department>;
  /**
   * Changes a department here and then at the office. The canvas shows it at
   * once; if the office refuses, or somebody else got there first, or it cannot
   * be reached, the canvas is put back to what the office actually holds.
   */
  saveDepartment(id: DepartmentId, changes: UpdateDepartmentInput): Promise<SaveOutcome>;
  saveEmployee(id: EmployeeId, changes: UpdateEmployeeInput): Promise<SaveOutcome>;
  /**
   * The switches: stopping work and starting it again. Apart from the `save*`
   * pair above because stopping something is not editing it — and because
   * these are pressed rather than drafted, so they carry no field changes and
   * nothing to cancel.
   */
  saveOfficeRunState(to: RunState): Promise<SaveOutcome>;
  saveDepartmentRunState(id: DepartmentId, to: RunState): Promise<SaveOutcome>;
  saveEmployeeStatus(id: EmployeeId, to: EmployeeStatus): Promise<SaveOutcome>;
  /** The last event offset this client has seen, which a save is judged against. */
  /**
   * An id for something the canvas is about to make, from the same generator
   * the store uses for departments and people — so a drawer does not invent
   * its own scheme, and a test can say what it will be.
   */
  newId(): string;
  readonly seenOffset: number;
  setSeenOffset(offset: number): void;
  setSnapToGrid(on: boolean): void;
}

export type OfficeStore = UseBoundStore<StoreApi<OfficeStoreState>>;

export const DEFAULT_GRID_SIZE = 20;

/** What a save came to in the end, for the drawer that asked for it. */
export type SaveOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly ValidationError[] };

export interface AddConnectorInput {
  readonly kind: ConnectorKind;
  readonly name: string;
  /** Whatever the kind needs; for the web, the hosts it may read. */
  readonly config?: Record<string, unknown>;
}

export interface FileDocumentInput {
  readonly owner: DocumentOwnerRef;
  readonly tray: "in" | "out";
  readonly name: string;
  readonly mediaType?: string;
  readonly body: Uint8Array;
}

export interface OfficeStoreDeps {
  readonly storage: LayoutStorage;
  /** Absent means a canvas with nobody to save to, which still works locally. */
  readonly api?: ApiClient;
  /** Ids for anything the canvas creates: departments and people alike. */
  readonly id: () => string;
  readonly now: () => Date;
  readonly officeId?: OfficeId;
  readonly gridSize?: number;
}

const snap = (value: number, grid: number): number => Math.round(value / grid) * grid;

/**
 * Whether a department is still where it was, and the size it was.
 *
 * Only moves and resizes go through the helper that asks — editing a department
 * sets state directly — so these are the only fields worth comparing. It named
 * others once, which invited the belief that it guarded every change, and a
 * field left off that list would have been silently unsaveable.
 */
function unmoved(a: Department, b: Department): boolean {
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height
  );
}

/**
 * The arrows that can actually be drawn: both ends have to be on the canvas.
 * A connection to a department this client has not loaded is not wrong, it is
 * simply not drawable, and a dangling arrow is worse than a missing one.
 */
function drawable(
  connections: readonly Connection[],
  departments: readonly Department[],
): readonly DepartmentLink[] {
  const present = new Set(departments.map((department) => department.id as string));
  return linksFrom(
    connections.filter(
      (connection) => present.has(connection.fromId) && present.has(connection.toId),
    ),
  );
}

/**
 * Connectors read in name order, which is also how they are granted and how a
 * tool is named on the wire. Creation order is whatever the office happened to
 * answer with, and a settings panel that rearranges itself while somebody is
 * using it is worse than one that loads slowly.
 */
function byName(connectors: readonly Connector[]): readonly Connector[] {
  return [...connectors].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A tray reads oldest first, which is the order the office lists one in. Sorting
 * here rather than trusting arrival order means a document put back after a
 * refused removal returns to where it was, instead of to the end.
 */
function inOrder(documents: readonly Document[]): readonly Document[] {
  return [...documents].sort((a, b) =>
    a.addedAt.getTime() === b.addedAt.getTime()
      ? a.id.localeCompare(b.id)
      : a.addedAt.getTime() - b.addedAt.getTime(),
  );
}

function snapPosition(position: Position, settings: CanvasSettings): Position {
  if (!settings.snapToGrid) return position;
  return { x: snap(position.x, settings.gridSize), y: snap(position.y, settings.gridSize) };
}

/** Never smaller than core allows, and on the grid when snapping is on. */
function boundSize(size: Size, settings: CanvasSettings): Size {
  const width = settings.snapToGrid ? snap(size.width, settings.gridSize) : size.width;
  const height = settings.snapToGrid ? snap(size.height, settings.gridSize) : size.height;
  return {
    width: Math.max(MIN_DEPARTMENT_SIZE.width, width),
    height: Math.max(MIN_DEPARTMENT_SIZE.height, height),
  };
}

function applyStoredLayout(
  departments: readonly Department[],
  stored: StoredLayout | null,
): readonly Department[] {
  if (stored === null) return departments;
  return departments.map((department) => {
    // A layout for a department the office no longer has is simply ignored.
    const layout = stored.departments[department.id];
    if (layout === undefined) return department;
    return { ...department, position: layout.position, size: layout.size };
  });
}

export function createOfficeStore(deps: OfficeStoreDeps): OfficeStore {
  /**
   * Who to send changes to. Mutable because the app builds its store before it
   * has read its configuration, and a store that could never be told would make
   * every drawer a decoration: saves applied locally, reported as successes and
   * lost on the next reload.
   */
  let connected: ApiClient | undefined = deps.api;
  const gridSize = deps.gridSize ?? DEFAULT_GRID_SIZE;

  return create<OfficeStoreState>((set, get) => {
    /**
     * Hands one decision to the office and keeps what it answers.
     *
     * Deliberately not optimistic: whether work is still waiting is the
     * office's to say, and a canvas that moved it on its own would be a second
     * opinion about a decision only a person may make. What it does do at once
     * is take the answered item off the list, so the badge is right before the
     * stream comes round.
     */
    const tellTheOffice = async (
      taskId: TaskId,
      event: Readonly<Record<string, unknown>>,
    ): Promise<SaveOutcome> => {
      if (connected === undefined) {
        return {
          ok: false,
          problems: [{ path: "", message: "this canvas has no office to tell" }],
        };
      }

      const answer = await connected.postTaskEvent(taskId, event);
      if (answer.ok) {
        get().putTask(answer.value);
        const key = typeof event["key"] === "string" ? event["key"] : null;
        set({
          waiting: get().waiting.filter((item) =>
            item.taskId !== taskId
              ? true
              : // One call of several may be answered on its own; anything else
                // about this task is settled by the same decision.
                key !== null && item.kind === "call" && item.key !== key,
          ),
        });
        return { ok: true };
      }
      if (answer.kind === "transport") set({ notice: answer.message });
      return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
    };

    const persist = (departments: readonly Department[], settings: CanvasSettings): void => {
      const layout: Record<string, { position: Position; size: Size }> = {};
      for (const department of departments) {
        layout[department.id] = { position: department.position, size: department.size };
      }
      deps.storage.writeLayout({ departments: layout, snapToGrid: settings.snapToGrid });
    };

    const update = (
      id: DepartmentId,
      change: (department: Department, settings: CanvasSettings) => Department,
    ): void => {
      const { departments, settings } = get();
      const current = departments.find((department) => department.id === id);
      if (current === undefined) return;

      const changed = change(current, settings);
      // A change that changes nothing must not produce a new array. The canvas
      // re-renders on a new one, which makes React Flow measure again, which
      // reports the same change again — a loop that never settles, and edges
      // never get drawn because the graph is never still.
      if (unmoved(current, changed)) return;

      const next = departments.map((department) => (department.id === id ? changed : department));
      set({ departments: next });
      persist(next, settings);
    };

    const stored = deps.storage.readLayout();

    return {
      departments: [],
      employees: [],
      tasks: [],
      activity: {},
      notice: null,
      office: null,
      officeOpen: false,
      waiting: [],
      selectedConnectionId: null,
      connections: [],
      links: [],
      selectedEmployeeId: null,
      seenOffset: 0,
      settings: { snapToGrid: stored?.snapToGrid ?? false, gridSize },
      selectedId: null,

      documents: [],
      uploading: false,
      connectors: [],
      usage: [],
      spend: null,

      load: (departments, employees = [], tasks = [], connections = []) => {
        const layout = deps.storage.readLayout();
        set({
          departments: applyStoredLayout(departments, layout),
          employees,
          tasks,
          connections,
          links: drawable(connections, departments),
          activity: activityFromTasks(tasks),
          settings: { snapToGrid: layout?.snapToGrid ?? get().settings.snapToGrid, gridSize },
        });
      },

      loadOffice: (office) => {
        set({ office });
      },

      connect: (api) => {
        connected = api;
      },

      openOffice: (open) => {
        set({ officeOpen: open });
      },

      saveOffice: async (changes) => {
        const before = get().office;
        if (before === null) {
          return { ok: false, problems: [{ path: "office", message: "no office is open" }] };
        }

        // Refused here means never sent: the office would only say the same.
        const applied = updateOffice(before, changes);
        if (isErr(applied)) return { ok: false, problems: applied.error };
        set({ office: applied.value });
        if (connected === undefined) return { ok: true };

        const answer = await connected.patchOffice(
          before.id,
          changes as Record<string, unknown>,
          get().seenOffset,
        );
        if (answer.ok) {
          set({ office: answer.value });
          return { ok: true };
        }
        if (answer.kind === "conflict") {
          set({
            office: answer.current as unknown as Office,
            notice: "Somebody else changed this first; showing what the office now holds.",
          });
          return { ok: false, problems: [] };
        }
        set({ office: before });
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      selectConnection: (id) => {
        set({ selectedConnectionId: id });
      },

      saveConnection: async (id, changes) => {
        const before = get().connections.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such connection" }] };
        }

        const applied = updateConnection(before, changes);
        if (isErr(applied)) return { ok: false, problems: applied.error };
        get().putConnection(applied.value);
        if (connected === undefined) return { ok: true };

        const answer = await connected.patchConnection(
          id,
          changes as Record<string, unknown>,
          get().seenOffset,
        );
        if (answer.ok) {
          get().putConnection(answer.value);
          return { ok: true };
        }
        get().putConnection(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      putConnection: (connection) => {
        const existing = get().connections;
        const connections = existing.some((candidate) => candidate.id === connection.id)
          ? existing.map((candidate) => (candidate.id === connection.id ? connection : candidate))
          : [...existing, connection];
        set({ connections, links: drawable(connections, get().departments) });
      },

      removeConnection: (id) => {
        const connections = get().connections.filter((candidate) => candidate.id !== id);
        set({ connections, links: drawable(connections, get().departments) });
      },

      removeDepartment: (id) => {
        const { departments, employees, connections, settings, selectedId } = get();
        const department = departments.find((candidate) => candidate.id === id);
        if (department === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such department" }] };
        }

        const staff = employees.filter((employee) => employee.departmentId === id);
        if (staff.length > 0) {
          // Deleting people by deleting the room around them is not a thing a
          // canvas should do quietly; move them out first.
          return {
            ok: false,
            problems: [
              {
                path: "employees",
                message: `${department.name} still has ${String(staff.length)} ${
                  staff.length === 1 ? "person" : "people"
                } in it`,
              },
            ],
          };
        }

        const next = departments.filter((candidate) => candidate.id !== id);
        // An arrow to a department that is gone cannot be drawn, so the
        // connections go with it rather than becoming invisible orphans.
        const kept = connections.filter(
          (connection) => connection.fromId !== id && connection.toId !== id,
        );
        set({
          departments: next,
          connections: kept,
          links: drawable(kept, next),
          ...(selectedId === id ? { selectedId: null } : {}),
        });
        persist(next, settings);
        return { ok: true };
      },

      moveDepartment: (id, position) => {
        update(id, (department, settings) => ({
          ...department,
          position: snapPosition(position, settings),
        }));
      },

      resizeDepartment: (id, size) => {
        update(id, (department, settings) => ({
          ...department,
          size: boundSize(size, settings),
        }));
      },

      addDepartment: (input) => {
        const { departments, settings } = get();
        const officeId = deps.officeId ?? departments[0]?.officeId ?? ("office" as OfficeId);
        const created = createDepartment(
          {
            officeId,
            name: input.name,
            color: input.color,
            position: snapPosition(input.position, settings),
            size: DEFAULT_DEPARTMENT_SIZE,
          },
          // The existing departments, so the factory can refuse a duplicate name.
          departments,
          { id: () => deps.id() as DepartmentId, now: deps.now },
        );
        if (isErr(created)) return created;
        const next = [...departments, created.value];
        set({ departments: next });
        persist(next, settings);
        return created;
      },

      activityOf: (id) => get().activity[id] ?? "idle",

      putTask: (task) => {
        const tasks = get().tasks.some((candidate) => candidate.id === task.id)
          ? get().tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
          : [...get().tasks, task];
        set({ tasks, activity: activityFromTasks(tasks) });
      },

      recordContestWin: async (taskId, reason) => {
        const winner = get().tasks.find((candidate) => candidate.id === taskId);
        if (winner === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such piece of work" }] };
        }
        if (winner.contestId === null) {
          return {
            ok: false,
            problems: [{ path: "id", message: "that work is not an entry in a contest" }],
          };
        }

        if (connected === undefined) {
          // No office to ask, so the rules are applied here — the same ones, out
          // of core, rather than a second opinion about what a verdict may be.
          const entries = get().tasks.filter((task) => task.contestId === winner.contestId);
          const decided = recordContestWin(entries, taskId, {
            reason,
            decidedBy: null,
            at: deps.now(),
          });
          if (isErr(decided)) return { ok: false, problems: decided.error };
          get().putTask(decided.value);
          return { ok: true };
        }

        const answer = await connected.recordContestWin(taskId, { reason });
        if (answer.ok) {
          get().putTask(answer.value);
          return { ok: true };
        }
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      loadWaiting: (waiting) => {
        set({ waiting });
      },

      decideCall: async (taskId, key, decision, reason) =>
        tellTheOffice(taskId, {
          type: "call_decided",
          key,
          decision,
          ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
        }),

      decideGate: async (taskId, decision, reason) =>
        tellTheOffice(taskId, {
          type: "gate_decided",
          decision,
          ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
        }),

      putBackToWork: async (taskId) => tellTheOffice(taskId, { type: "unblock" }),

      removeTask: (id) => {
        const tasks = get().tasks.filter((candidate) => candidate.id !== id);
        set({ tasks, activity: activityFromTasks(tasks) });
      },

      loadUsage: (usage) => {
        set({ usage });
      },

      loadSpend: (spend) => {
        set({ spend });
      },

      loadConnectors: (connectors) => {
        set({ connectors: byName(connectors) });
      },

      putConnector: (connector) => {
        const existing = get().connectors;
        set({
          connectors: byName(
            existing.some((candidate) => candidate.id === connector.id)
              ? existing.map((candidate) => (candidate.id === connector.id ? connector : candidate))
              : [...existing, connector],
          ),
        });
      },

      dropConnector: (id) => {
        set({ connectors: get().connectors.filter((candidate) => candidate.id !== id) });
      },

      addConnector: async (input) => {
        // The office this canvas is showing, for the same reason filing a
        // document asks: the app builds its store before reading its config.
        const officeId = get().office?.id ?? deps.officeId;
        if (connected === undefined || officeId === undefined) {
          return { ok: false, problems: [{ path: "", message: "this canvas has no office yet" }] };
        }

        const answer = await connected.createConnector(officeId, {
          kind: input.kind,
          name: input.name,
          // What the kind offers, rather than nothing: a connector with no tools
          // is one the office can grant nothing of.
          tools: TOOLS_BY_KIND[input.kind],
          config: input.config ?? {},
        });
        if (answer.ok) {
          get().putConnector(answer.value);
          return { ok: true };
        }
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      saveConnector: async (id, changes) => {
        const before = get().connectors.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such connector" }] };
        }

        // The office's other connectors, for the name check: a connector does
        // not collide with itself.
        const applied = updateConnector(
          before,
          changes,
          get().connectors.filter((candidate) => candidate.id !== id),
        );
        if (isErr(applied)) return { ok: false, problems: applied.error };
        get().putConnector(applied.value);
        if (connected === undefined) return { ok: true };

        const answer = await connected.patchConnector(
          id,
          changes as Record<string, unknown>,
          get().seenOffset,
        );
        if (answer.ok) {
          get().putConnector(answer.value);
          return { ok: true };
        }
        get().putConnector(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      discoverConnectorTools: async (id) => {
        const before = get().connectors.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such connector" }] };
        }
        if (connected === undefined) {
          return {
            ok: false,
            problems: [{ path: "", message: "this canvas has no office to ask" }],
          };
        }

        const answer = await connected.discoverConnectorTools(id);
        if (answer.ok) {
          get().putConnector(answer.value);
          return { ok: true };
        }
        if (answer.kind === "transport") {
          return { ok: false, problems: [{ path: "", message: answer.message }] };
        }
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      removeConnector: async (id) => {
        const before = get().connectors.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such connector" }] };
        }

        // Grants naming it are left alone. They resolve to nothing without it,
        // and rewriting every department and employee from here is a change
        // nobody asked this panel to make.
        get().dropConnector(id);
        if (connected === undefined) return { ok: true };

        const answer = await connected.deleteConnector(id);
        if (answer.ok) return { ok: true };
        get().putConnector(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      loadDocuments: (documents) => {
        set({ documents: inOrder(documents) });
      },

      putDocument: (document) => {
        const existing = get().documents;
        set({
          documents: inOrder(
            existing.some((candidate) => candidate.id === document.id)
              ? existing.map((candidate) => (candidate.id === document.id ? document : candidate))
              : [...existing, document],
          ),
        });
      },

      dropDocument: (id) => {
        set({ documents: get().documents.filter((candidate) => candidate.id !== id) });
      },

      fileDocument: async (input) => {
        // The office this canvas is showing, not one named when the store was
        // built: the app makes its store before it has read its configuration,
        // which is the same reason the API client arrives through connect().
        const officeId = get().office?.id ?? deps.officeId;
        if (connected === undefined || officeId === undefined) {
          // Reporting success would leave a document on the canvas that the
          // office has never heard of and nobody else will ever see.
          return { ok: false, problems: [{ path: "", message: "this canvas has no office yet" }] };
        }

        set({ uploading: true });
        const answer = await connected.uploadDocument(officeId, {
          ownerKind: input.owner.kind,
          ownerId: input.owner.id,
          tray: input.tray,
          name: input.name,
          ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
          body: input.body,
        });
        set({ uploading: false });

        if (answer.ok) {
          get().putDocument(answer.value);
          return { ok: true };
        }
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      takeDocument: async (id) => {
        const before = get().documents.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such document" }] };
        }

        get().dropDocument(id);
        if (connected === undefined) return { ok: true };

        const answer = await connected.deleteDocument(id);
        if (answer.ok) return { ok: true };
        get().putDocument(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      fetchBody: async (id) => {
        if (connected === undefined) return null;
        const answer = await connected.downloadDocument(id);
        if (answer.ok) return answer.value;
        if (answer.kind === "transport") set({ notice: answer.message });
        return null;
      },

      addEmployee: (input) => {
        const { departments, employees } = get();
        const department = departments.find((candidate) => candidate.id === input.departmentId);
        if (department === undefined) {
          return err([{ path: "departmentId", message: "that department is not in this office" }]);
        }
        const created = createEmployee(
          {
            name: input.name,
            role: input.role,
            color: input.color,
            // A sensible model to start with; the employee drawer changes it.
            llm: { provider: "anthropic", model: "claude-sonnet-5" },
          },
          { department: { id: department.id, officeId: department.officeId }, supervisor: null },
          { id: () => deps.id() as EmployeeId, now: deps.now },
        );
        if (isErr(created)) return created;
        set({ employees: [...employees, created.value] });
        return created;
      },

      updateDepartment: (id, changes) => {
        const { departments, settings } = get();
        const department = departments.find((candidate) => candidate.id === id);
        if (department === undefined) {
          return err([{ path: "id", message: "that department is not in this office" }]);
        }
        const updated = updateDepartment(department, changes, departments);
        if (isErr(updated)) return updated;
        const next = departments.map((candidate) =>
          candidate.id === id ? updated.value : candidate,
        );
        set({ departments: next });
        persist(next, settings);
        return updated;
      },

      newId: () => deps.id(),

      setSeenOffset: (offset) => {
        // Only ever forward: an older event is not newer news.
        set({ seenOffset: Math.max(get().seenOffset, offset) });
      },

      saveDepartment: async (id, changes) => {
        const before = get().departments.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such department" }] };
        }

        // Refused here means never sent: the office would only say the same.
        const applied = get().updateDepartment(id, changes);
        if (isErr(applied)) return { ok: false, problems: applied.error };
        if (connected === undefined) return { ok: true };

        const answer = await connected.patchDepartment(
          id,
          changes as Record<string, unknown>,
          get().seenOffset,
        );
        const restore = (department: Department): void => {
          set({
            departments: get().departments.map((candidate) =>
              candidate.id === id ? department : candidate,
            ),
          });
        };

        if (answer.ok) {
          // What the office holds, not what was sent: it may have tidied it.
          restore(answer.value);
          return { ok: true };
        }
        if (answer.kind === "conflict") {
          restore(answer.current);
          set({ notice: "Somebody else changed this first; showing what the office now holds." });
          return { ok: false, problems: [] };
        }
        restore(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      saveEmployee: async (id, changes) => {
        const before = get().employees.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such employee" }] };
        }

        const applied = get().updateEmployee(id, changes);
        if (isErr(applied)) return { ok: false, problems: applied.error };
        if (connected === undefined) return { ok: true };

        const answer = await connected.patchEmployee(
          id,
          changes as Record<string, unknown>,
          get().seenOffset,
        );
        const restore = (employee: Employee): void => {
          set({
            employees: get().employees.map((candidate) =>
              candidate.id === id ? employee : candidate,
            ),
          });
        };

        if (answer.ok) {
          restore(answer.value);
          return { ok: true };
        }
        if (answer.kind === "conflict") {
          restore(answer.current);
          set({ notice: "Somebody else changed this first; showing what the office now holds." });
          return { ok: false, problems: [] };
        }
        restore(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      saveOfficeRunState: async (to) => {
        const before = get().office;
        if (before === null) {
          return { ok: false, problems: [{ path: "office", message: "no office is open" }] };
        }

        set({ office: setRunState(before, to) });
        if (connected === undefined) return { ok: true };

        const answer = await connected.setOfficeRunState(before.id, to);
        if (answer.ok) {
          set({ office: answer.value });
          return { ok: true };
        }
        set({ office: before });
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      saveDepartmentRunState: async (id, to) => {
        const before = get().departments.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such department" }] };
        }

        const show = (department: Department): void => {
          set({
            departments: get().departments.map((candidate) =>
              candidate.id === id ? department : candidate,
            ),
          });
        };

        show(setRunState(before, to));
        if (connected === undefined) return { ok: true };

        const answer = await connected.setDepartmentRunState(id, to);
        if (answer.ok) {
          show(answer.value);
          return { ok: true };
        }
        show(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      saveEmployeeStatus: async (id, to) => {
        const before = get().employees.find((candidate) => candidate.id === id);
        if (before === undefined) {
          return { ok: false, problems: [{ path: "id", message: "no such employee" }] };
        }

        const show = (employee: Employee): void => {
          set({
            employees: get().employees.map((candidate) =>
              candidate.id === id ? employee : candidate,
            ),
          });
        };

        // Their tasks are not touched: pausing somebody is not reassigning
        // their desk, and their open work waits for them.
        show({ ...before, status: to });
        if (connected === undefined) return { ok: true };

        const answer = await connected.setEmployeeStatus(id, to);
        if (answer.ok) {
          show(answer.value);
          return { ok: true };
        }
        show(before);
        if (answer.kind === "transport") set({ notice: answer.message });
        return { ok: false, problems: answer.kind === "validation" ? answer.errors : [] };
      },

      setNotice: (notice) => {
        set({ notice });
      },

      select: (id) => {
        // One thing is being configured at a time, so a department selection
        // puts any employee selection aside and the other way round.
        set({ selectedId: id, selectedEmployeeId: null });
      },

      selectEmployee: (id) => {
        set({ selectedEmployeeId: id, selectedId: null });
      },

      updateEmployee: (id, changes) => {
        const { employees } = get();
        const employee = employees.find((candidate) => candidate.id === id);
        if (employee === undefined) {
          return err([{ path: "id", message: "that employee is not in this office" }]);
        }
        const supervisor =
          changes.supervisorId === undefined || changes.supervisorId === null
            ? null
            : (employees.find((candidate) => candidate.id === changes.supervisorId) ?? null);
        const updated = updateEmployee(employee, changes, {
          supervisor:
            supervisor === null
              ? null
              : {
                  id: supervisor.id,
                  officeId: supervisor.officeId,
                  status: supervisor.status,
                },
        });
        if (isErr(updated)) return updated;
        set({
          employees: employees.map((candidate) =>
            candidate.id === id ? updated.value : candidate,
          ),
        });
        return updated;
      },

      setSnapToGrid: (on) => {
        const settings = { ...get().settings, snapToGrid: on };
        set({ settings });
        persist(get().departments, settings);
      },
    };
  });
}

export type { ValidationError };
