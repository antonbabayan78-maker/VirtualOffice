/**
 * The office canvas.
 *
 * React Flow draws and moves; every rule about what a move means lives in the
 * office store, so the same rule holds however a change arrives. The component
 * translates: store to nodes on the way in, node changes to store calls on the
 * way out. Nothing about snapping, minimum sizes or persistence is decided here.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import type { DepartmentId, EmployeeId } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { ActivityLegend } from "./ActivityLegend.js";
import { PALETTE_MIME } from "./Palette.js";
import { dropItem, type PaletteKind } from "./drop.js";
import { DepartmentNode, type DepartmentNodeType } from "./DepartmentNode.js";
import { DepartmentMenu, type DepartmentMenuTarget } from "./DepartmentMenu.js";
import { edgesFrom } from "./edges.js";
import { summariseEmployee } from "../office/employee-summary.js";

const NODE_TYPES = { department: DepartmentNode };

function CanvasSurface({
  store,
  onContextMenu,
}: {
  readonly store: OfficeStore;
  readonly onContextMenu: (target: DepartmentMenuTarget) => void;
}): ReactNode {
  const flow = useReactFlow();
  const departments = store((state) => state.departments);
  const employees = store((state) => state.employees);
  const activity = store((state) => state.activity);
  const tasks = store((state) => state.tasks);
  const settings = store((state) => state.settings);
  const selectedId = store((state) => state.selectedId);
  const links = store((state) => state.links);

  const boxes = useMemo(
    () =>
      Object.fromEntries(
        departments.map((department) => [
          department.id,
          { ...department.position, ...department.size },
        ]),
      ),
    [departments],
  );
  const edges = useMemo(() => edgesFrom(links, boxes), [links, boxes]);

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
              summary: summariseEmployee(employee, {
                department,
                employees,
                tasks,
                activity: activity[employee.id] ?? "idle",
              }),
            })),
          onSelectEmployee: (id: string) => {
            store.getState().selectEmployee(id as EmployeeId);
          },
        },
      })),
    [departments, employees, tasks, activity, selectedId, store],
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

  const onDrop = (event: {
    preventDefault: () => void;
    dataTransfer: DataTransfer;
    clientX: number;
    clientY: number;
  }): void => {
    event.preventDefault();
    const kind = event.dataTransfer.getData(PALETTE_MIME);
    if (kind !== "person" && kind !== "department") return;
    // The pointer is in screen space; the office is in canvas space.
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    dropItem(store, kind satisfies PaletteKind, point);
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeContextMenu={(event, node) => {
        event.preventDefault();
        onContextMenu({
          id: node.id as DepartmentId,
          name: (node.data as { name: string }).name,
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onNodesChange={onNodesChange}
      snapToGrid={settings.snapToGrid}
      snapGrid={[settings.gridSize, settings.gridSize]}
      minZoom={0.2}
      maxZoom={2}
      fitView
      proOptions={{ hideAttribution: false }}
      className="bg-canvas"
      onDrop={onDrop}
      onDragOver={(event) => {
        // Without this the browser refuses the drop and nothing lands.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
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
  const [menu, setMenu] = useState<DepartmentMenuTarget | null>(null);
  const settings = store((state) => state.settings);
  const notice = store((state) => state.notice);
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

      {notice !== null && (
        <div
          role="status"
          className="absolute top-14 left-3 z-10 flex max-w-sm items-start gap-3 rounded-panel border border-border bg-surface px-3 py-2 text-xs text-ink shadow-sm"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="ml-auto text-ink-muted hover:text-ink"
            onClick={() => {
              store.getState().setNotice(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {departments.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-ink">No departments yet</p>
          <p className="max-w-xs text-xs text-ink-muted">
            An office needs somewhere to put people. Load an office file, or add a department.
          </p>
        </div>
      ) : (
        <ReactFlowProvider>
          <CanvasSurface store={store} onContextMenu={setMenu} />
        </ReactFlowProvider>
      )}

      {menu !== null && (
        <DepartmentMenu
          store={store}
          target={menu}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
