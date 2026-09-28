/**
 * A department on the canvas: a coloured room its people sit in.
 *
 * The colour is the department's own, used at low opacity for the room and at
 * full strength for its edge and title bar, so a dozen departments stay
 * distinguishable without turning the canvas into a paint chart.
 */
import { NodeResizer, type NodeProps, type Node } from "@xyflow/react";
import type { ReactNode } from "react";
import { MIN_DEPARTMENT_SIZE } from "@vo/core";
import { EmployeeAvatar, type ActivityState } from "./EmployeeAvatar.js";

export interface DepartmentNodeData extends Record<string, unknown> {
  readonly name: string;
  readonly color: string;
  readonly employees: readonly {
    readonly id: string;
    readonly name: string;
    readonly activity: ActivityState;
  }[];
}

export type DepartmentNodeType = Node<DepartmentNodeData, "department">;

export function DepartmentNode({ data, selected }: NodeProps<DepartmentNodeType>): ReactNode {
  return (
    <>
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
            <li key={employee.id} className="flex w-16 flex-col items-center gap-1">
              <EmployeeAvatar name={employee.name} state={employee.activity} size={44} />
              <span className="w-full truncate text-center text-[11px] text-ink-muted">
                {employee.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
