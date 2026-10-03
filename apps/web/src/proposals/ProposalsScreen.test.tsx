import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Proposal,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { ProposalsScreen } from "./ProposalsScreen.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-04T09:00:00Z");

const post: Department = unwrap(
  createDepartment(
    { officeId, name: "Post room", color: "#7c5cff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-post" as DepartmentId,
      now: () => at,
    },
  ),
);

const ada: Employee = unwrap(
  createEmployee(
    {
      name: "Ada",
      role: "Clerk",
      color: "#00aa66",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      selfImprovement: true,
      instructions: "Reply quickly.",
    },
    { department: { id: post.id, officeId }, supervisor: null },
    { id: () => "emp-ada" as EmployeeId, now: () => at },
  ),
);

const proposal = (overrides: Partial<Proposal> = {}): Proposal =>
  ({
    id: "prop-1",
    officeId,
    employeeId: ada.id,
    status: "waiting",
    changes: [
      {
        field: "instructions",
        before: "Reply quickly.",
        after: "Check the order number against the shipping system before replying.",
      },
    ],
    because: "Two pieces of work went back for want of an order number.",
    evidence: [{ taskId: "task-1", what: "went back twice: no order number" }],
    madeAt: at,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  }) as Proposal;

let store: OfficeStore;
let decided: { id: string; decision: string }[];

function open(proposals: readonly Proposal[], answer?: unknown) {
  cleanup();
  decided = [];
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([post], [ada]);
  store.getState().loadProposals(proposals);
  store.getState().connect({
    decideProposal: (id: string, decision: string) => {
      decided.push({ id, decision });
      return Promise.resolve(
        answer ?? { ok: true, value: { ...proposals[0], status: `${decision}ed` } },
      );
    },
  } as never);
  return render(<ProposalsScreen store={store} />);
}

const panel = () => screen.getByRole("region", { name: /proposals/i });
const rows = () => within(panel()).getAllByRole("group");
const row = (name: RegExp) => within(panel()).getByRole("group", { name });

beforeEach(() => {
  cleanup();
});

describe("the proposals screen", () => {
  it("says nothing is waiting when the office has proposed nothing", () => {
    open([]);

    expect(panel()).toHaveTextContent(/nothing/i);
    expect(within(panel()).queryAllByRole("group")).toEqual([]);
  });

  it("says who a proposal is about, by name", () => {
    open([proposal()]);

    expect(rows()).toHaveLength(1);
    expect(row(/Ada/)).toHaveTextContent("Ada");
  });

  it("shows what it would change, before and after", () => {
    // A change you cannot read backwards is a change nobody can weigh.
    open([proposal()]);

    const one = row(/Ada/);
    expect(one).toHaveTextContent("Reply quickly.");
    expect(one).toHaveTextContent("Check the order number against the shipping system");
  });

  it("says plainly when they had been told nothing before", () => {
    open([proposal({ changes: [{ field: "instructions", before: null, after: "Be careful." }] })]);

    expect(row(/Ada/)).toHaveTextContent(/nothing/i);
  });

  it("says why, in the office's own words", () => {
    open([proposal()]);

    expect(row(/Ada/)).toHaveTextContent(
      "Two pieces of work went back for want of an order number.",
    );
  });

  it("names the work it learned from, so nobody has to take its word", () => {
    open([proposal()]);

    const one = row(/Ada/);
    expect(one).toHaveTextContent("task-1");
    expect(one).toHaveTextContent("went back twice: no order number");
  });

  it("accepts one, and tells the office", async () => {
    const user = userEvent.setup();
    open([proposal()]);

    await user.click(within(row(/Ada/)).getByRole("button", { name: "Accept" }));

    expect(decided).toEqual([{ id: "prop-1", decision: "accept" }]);
  });

  it("declines one, and tells the office", async () => {
    const user = userEvent.setup();
    open([proposal()]);

    await user.click(within(row(/Ada/)).getByRole("button", { name: "Decline" }));

    expect(decided).toEqual([{ id: "prop-1", decision: "decline" }]);
  });

  it("offers to put back one that was accepted, and nothing else", async () => {
    const user = userEvent.setup();
    open([proposal({ status: "accepted", decidedBy: "anton@acme.test", decidedAt: at })]);

    const one = row(/Ada/);
    expect(within(one).queryByRole("button", { name: "Accept" })).toBeNull();
    await user.click(within(one).getByRole("button", { name: "Put it back" }));

    expect(decided).toEqual([{ id: "prop-1", decision: "revert" }]);
  });

  it("offers no decision at all on one already declined", () => {
    open([proposal({ status: "declined", decidedBy: "anton@acme.test", decidedAt: at })]);

    expect(within(row(/Ada/)).queryAllByRole("button")).toEqual([]);
  });

  it("says who decided it, and what they decided", () => {
    open([proposal({ status: "accepted", decidedBy: "anton@acme.test", decidedAt: at })]);

    const one = row(/Ada/);
    expect(one).toHaveTextContent("anton@acme.test");
    expect(one).toHaveTextContent(/accepted/i);
  });

  it("shows why the office refused a decision rather than pretending it took", async () => {
    const user = userEvent.setup();
    open([proposal({ status: "accepted", decidedBy: "anton@acme.test", decidedAt: at })], {
      ok: false,
      kind: "validation",
      errors: [{ path: "instructions", message: "has been changed since this was accepted" }],
    });

    await user.click(within(row(/Ada/)).getByRole("button", { name: "Put it back" }));

    expect(panel()).toHaveTextContent(/changed since this was accepted/);
  });

  it("names somebody this canvas does not know rather than nobody", () => {
    // A row about nobody is a row nobody can act on.
    open([proposal({ employeeId: "emp-gone" as EmployeeId })]);

    expect(row(/emp-gone/)).toBeTruthy();
  });
});
