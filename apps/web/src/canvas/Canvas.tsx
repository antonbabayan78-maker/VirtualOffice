/**
 * The office canvas.
 *
 * React Flow draws and moves; every rule about what a move means lives in the
 * office store, so the same rule holds however a change arrives. The component
 * translates: store to nodes on the way in, node changes to store calls on the
 * way out. Nothing about snapping, minimum sizes or persistence is decided here.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
} from "@xyflow/react";
import type { DepartmentId } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { ActivityLegend } from "./ActivityLegend.js";
import { DepartmentNode, type DepartmentNodeType } from "./DepartmentNode.js";

const NODE_TYPES = { department: DepartmentNode };

function CanvasSurface({ store }: { readonly store: OfficeStore }): ReactNode {
  const departments = store((state) => state.departments);
  const employees = store((state) => state.employees);
  const activity = store((state) => state.activity);
  const settings = store((state) => state.settings);
  const selectedId = store((state) => state.selectedId);

  const nodes = useMemo<DepartmentNodeType[]>(
    () =>
      departments.map((department) => ({
        id: department.id,
        type: "department" as const,
        position: department.position,
        width: department.size.width,
        height: department.size.height,
        selected: department.id === selectedId,
        data: {
          name: department.name,
          color: department.color,
          employees: employees
            .filter((employee) => employee.departmentId === department.id)
            .map((employee) => ({
              id: employee.id,
              name: employee.name,
              activity: activity[employee.id] ?? ("idle" as const),
            })),
        },
      })),
    [departments, employees, activity, selectedId],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<DepartmentNodeType>[]) => {
      const state = store.getState();
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          state.moveDepartment(change.id as DepartmentId, change.position);
        } else if (change.type === "dimensions" && change.dimensions) {
          state.resizeDepartment(change.id as DepartmentId, change.dimensions);
        } else if (change.type === "select") {
          state.select(change.selected ? (change.id as DepartmentId) : null);
        }
      }
    },
    [store],
  );

  return (
    <ReactFlow
      nodes={nodes}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      snapToGrid={settings.snapToGrid}
      snapGrid={[settings.gridSize, settings.gridSize]}
      minZoom={0.2}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: false }}
      className="bg-canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={settings.gridSize} size={1} />
      <Controls />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => (node.data as { color?: string }).color ?? "var(--color-border)"}
        className="!bg-surface"
      />
    </ReactFlow>
  );
}

export function Canvas({ store }: { readonly store: OfficeStore }): ReactNode {
  const departments = store((state) => state.departments);
  const settings = store((state) => state.settings);
  // Actions are called through getState rather than selected: selecting a
  // method hands its reference around, separated from the store it belongs to.
  const onSnapChange = (event: { readonly target: { readonly checked: boolean } }): void => {
    store.getState().setSnapToGrid(event.target.checked);
  };

  return (
    <div className="relative h-full w-full">
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3 rounded-panel border border-border bg-surface px-3 py-1.5 shadow-sm">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={settings.snapToGrid}
            onChange={onSnapChange}
            className="accent-accent"
          />
          Snap to grid
        </label>
        <span className="h-4 w-px bg-border" />
        <ActivityLegend />
      </div>

      {departments.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-ink">No departments yet</p>
          <p className="max-w-xs text-xs text-ink-muted">
            An office needs somewhere to put people. Load an office file, or add a department.
          </p>
        </div>
      ) : (
        <ReactFlowProvider>
          <CanvasSurface store={store} />
        </ReactFlowProvider>
      )}
    </div>
  );
}
