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
  isErr,
  updateDepartment,
  updateEmployee,
  type Department,
  type DepartmentId,
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
import type { ApiClient } from "../api/client.js";
import type { ActivityState } from "../canvas/EmployeeAvatar.js";
import { activityFromTasks } from "./activity.js";
import type { LayoutStorage, StoredLayout } from "./layout-storage.js";

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
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly tasks: readonly Task[];
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
  ): void;
  activityOf(id: EmployeeId): ActivityState;
  /** Replaces one task and works out what that means for everyone's colour. */
  putTask(task: Task): void;
  removeTask(id: TaskId): void;
  moveDepartment(id: DepartmentId, position: Position): void;
  resizeDepartment(id: DepartmentId, size: Size): void;
  addDepartment(input: AddDepartmentInput): Result<Department>;
  addEmployee(input: AddEmployeeInput): Result<Employee>;
  /** Something the canvas should say out loud, such as why a drop was refused. */
  readonly notice: string | null;
  setNotice(notice: string | null): void;
  select(id: DepartmentId | null): void;
  readonly selectedEmployeeId: EmployeeId | null;
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
  /** The last event offset this client has seen, which a save is judged against. */
  readonly seenOffset: number;
  setSeenOffset(offset: number): void;
  setSnapToGrid(on: boolean): void;
}

export type OfficeStore = UseBoundStore<StoreApi<OfficeStoreState>>;

export const DEFAULT_GRID_SIZE = 20;

/** What a save came to in the end, for the drawer that asked for it. */
export type SaveOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly ValidationError[] };

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
  const gridSize = deps.gridSize ?? DEFAULT_GRID_SIZE;

  return create<OfficeStoreState>((set, get) => {
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
      if (!departments.some((department) => department.id === id)) return;
      const next = departments.map((department) =>
        department.id === id ? change(department, settings) : department,
      );
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
      selectedEmployeeId: null,
      seenOffset: 0,
      settings: { snapToGrid: stored?.snapToGrid ?? false, gridSize },
      selectedId: null,

      load: (departments, employees = [], tasks = []) => {
        const layout = deps.storage.readLayout();
        set({
          departments: applyStoredLayout(departments, layout),
          employees,
          tasks,
          activity: activityFromTasks(tasks),
          settings: { snapToGrid: layout?.snapToGrid ?? get().settings.snapToGrid, gridSize },
        });
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

      removeTask: (id) => {
        const tasks = get().tasks.filter((candidate) => candidate.id !== id);
        set({ tasks, activity: activityFromTasks(tasks) });
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
        if (deps.api === undefined) return { ok: true };

        const answer = await deps.api.patchDepartment(
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
        if (deps.api === undefined) return { ok: true };

        const answer = await deps.api.patchEmployee(
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
