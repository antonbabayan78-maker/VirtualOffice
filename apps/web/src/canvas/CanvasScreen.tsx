/**
 * The canvas, with an office in it.
 *
 * Where that office comes from depends on what is configured: a real one over
 * the API when there is one to talk to, and the sample office otherwise, so the
 * canvas is usable before a server exists. When it is talking to an office it
 * also follows its event stream, so somebody else's change appears here without
 * a reload.
 *
 * Loading is kept apart from drawing: this decides what office to show and says
 * so plainly when it cannot, while Canvas only ever draws what the store holds.
 */
import { useEffect, useState, type ReactNode } from "react";
import { isErr } from "@vo/core";
import { createApiClient } from "../api/client.js";
import { readApiConfig } from "../api/config.js";
import { openOfficeStream } from "../api/stream.js";
import { followOffice } from "../office/follow.js";
import { officeStore } from "../office/store.js";
import { loadSampleOffice } from "../office/sample-office.js";
import { Canvas } from "./Canvas.js";
import { DepartmentDrawer } from "./DepartmentDrawer.js";
import { EmployeeDrawer } from "./EmployeeDrawer.js";
import { Palette } from "./Palette.js";

export function CanvasScreen(): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const config = readApiConfig(import.meta.env);

    if (config === null) {
      // Nobody to talk to: show the sample office so the canvas still works.
      if (officeStore.getState().departments.length > 0) return;
      const office = loadSampleOffice();
      if (isErr(office)) {
        setProblem(office.error.map((e) => `${e.path}: ${e.message}`).join("; "));
        return;
      }
      officeStore.getState().load(office.value.departments, office.value.employees);
      return;
    }

    const api = createApiClient({ baseUrl: config.baseUrl, token: config.token });
    const follower = followOffice({ store: officeStore, api, officeId: config.officeId });

    void follower.reload();
    const stream = openOfficeStream({
      url: config.streamUrl,
      token: config.token,
      officeId: config.officeId,
      since: () => officeStore.getState().seenOffset,
      onEvent: (event) => {
        void follower.apply(event as never);
      },
      // Too far behind to be caught up: start again rather than stay wrong.
      onGap: () => {
        void follower.reload();
      },
    });

    return () => {
      stream.close();
    };
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
