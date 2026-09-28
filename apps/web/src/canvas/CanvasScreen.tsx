/**
 * The canvas, with an office in it.
 *
 * Loading is separated from drawing: this decides what office to show and says
 * so plainly when it cannot, while Canvas only ever draws what the store holds.
 */
import { useEffect, useState, type ReactNode } from "react";
import { isErr } from "@vo/core";
import { officeStore } from "../office/store.js";
import { loadSampleOffice } from "../office/sample-office.js";
import { Canvas } from "./Canvas.js";
import { DepartmentDrawer } from "./DepartmentDrawer.js";
import { EmployeeDrawer } from "./EmployeeDrawer.js";
import { Palette } from "./Palette.js";

export function CanvasScreen(): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (officeStore.getState().departments.length > 0) return;
    const office = loadSampleOffice();
    if (isErr(office)) {
      setProblem(office.error.map((e) => `${e.path}: ${e.message}`).join("; "));
      return;
    }
    officeStore.getState().load(office.value.departments, office.value.employees);
  }, []);

  if (problem !== null) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-sm font-medium text-ink">This office will not open</h1>
        <p className="max-w-md text-xs text-ink-muted">{problem}</p>
      </section>
    );
  }

  return (
    <div className="flex h-full">
      <Palette store={officeStore} />
      <div className="min-w-0 flex-1">
        <Canvas store={officeStore} />
      </div>
      <DepartmentDrawer store={officeStore} />
      <EmployeeDrawer store={officeStore} />
    </div>
  );
}
