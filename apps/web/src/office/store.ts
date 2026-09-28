/**
 * The store the running app uses: browser storage for layout, real ids and a
 * real clock. Tests build their own with fakes rather than reaching for this.
 */
import type { DepartmentId } from "@vo/core";
import { browserLayoutStorage } from "./layout-storage.js";
import { createOfficeStore } from "./office-store.js";

export const officeStore = createOfficeStore({
  storage: browserLayoutStorage(),
  id: () => `dept-${Math.random().toString(36).slice(2, 10)}` as DepartmentId,
  now: () => new Date(),
});
