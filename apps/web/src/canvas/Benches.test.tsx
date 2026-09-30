import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createEmployee,
  unwrap,
  type Bench,
  type BenchId,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import { Benches } from "./Benches.js";

const officeId = "office-acme" as OfficeId;
const departmentId = "dept-design" as DepartmentId;
const at = new Date("2026-09-30T09:00:00Z");

const person = (id: string, name: string, model: string): Employee =>
  unwrap(
    createEmployee(
      { name, role: "Designer", color: "#00aa66", llm: { provider: "anthropic", model } },
      { department: { id: departmentId, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const iris = person("emp-iris", "Iris", "claude-sonnet-5");
const theo = person("emp-theo", "Theo", "claude-opus-5");

const drafting: Bench = {
  id: "bench-draft" as BenchId,
  name: "Drafting",
  memberIds: [iris.id],
  strategy: "round_robin",
};

function mount(benches: readonly Bench[] = [], people: readonly Employee[] = [iris, theo]) {
  cleanup();
  const onChange = vi.fn();
  render(
    <Benches benches={benches} people={people} newId={() => "bench-new"} onChange={onChange} />,
  );
  return onChange;
}

const panel = () => screen.getByRole("group", { name: /benches/i });
const row = (name: string) => within(panel()).getByRole("group", { name });

describe("the benches in a department", () => {
  it("says what a bench is for when there are none", () => {
    // Nobody guesses what "bench" means from an empty list.
    mount();
    expect(panel()).toHaveTextContent(/in turn|takes turns|rotation/i);
  });

  it("lists the ones it has", () => {
    mount([drafting]);
    expect(row("Drafting")).toBeTruthy();
  });

  it("adds one", async () => {
    const onChange = mount();
    const user = userEvent.setup();
    await user.type(within(panel()).getByLabelText(/new bench/i), "Drafting");
    await user.click(within(panel()).getByRole("button", { name: /add bench/i }));

    expect(onChange).toHaveBeenCalledWith([
      { id: "bench-new", name: "Drafting", memberIds: [], strategy: "round_robin" },
    ]);
  });

  it("does not offer to add one with no name", () => {
    mount();
    expect(within(panel()).getByRole("button", { name: /add bench/i })).toBeDisabled();
  });

  it("takes one away", async () => {
    const onChange = mount([drafting]);
    await userEvent.setup().click(within(row("Drafting")).getByRole("button", { name: /remove/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

describe("who is on a bench", () => {
  it("offers the department's own people, not free text", () => {
    mount([drafting]);
    expect(within(row("Drafting")).queryByRole("textbox")).toBeNull();
    expect(within(row("Drafting")).getByRole("checkbox", { name: /Iris/ })).toBeTruthy();
    expect(within(row("Drafting")).getByRole("checkbox", { name: /Theo/ })).toBeTruthy();
  });

  it("shows which model each person is on, since that is what is being compared", () => {
    mount([drafting]);
    expect(row("Drafting")).toHaveTextContent("claude-sonnet-5");
    expect(row("Drafting")).toHaveTextContent("claude-opus-5");
  });

  it("shows who is already on it", () => {
    mount([drafting]);
    expect(within(row("Drafting")).getByRole("checkbox", { name: /Iris/ })).toBeChecked();
    expect(within(row("Drafting")).getByRole("checkbox", { name: /Theo/ })).not.toBeChecked();
  });

  it("puts somebody on", async () => {
    const onChange = mount([drafting]);
    await userEvent.setup().click(within(row("Drafting")).getByRole("checkbox", { name: /Theo/ }));

    expect(onChange).toHaveBeenCalledWith([{ ...drafting, memberIds: [iris.id, theo.id] }]);
  });

  it("takes somebody off", async () => {
    const onChange = mount([drafting]);
    await userEvent.setup().click(within(row("Drafting")).getByRole("checkbox", { name: /Iris/ }));

    expect(onChange).toHaveBeenCalledWith([{ ...drafting, memberIds: [] }]);
  });

  it("will not put the same person on two benches", () => {
    // The office refuses it, because whose turn it is would have two answers.
    // Refusing here says so while the drawer is open rather than on save.
    const second: Bench = { ...drafting, id: "bench-2" as BenchId, name: "Review", memberIds: [] };
    mount([drafting, second]);

    expect(within(row("Review")).getByRole("checkbox", { name: /Iris/ })).toBeDisabled();
    expect(within(row("Review")).getByRole("checkbox", { name: /Theo/ })).not.toBeDisabled();
  });

  it("says where somebody already on another bench is", () => {
    const second: Bench = { ...drafting, id: "bench-2" as BenchId, name: "Review", memberIds: [] };
    mount([drafting, second]);
    expect(row("Review")).toHaveTextContent(/Drafting/);
  });

  it("says a bench with nobody on it will place nothing", () => {
    // It is valid, and it is also useless until somebody is added — which is
    // worth saying rather than letting work quietly pile up in a backlog.
    mount([{ ...drafting, memberIds: [] }]);
    expect(row("Drafting")).toHaveTextContent(/nobody|no one/i);
  });

  it("says a department with nobody in it has nobody to bench", () => {
    mount([drafting], []);
    expect(row("Drafting")).toHaveTextContent(/nobody|no one/i);
  });
});
