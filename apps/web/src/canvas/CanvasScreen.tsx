/**
 * The canvas, with the office that the application has already loaded.
 *
 * Loading used to happen here, which meant the office arrived only for whoever
 * opened the canvas first; it now happens where the application starts, so this
 * is only drawing. Keeping the two apart is the rule this file was written
 * around — it just had the loading on the wrong side of the line.
 */
import type { ReactNode } from "react";
import { officeStore } from "../office/store.js";
import { Canvas } from "./Canvas.js";
import { DepartmentDrawer } from "./DepartmentDrawer.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";
import { OfficeDrawer } from "./OfficeDrawer.js";
import { EmployeeDrawer } from "./EmployeeDrawer.js";
import { Palette } from "./Palette.js";

export function CanvasScreen(): ReactNode {
  return (
    <div className="flex h-full">
      <Palette store={officeStore} />
      <div className="min-w-0 flex-1">
        <Canvas store={officeStore} />
      </div>
      <OfficeDrawer store={officeStore} />
      <ConnectionDrawer store={officeStore} />
      <DepartmentDrawer store={officeStore} />
      <EmployeeDrawer store={officeStore} />
    </div>
  );
}
