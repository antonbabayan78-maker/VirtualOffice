/**
 * A department on the canvas: a coloured room its people sit in.
 *
 * The colour is the department's own, used at low opacity for the room and at
 * full strength for its edge and title bar, so a dozen departments stay
 * distinguishable without turning the canvas into a paint chart.
 */
import { Fragment, type ReactNode } from "react";
import { Handle, NodeResizer, Position, type NodeProps, type Node } from "@xyflow/react";
import { MIN_DEPARTMENT_SIZE } from "@vo/core";
import { describeActivity, labelActivity } from "../office/activity.js";
import { EmployeeAvatar, type ActivityState } from "./EmployeeAvatar.js";

export interface DepartmentNodeData extends Record<string, unknown> {
  readonly name: string;
  readonly color: string;
  readonly employees: readonly {
    readonly id: string;
    readonly name: string;
    readonly activity: ActivityState;
  }[];
  /** Opens the drawer for one of the people in this room. */
  readonly onSelectEmployee: (id: string) => void;
}

export type DepartmentNodeType = Node<DepartmentNodeData, "department">;

export function DepartmentNode({ data, selected }: NodeProps<DepartmentNodeType>): ReactNode {
  return (
    <>
      {/*
        Arrows need somewhere to land, on every side: a department below another
        should be reached from underneath, not by a line that loops around the
        building. Each side carries both a source and a target, and the edge
        names the pair it wants — React Flow silently drops an edge it cannot
        anchor, so nothing is left to chance.
      */}
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((side) => (
        <Fragment key={side}>
          <Handle
            type="target"
            id={`${side}-in`}
            position={side}
            className="!size-2 !border-border !bg-surface !opacity-0"
          />
          <Handle
            type="source"
            id={`${side}-out`}
            position={side}
            className="!size-2 !border-border !bg-surface !opacity-0"
          />
        </Fragment>
      ))}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border-border !bg-surface !opacity-0"
      />
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_DEPARTMENT_SIZE.width}
        minHeight={MIN_DEPARTMENT_SIZE.height}
        lineClassName="!border-accent"
        handleClassName="!size-2 !rounded-sm !border-accent !bg-surface"
      />
      <div
        data-testid="department"
        className="flex h-full w-full flex-col overflow-hidden rounded-panel border-2"
        style={{
          borderColor: data.color,
          // Mixed in sRGB, not oklch: the surface is white, white has no hue of
          // its own, and an oklch mix interpolates hue polarly — which turned
          // every department's tint pink whatever colour it was given.
          backgroundColor: `color-mix(in srgb, ${data.color} 8%, var(--color-surface))`,
        }}
      >
        <header
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-white"
          style={{ backgroundColor: data.color }}
        >
          <span>{data.name}</span>
          <span className="ml-auto text-xs font-normal opacity-80">
            {data.employees.length === 1 ? "1 person" : `${String(data.employees.length)} people`}
          </span>
        </header>

        <ul className="flex flex-wrap content-start gap-4 p-4">
          {data.employees.map((employee) => (
            <li key={employee.id}>
              <button
                type="button"
                // nodrag keeps a click from being read as a drag of the room.
                className="nodrag flex w-16 cursor-pointer flex-col items-center gap-1 rounded-lg p-1 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                aria-label={`Configure ${employee.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onSelectEmployee(employee.id);
                }}
              >
                <EmployeeAvatar name={employee.name} state={employee.activity} size={44} />
                <span className="w-full truncate text-center text-[11px] text-ink-muted">
                  {employee.name}
                </span>
                {employee.activity !== "idle" && (
                  <span
                    // The colour says it at a glance; the chip says it for
                    // anyone who cannot rely on colour, and when several
                    // figures are pulsing at once.
                    className="rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white"
                    style={{ backgroundColor: `var(--color-${employee.activity})` }}
                    title={describeActivity(employee.activity)}
                  >
                    {labelActivity(employee.activity)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
