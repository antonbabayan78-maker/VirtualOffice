import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
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
