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
  isErr,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Result,
  type ValidationError,
} from "@vo/core";
import type { ActivityState } from "../canvas/EmployeeAvatar.js";
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

export interface OfficeStoreState {
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  /**
   * What each employee is doing right now. Runtime state, not employment
   * status: a paused employee is not the same thing as an idle one. Nothing
   * writes to this yet; the live activity feed will.
   */
  readonly activity: Readonly<Record<string, ActivityState>>;
  readonly settings: CanvasSettings;
  readonly selectedId: DepartmentId | null;
  load(departments: readonly Department[], employees?: readonly Employee[]): void;
  activityOf(id: EmployeeId): ActivityState;
  setActivity(id: EmployeeId, state: ActivityState): void;
  moveDepartment(id: DepartmentId, position: Position): void;
  resizeDepartment(id: DepartmentId, size: Size): void;
  addDepartment(input: AddDepartmentInput): Result<Department>;
  select(id: DepartmentId | null): void;
  setSnapToGrid(on: boolean): void;
}

export type OfficeStore = UseBoundStore<StoreApi<OfficeStoreState>>;

export const DEFAULT_GRID_SIZE = 20;

export interface OfficeStoreDeps {
  readonly storage: LayoutStorage;
  readonly id: () => DepartmentId;
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
      activity: {},
      settings: { snapToGrid: stored?.snapToGrid ?? false, gridSize },
      selectedId: null,

      load: (departments, employees = []) => {
        const layout = deps.storage.readLayout();
        set({
          departments: applyStoredLayout(departments, layout),
          employees,
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
          { id: deps.id, now: deps.now },
        );
        if (isErr(created)) return created;
        const next = [...departments, created.value];
        set({ departments: next });
        persist(next, settings);
        return created;
      },

      activityOf: (id) => get().activity[id] ?? "idle",

      setActivity: (id, state) => {
        set({ activity: { ...get().activity, [id]: state } });
      },

      select: (id) => {
        set({ selectedId: id });
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
