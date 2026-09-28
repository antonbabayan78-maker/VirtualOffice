/**
 * What happens when something from the palette lands on the canvas.
 *
 * Kept apart from the component because this is the part with rules: a person
 * needs a department to work in, a department needs room of its own, and a drop
 * that cannot be honoured has to say why rather than silently doing nothing.
 * Turning a screen position into a canvas one is the component's job; deciding
 * what the drop means is this one's.
 */
import { isErr, type Department } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export type PaletteKind = "department" | "person";

export interface PaletteItem {
  readonly kind: PaletteKind;
  readonly label: string;
  /** What the palette tells you before you try it. */
  readonly hint: string;
}

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  {
    kind: "department",
    label: "Department",
    hint: "Drop on empty canvas to open a new department.",
  },
  {
    kind: "person",
    label: "Person",
    hint: "Drop inside a department to hire someone into it.",
  },
];

/** The department under a point, or null. The topmost one wins an overlap. */
export function departmentAt(
  departments: readonly Department[],
  point: CanvasPoint,
): Department | null {
  for (let index = departments.length - 1; index >= 0; index--) {
    const department = departments[index];
    if (department === undefined) continue;
    const { position, size } = department;
    const inside =
      point.x >= position.x &&
      point.x <= position.x + size.width &&
      point.y >= position.y &&
      point.y <= position.y + size.height;
    if (inside) return department;
  }
  return null;
}

export type DropResult = { readonly ok: true } | { readonly ok: false; readonly notice: string };

function refuse(store: OfficeStore, notice: string): DropResult {
  store.getState().setNotice(notice);
  return { ok: false, notice };
}

/** A name nobody in the office is using yet. */
function freeName(taken: readonly string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${String(n)}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function dropItem(store: OfficeStore, kind: PaletteKind, point: CanvasPoint): DropResult {
  const state = store.getState();
  const target = departmentAt(state.departments, point);

  if (kind === "person") {
    if (target === null) {
      return refuse(store, "A person needs a department to work in. Drop them inside one.");
    }
    const added = state.addEmployee({
      name: freeName(
        state.employees.map((employee) => employee.name),
        "New hire",
      ),
      role: "Unassigned",
      // Joining a department means wearing its colour until told otherwise.
      color: target.color,
      departmentId: target.id,
    });
    if (isErr(added)) {
      return refuse(store, added.error.map((problem) => problem.message).join("; "));
    }
    store.getState().setNotice(null);
    return { ok: true };
  }

  if (target !== null) {
    return refuse(store, `That space belongs to ${target.name}. Drop a department on open canvas.`);
  }
  const added = state.addDepartment({
    name: freeName(
      state.departments.map((department) => department.name),
      "New department",
    ),
    color: "#64748b",
    position: point,
  });
  if (isErr(added)) {
    return refuse(store, added.error.map((problem) => problem.message).join("; "));
  }
  store.getState().setNotice(null);
  return { ok: true };
}
