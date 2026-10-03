import { describe, expect, it } from "vitest";
import { createDepartment, type DepartmentId } from "../department/department.js";
import { createEmployee, type Employee, type EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { isErr, unwrap } from "../shared/result.js";
import {
  acceptProposal,
  applyProposal,
  createProposal,
  declineProposal,
  PROPOSABLE_FIELDS,
  revertProposal,
  type Proposal,
  type ProposalId,
} from "./proposal.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-10-04T09:00:00Z");
const later = new Date("2026-10-04T11:00:00Z");
const deps = { id: () => "prop-1" as ProposalId, now: () => at };

const eng = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);

const sam = (overrides: Record<string, unknown> = {}): Employee =>
  unwrap(
    createEmployee(
      {
        name: "Sam",
        role: "Clerk",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
        selfImprovement: true,
        ...overrides,
      },
      { department: { id: eng.id, officeId }, supervisor: null },
      { id: () => "emp-sam" as EmployeeId, now: () => at },
    ),
  );

const input = (overrides: Record<string, unknown> = {}) => ({
  officeId,
  employeeId: "emp-sam",
  because: "Three pieces of work went back for the same reason: no order number.",
  changes: [
    {
      field: "instructions",
      before: null,
      after: "Always check the order number against the shipping system before replying.",
    },
  ],
  evidence: [{ taskId: "task-1", what: "went back twice: no order number" }],
  ...overrides,
});

describe("a proposal the office makes about one of its people", () => {
  it("says who it is about, what it would change and why", () => {
    const proposal = unwrap(createProposal(input(), deps));

    expect(proposal).toMatchObject({
      id: "prop-1",
      officeId,
      employeeId: "emp-sam",
      status: "waiting",
      because: "Three pieces of work went back for the same reason: no order number.",
      madeAt: at,
      decidedBy: null,
      decidedAt: null,
    });
    expect(proposal.changes[0]?.field).toBe("instructions");
  });

  it("names the work it learned from, so nobody has to take its word", () => {
    const proposal = unwrap(createProposal(input(), deps));

    expect(proposal.evidence).toEqual([
      { taskId: "task-1", what: "went back twice: no order number" },
    ]);
  });

  it("refuses one that changes nothing", () => {
    expect(isErr(createProposal(input({ changes: [] }), deps))).toBe(true);
  });

  it("refuses one that says nothing about why", () => {
    // A change nobody can weigh is a change nobody should accept.
    expect(isErr(createProposal(input({ because: "   " }), deps))).toBe(true);
  });

  it("refuses one with no evidence at all", () => {
    expect(isErr(createProposal(input({ evidence: [] }), deps))).toBe(true);
  });
});

describe("what a proposal may never touch", () => {
  it("may change only how a person works", () => {
    expect([...PROPOSABLE_FIELDS]).toEqual(["instructions", "examples"]);
  });

  it("refuses to touch the switch that governs it", () => {
    // A loop that can switch itself on is a loop nobody switched on.
    const refused = createProposal(
      input({ changes: [{ field: "selfImprovement", before: false, after: true }] }),
      deps,
    );

    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) expect(refused.error[0]?.message).toMatch(/instructions|examples/);
  });

  it("refuses to touch what somebody may call", () => {
    expect(
      isErr(
        createProposal(
          input({ changes: [{ field: "toolGrants", before: [], after: [{ tool: "*" }] }] }),
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("refuses to touch what somebody may spend", () => {
    expect(
      isErr(
        createProposal(
          input({ changes: [{ field: "budget", before: null, after: { limitUsd: 1000 } }] }),
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("refuses to touch an approval gate", () => {
    // A loop that can widen its own gates is not a loop anybody can leave
    // running overnight.
    expect(
      isErr(
        createProposal(
          input({ changes: [{ field: "gatedActions", before: ["external_send"], after: [] }] }),
          deps,
        ),
      ),
    ).toBe(true);
  });

  it("refuses the lot when one change in it is forbidden", () => {
    const refused = createProposal(
      input({
        changes: [
          { field: "instructions", before: null, after: "Fine on its own." },
          { field: "toolGrants", before: [], after: [{ tool: "*" }] },
        ],
      }),
      deps,
    );

    expect(isErr(refused)).toBe(true);
  });
});

describe("accepting a proposal", () => {
  const waiting = (): Proposal => unwrap(createProposal(input(), deps));

  it("writes what it proposed onto the person", () => {
    const changed = unwrap(applyProposal(sam(), waiting()));

    expect(changed.instructions).toBe(
      "Always check the order number against the shipping system before replying.",
    );
  });

  it("changes nothing else about them", () => {
    const before = sam({ instructions: "Old." });

    const after = unwrap(applyProposal(before, waiting()));

    expect({ ...after, instructions: before.instructions }).toEqual(before);
  });

  it("is refused by the same rules that refuse anybody typing it", () => {
    // The caps live in one place; a proposal is not a way around them.
    const tooLong = unwrap(
      createProposal(
        input({ changes: [{ field: "instructions", before: null, after: "x".repeat(20_001) }] }),
        deps,
      ),
    );

    expect(isErr(applyProposal(sam(), tooLong))).toBe(true);
  });

  it("records who said yes and when", () => {
    const accepted = unwrap(acceptProposal(waiting(), "anton@acme.test", later));

    expect(accepted).toMatchObject({
      status: "accepted",
      decidedBy: "anton@acme.test",
      decidedAt: later,
    });
  });

  it("refuses a second decision about the same one", () => {
    const accepted = unwrap(acceptProposal(waiting(), "anton@acme.test", later));

    expect(isErr(acceptProposal(accepted, "somebody-else", later))).toBe(true);
    expect(isErr(declineProposal(accepted, "somebody-else", later))).toBe(true);
  });

  it("is refused for a proposal about somebody else", () => {
    const other = unwrap(createProposal(input({ employeeId: "emp-other" }), deps));

    expect(isErr(applyProposal(sam(), other))).toBe(true);
  });
});

describe("declining a proposal", () => {
  it("records who said no, and changes nobody", () => {
    const declined = unwrap(
      declineProposal(unwrap(createProposal(input(), deps)), "anton@acme.test", later),
    );

    expect(declined).toMatchObject({ status: "declined", decidedBy: "anton@acme.test" });
  });
});

describe("putting an accepted proposal back", () => {
  const accepted = (): Proposal =>
    unwrap(acceptProposal(unwrap(createProposal(input(), deps)), "anton@acme.test", later));

  it("returns what the person held before it", () => {
    const changed = unwrap(applyProposal(sam(), accepted()));

    const back = unwrap(revertProposal(changed, accepted()));

    expect(back.employee.instructions).toBeNull();
  });

  it("marks it put back, so the record says what happened", () => {
    const changed = unwrap(applyProposal(sam(), accepted()));
    const back = unwrap(revertProposal(changed, accepted()));

    expect(back.proposal.status).toBe("reverted");
  });

  it("refuses when somebody has edited the text since", () => {
    // Putting back something a person has since rewritten is not a revert, it
    // is a second change nobody asked for.
    const changed = unwrap(applyProposal(sam(), accepted()));
    const edited = { ...changed, instructions: "Somebody rewrote this by hand." };

    expect(isErr(revertProposal(edited, accepted()))).toBe(true);
  });

  it("refuses to put back one nobody accepted", () => {
    expect(isErr(revertProposal(sam(), unwrap(createProposal(input(), deps))))).toBe(true);
  });
});
