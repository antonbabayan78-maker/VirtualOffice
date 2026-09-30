import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Office, OfficeId } from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { OfficeDrawer } from "./OfficeDrawer.js";

const at = new Date("2026-09-28T09:00:00Z");
const acme: Office = {
  id: "office-acme" as OfficeId,
  name: "Acme Robotics",
  schedule: { kind: "always" },
  priority: "normal",
  runState: "running",
  configVersion: 1,
  createdAt: at,
};

let store: OfficeStore;

function open(office: Office | null = acme) {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  if (office !== null) store.getState().loadOffice(office);
  store.getState().openOffice(office !== null);
  return render(<OfficeDrawer store={store} />);
}

beforeEach(() => {
  open();
});

describe("the office drawer", () => {
  it("stays shut until the office is opened", () => {
    act(() => {
      store.getState().openOffice(false);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says which office it is", () => {
    expect(screen.getByDisplayValue("Acme Robotics")).toBeTruthy();
  });

  it("renames the office", async () => {
    const user = userEvent.setup();
    const name = screen.getByLabelText(/name/i);
    await user.clear(name);
    await user.type(name, "Northwind");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(store.getState().office?.name).toBe("Northwind");
  });

  it("sets the priority the whole organisation works at", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/priority/i), "urgent");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(store.getState().office?.priority).toBe("urgent");
  });

  it("says what that setting does to everyone below it", () => {
    expect(screen.getByText(/outranks every department/i)).toBeTruthy();
  });

  it("shows what the office refused rather than closing on a failure", async () => {
    const user = userEvent.setup();
    const name = screen.getByLabelText(/name/i);
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/must not be empty/i)).toBeTruthy();
  });

  it("closes without saving when cancelled", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/priority/i), "urgent");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(store.getState().office?.priority).toBe("normal");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("what the office can reach, from the office panel", () => {
  it("is on the office's own panel, because a connector belongs to the office", () => {
    // Not on a department's: two departments granted the same web connector are
    // reaching the same place under the same allowlist.
    expect(screen.getByRole("group", { name: /what this office can reach/i })).toBeTruthy();
  });

  it("is not there on a canvas that has no office", () => {
    act(() => {
      store.getState().openOffice(false);
    });
    expect(screen.queryByRole("group", { name: /what this office can reach/i })).toBeNull();
  });
});

describe("stopping the office from its own panel", () => {
  it("offers the switch", () => {
    expect(screen.getByRole("group", { name: /whether this office picks up work/i })).toBeTruthy();
  });

  it("stops the office the moment it is pressed, not when Save is", async () => {
    // A stop switch that waits for a Save somewhere else reads as one that did
    // not work — and stopping work is what you most want to be instant.
    const user = userEvent.setup();
    const control = screen.getByRole("group", { name: /picks up work/i });
    await user.click(within(control).getByRole("checkbox"));

    expect(store.getState().office?.runState).toBe("paused");
  });

  it("stays stopped when the drawer is cancelled", async () => {
    // Cancel throws away the draft. It must not quietly restart the office.
    const user = userEvent.setup();
    const control = screen.getByRole("group", { name: /picks up work/i });
    await user.click(within(control).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(store.getState().office?.runState).toBe("paused");
  });

  it("starts it again", async () => {
    const user = userEvent.setup();
    act(() => {
      store.getState().loadOffice({ ...acme, runState: "paused" });
    });
    const control = screen.getByRole("group", { name: /picks up work/i });
    expect(within(control).getByRole("checkbox")).not.toBeChecked();

    await user.click(within(control).getByRole("checkbox"));
    expect(store.getState().office?.runState).toBe("running");
  });
});
