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
  judgeId: null,
};

const ada = person("emp-ada", "Ada", "claude-opus-5");

function mount(
  benches: readonly Bench[] = [],
  people: readonly Employee[] = [iris, theo],
  everyone: readonly Employee[] = [...people, ada],
) {
  cleanup();
  const onChange = vi.fn();
  render(
    <Benches
      benches={benches}
      people={people}
      everyone={everyone}
      newId={() => "bench-new"}
      onChange={onChange}
    />,
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
      { id: "bench-new", name: "Drafting", memberIds: [], strategy: "round_robin", judgeId: null },
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

describe("what a bench does with the work", () => {
  const shootout: Bench = { ...drafting, strategy: "shootout", memberIds: [iris.id, theo.id] };

  it("takes work in turn unless it is told otherwise", () => {
    mount([drafting]);
    expect(within(row("Drafting")).getByLabelText(/what it does/i)).toHaveValue("round_robin");
  });

  it("switches a bench to running everything off between everybody", async () => {
    const onChange = mount([drafting]);
    await userEvent
      .setup()
      .selectOptions(within(row("Drafting")).getByLabelText(/what it does/i), "shootout");

    expect(onChange).toHaveBeenCalledWith([{ ...drafting, strategy: "shootout" }]);
  });

  it("says what a shootout costs, because it is one bill per person", () => {
    // Four people on a bench is four times the money for one piece of work, and
    // nobody should discover that from an invoice.
    mount([shootout]);
    expect(row("Drafting")).toHaveTextContent(/every|each|per person|times/i);
  });

  it("offers nobody judging by default, which means a person decides", () => {
    mount([shootout]);
    expect(within(row("Drafting")).getByLabelText(/judge/i)).toHaveValue("");
  });

  it("offers anybody in the office to judge, not only this room", () => {
    // Ada works elsewhere. Somebody outside the room is often the only person
    // with nothing at stake in the comparison.
    mount([shootout]);
    const choices = within(within(row("Drafting")).getByLabelText(/judge/i)).getAllByRole("option");
    expect(choices.map((one) => one.textContent)).toContain("Ada");
  });

  it("does not offer an entrant as the judge", () => {
    // The office refuses it, and an entrant marking its own entry is the one
    // thing a comparison cannot survive.
    mount([shootout]);
    const choices = within(within(row("Drafting")).getByLabelText(/judge/i)).getAllByRole("option");
    expect(choices.map((one) => one.textContent)).not.toContain("Iris");
  });

  it("names the judge", async () => {
    const onChange = mount([shootout]);
    await userEvent.setup().selectOptions(within(row("Drafting")).getByLabelText(/judge/i), ada.id);

    expect(onChange).toHaveBeenCalledWith([{ ...shootout, judgeId: ada.id }]);
  });

  it("goes back to a person deciding", async () => {
    const judged = { ...shootout, judgeId: ada.id };
    const onChange = mount([judged]);
    await userEvent.setup().selectOptions(within(row("Drafting")).getByLabelText(/judge/i), "");

    expect(onChange).toHaveBeenCalledWith([{ ...judged, judgeId: null }]);
  });

  it("asks nobody to judge a bench that takes work in turn", () => {
    // There is nothing to judge: one person did the work.
    mount([drafting]);
    expect(within(row("Drafting")).queryByLabelText(/judge/i)).toBeNull();
  });

  it("drops a judge who has just been put on the bench", async () => {
    // Otherwise ticking somebody on quietly leaves a verdict in the hands of an
    // entrant, and the save comes back refused for a reason nobody can see.
    const judged = { ...shootout, memberIds: [iris.id], judgeId: theo.id };
    const onChange = mount([judged]);
    await userEvent.setup().click(within(row("Drafting")).getByRole("checkbox", { name: /Theo/ }));

    expect(onChange).toHaveBeenCalledWith([
      { ...judged, memberIds: [iris.id, theo.id], judgeId: null },
    ]);
  });
});
