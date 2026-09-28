/**
 * What you get when you point at somebody.
 *
 * A canvas figure is a silhouette and a first name. The questions that follow —
 * what are they for, what are they on, what is it costing, who do they answer
 * to — are answered here rather than by making somebody open a drawer.
 *
 * The summary itself is worked out in the store's own language; this only lays
 * it out. Shown on hover and on keyboard focus, so it is not mouse-only.
 *
 * Rendered into the document body rather than beside the figure. A department
 * clips what overflows it, so a tooltip on the top row would be cut in half by
 * the title bar — and the canvas is a scaled, translated element, which makes
 * even a fixed position inside it relative to that transform: the tooltip came
 * out shrunk to the zoom level and nowhere near the pointer.
 */
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { EmployeeSummary } from "../office/employee-summary.js";

function Line({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="ml-auto truncate text-right text-ink">{value}</dd>
    </div>
  );
}

export interface TooltipAnchor {
  /** Where the figure is on screen, from its bounding box. */
  readonly left: number;
  readonly top: number;
}

export function EmployeeTooltip({
  summary,
  anchor,
}: {
  readonly summary: EmployeeSummary;
  readonly anchor: TooltipAnchor;
}): ReactNode {
  const tip = (
    <div
      role="tooltip"
      style={{ left: anchor.left, top: anchor.top }}
      className="pointer-events-none fixed z-50 w-56 -translate-x-1/2 -translate-y-full rounded-panel border border-border bg-surface px-3 py-2 text-left shadow-lg"
    >
      <p className="text-xs font-semibold text-ink">{summary.name}</p>
      <p className="mb-1.5 text-[11px] text-ink-muted">{summary.role}</p>
      <dl className="space-y-0.5 text-[11px]">
        <Line label="Doing" value={summary.task ?? summary.activity} />
        <Line label="Department" value={summary.department} />
        <Line label="Model" value={summary.model} />
        {summary.reportsTo !== null && <Line label="Reports to" value={summary.reportsTo} />}
        <Line
          label="On their desk"
          value={summary.openTasks === 1 ? "1 task" : `${String(summary.openTasks)} tasks`}
        />
        {summary.skills.length > 0 && <Line label="Skills" value={summary.skills.join(", ")} />}
      </dl>
    </div>
  );

  // document.body is undefined while server-rendered; the canvas is not, but
  // the guard costs nothing and a crash here would take the whole canvas down.
  return typeof document === "undefined" ? tip : createPortal(tip, document.body);
}
