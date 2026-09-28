import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  unwrap,
  type Connection,
  type ConnectionId,
  type Department,
  type DepartmentId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { ConnectionDrawer } from "./ConnectionDrawer.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-29T09:00:00Z");

const department = (id: string, name: string): Department =>
  unwrap(
    createDepartment({ officeId, name, color: "#3366ff", position: { x: 0, y: 0 } }, [], {
      id: () => id as DepartmentId,
      now: () => at,
    }),
  );
const ops = department("dept-ops", "Operations");
const eng = department("dept-eng", "Engineering");

const watching: Connection = {
  id: "conn-watch" as ConnectionId,
  officeId,
  fromId: ops.id,
  toId: eng.id,
  kind: "watches",
  enabled: true,
  rules: { for: ["work_went_wrong"] },
  createdAt: at,
};

let store: OfficeStore;

function open(connection: Connection | null = watching) {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([ops, eng], [], [], connection === null ? [] : [connection]);
  if (connection !== null) store.getState().selectConnection(connection.id);
  return render(<ConnectionDrawer store={store} />);
}

beforeEach(() => {
  open();
});

describe("the connection drawer", () => {
  it("stays shut until an arrow is chosen", () => {
    act(() => {
      store.getState().selectConnection(null);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says which two departments the arrow joins, by name", () => {
    const panel = screen.getByRole("dialog");
    expect(panel.textContent).toContain("Operations");
    expect(panel.textContent).toContain("Engineering");
  });

  it("says what kind of relationship it is", () => {
    expect(screen.getByRole("dialog").textContent).toMatch(/watches/i);
  });

  it("says what it is watching for", () => {
    expect(screen.getByRole("dialog").textContent).toMatch(/went wrong/i);
  });

  it("switches the arrow off", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /in force|switched on|enabled/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(store.getState().connections[0]?.enabled).toBe(false);
  });

  it("closes without changing anything when cancelled", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /in force|switched on|enabled/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(store.getState().connections[0]?.enabled).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
