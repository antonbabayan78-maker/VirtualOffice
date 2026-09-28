/**
 * What you get when you right-click a department.
 *
 * Deleting is offered but refused while anybody still works there, and the
 * reason is on the menu rather than behind a click: a disabled item that does
 * not say why is the same as a broken one. The store decides — this only asks.
 */
import { useEffect, type ReactNode } from "react";
import type { DepartmentId } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";

export interface DepartmentMenuTarget {
  readonly id: DepartmentId;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export function DepartmentMenu({
  store,
  target,
  onClose,
}: {
  readonly store: OfficeStore;
  readonly target: DepartmentMenuTarget;
  readonly onClose: () => void;
}): ReactNode {
  const employees = store((state) => state.employees);
  const staff = employees.filter((employee) => employee.departmentId === target.id);
  const blocked = staff.length > 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const remove = (): void => {
    if (blocked) return;
    const outcome = store.getState().removeDepartment(target.id);
    if (!outcome.ok) store.getState().setNotice(outcome.problems[0]?.message ?? "could not delete");
    onClose();
  };

  return (
    <div
      role="menu"
      aria-label={`${target.name} options`}
      className="absolute z-20 min-w-56 rounded-panel border border-border bg-surface py-1 shadow-lg"
      style={{ left: target.x, top: target.y }}
    >
      <div className="px-3 py-1 text-[11px] font-medium tracking-wide text-ink-muted uppercase">
        {target.name}
      </div>
      <button
        type="button"
        role="menuitem"
        aria-disabled={blocked}
        disabled={blocked}
        onClick={remove}
        className="w-full px-3 py-1.5 text-left text-xs text-error hover:bg-canvas disabled:cursor-not-allowed disabled:text-ink-muted"
      >
        Delete department
      </button>
      {blocked && (
        <p className="px-3 pb-1.5 text-[11px] text-ink-muted">
          {target.name} still has {staff.length} {staff.length === 1 ? "person" : "people"} in it.
          Move them out first.
        </p>
      )}
    </div>
  );
}
