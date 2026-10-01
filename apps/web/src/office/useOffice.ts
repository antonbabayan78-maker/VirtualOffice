/**
 * The application's one connection to its office, held for as long as it runs.
 *
 * A hook rather than a component so the shell stays a shell. It is deliberately
 * mounted above the router: moving between sections should not reload the
 * office or tear down its event stream, and landing on any address should find
 * the same data as landing on the canvas.
 *
 * With nothing configured it loads the sample office instead, so the canvas is
 * usable before a server exists — the rule the canvas screen already followed,
 * moved up with the rest of the loading.
 */
import { useEffect, useState } from "react";
import { isErr } from "@vo/core";
import { createApiClient } from "@vo/api-client";
import { readApiConfig } from "../api/config.js";
import { connectOffice } from "./office-connection.js";
import { loadSampleOffice } from "./sample-office.js";
import type { OfficeStore } from "./office-store.js";

/** Null while nothing is wrong, which is almost always. */
export function useOffice(store: OfficeStore): string | null {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const config = readApiConfig(import.meta.env);

    if (config === null) {
      // Nobody to talk to: show the sample office so the canvas still works.
      if (store.getState().departments.length > 0) return;
      const office = loadSampleOffice();
      if (isErr(office)) {
        setProblem(office.error.map((error) => `${error.path}: ${error.message}`).join("; "));
        return;
      }
      store.getState().load(office.value.departments, office.value.employees);
      return;
    }

    const connection = connectOffice({
      store,
      config,
      api: createApiClient({ baseUrl: config.baseUrl, token: config.token }),
    });
    return () => {
      connection.close();
    };
  }, [store]);

  return problem;
}
