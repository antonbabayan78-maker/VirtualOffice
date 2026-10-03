/**
 * A change the office proposes to one of its own people.
 *
 * The office looks back over somebody's finished work — how often it went back,
 * what the reason was, which acceptance criteria went unmet, what it cost — and
 * suggests a better way for them to work. A person says yes or no. Nothing here
 * changes anybody on its own.
 *
 * **What it may touch is a very short list**, and that is the whole safety
 * story. A proposal may change how a person works: their standing instructions
 * and their examples. It may never touch the switch that governs it, what
 * somebody may call, what they may spend, or an approval gate. A loop that can
 * widen its own gates is not a loop anybody can leave running overnight — so the
 * list is here, in the domain, refused once, and asserted by name in tests
 * rather than written down in a comment and hoped for.
 *
 * **Each change carries what was there before**, which is what makes one press
 * put it back. It is the shape a config diff already uses (`FieldChange`), for
 * the same reason: a change you cannot read backwards is a change you cannot
 * undo.
 */
import type { EmployeeId } from "../employee/employee.js";
import { updateEmployee, type Employee, type UpdateEmployeeInput } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const proposalIdBrand: unique symbol;
export type ProposalId = string & { readonly [proposalIdBrand]: true };

/**
 * The only fields a proposal may name.
 *
 * How a person works, and nothing about what they are allowed to do. Adding to
 * this list is a decision about what an unattended loop may change, which is
 * why it is one line that a test reads back.
 */
export const PROPOSABLE_FIELDS = ["instructions", "examples"] as const;
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

export const PROPOSAL_STATUSES = ["waiting", "accepted", "declined", "reverted"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposedChange {
  readonly field: ProposableField;
  /** What the person held when the proposal was made; what a revert puts back. */
  readonly before: unknown;
  readonly after: unknown;
}

/** One piece of work the proposal learned from, so nobody has to take its word. */
export interface ProposalEvidence {
  readonly taskId: string;
  readonly what: string;
}

export interface Proposal {
  readonly id: ProposalId;
  readonly officeId: OfficeId;
  readonly employeeId: EmployeeId;
  readonly status: ProposalStatus;
  readonly changes: readonly ProposedChange[];
  /** Why, in the office's own words. */
  readonly because: string;
  readonly evidence: readonly ProposalEvidence[];
  readonly madeAt: Date;
  /** The person who decided, never an employee. */
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
}

export interface CreateProposalInput {
  readonly officeId: string;
  readonly employeeId: string;
  /** Loose on the way in, narrow on the entity: this arrives from a model. */
  readonly changes: unknown;
  readonly because: string;
  readonly evidence: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProposalDeps {
  readonly id: () => ProposalId;
  readonly now: () => Date;
}

export const PROPOSAL_REASON_MAX_LENGTH = 2_000;
export const MAX_PROPOSAL_EVIDENCE = 20;

function isProposable(field: unknown): field is ProposableField {
  return typeof field === "string" && (PROPOSABLE_FIELDS as readonly string[]).includes(field);
}

export function createProposal(input: CreateProposalInput, deps: ProposalDeps): Result<Proposal> {
  const errors: ValidationError[] = [];

  const because = typeof input.because === "string" ? input.because.trim() : "";
  if (because.length === 0) {
    errors.push({
      path: "because",
      message: "is required: a change nobody can weigh is a change nobody should accept",
    });
  } else if (because.length > PROPOSAL_REASON_MAX_LENGTH) {
    errors.push({
      path: "because",
      message: `must be at most ${String(PROPOSAL_REASON_MAX_LENGTH)} characters`,
    });
  }

  const asked: unknown[] = Array.isArray(input.changes) ? (input.changes as unknown[]) : [];
  const changes: ProposedChange[] = [];
  if (asked.length === 0) {
    errors.push({ path: "changes", message: "must change something" });
  } else {
    asked.forEach((one, index) => {
      const change = isRecord(one) ? one : {};
      const field = change["field"];
      if (isProposable(field)) {
        changes.push({ field, before: change["before"] ?? null, after: change["after"] });
      } else {
        // Said in full rather than "unknown field": this refusal is the
        // guardrail, and whoever reads it should see what the line is.
        errors.push({
          path: `changes[${String(index)}].field`,
          message:
            `may only be ${PROPOSABLE_FIELDS.join(" or ")} — how this person works. Never what` +
            ` they may call, what they may spend, an approval gate, or whether the office may` +
            ` propose at all`,
        });
      }
    });
  }

  const named: unknown[] = Array.isArray(input.evidence) ? (input.evidence as unknown[]) : [];
  const evidence: ProposalEvidence[] = [];
  if (named.length === 0) {
    errors.push({
      path: "evidence",
      message: "is required: a proposal names the work it learned from",
    });
  } else if (named.length > MAX_PROPOSAL_EVIDENCE) {
    errors.push({
      path: "evidence",
      message: `must name at most ${String(MAX_PROPOSAL_EVIDENCE)} pieces of work`,
    });
  } else {
    named.forEach((one, index) => {
      const said = isRecord(one) ? one : {};
      const taskId = said["taskId"];
      const what = said["what"];
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        errors.push({ path: `evidence[${String(index)}].taskId`, message: "must name the work" });
      }
      if (typeof what !== "string" || what.trim().length === 0) {
        errors.push({
          path: `evidence[${String(index)}].what`,
          message: "must say what happened in it",
        });
      }
      if (typeof taskId === "string" && typeof what === "string") {
        evidence.push({ taskId, what });
      }
    });
  }

  if (errors.length > 0) return err(errors);

  return ok({
    id: deps.id(),
    officeId: input.officeId as OfficeId,
    employeeId: input.employeeId as EmployeeId,
    status: "waiting",
    changes,
    because,
    evidence,
    madeAt: deps.now(),
    decidedBy: null,
    decidedAt: null,
  });
}

/**
 * What the changes amount to, as an ordinary employee update.
 *
 * Typed as core's own update input so the compiler agrees this can only name
 * the fields `PROPOSABLE_FIELDS` allows — the keys are those two and nothing
 * else by construction.
 */
function asChanges(proposal: Proposal, pick: "before" | "after"): UpdateEmployeeInput {
  const changes: { instructions?: string | null; examples?: unknown } = {};
  for (const change of proposal.changes) {
    if (change.field === "instructions") {
      changes.instructions = (change[pick] ?? null) as string | null;
    } else {
      changes.examples = change[pick];
    }
  }
  return changes;
}

function aboutThem(employee: Employee, proposal: Proposal): ValidationError[] {
  return employee.id === proposal.employeeId
    ? []
    : [{ path: "employeeId", message: "this proposal is about somebody else" }];
}

/**
 * Writes what a proposal asked for onto the person.
 *
 * Through `updateEmployee`, so the caps and rules that refuse a person typing
 * something are exactly the ones that refuse a proposal: a loop is not a way
 * around the office's own validation.
 */
export function applyProposal(employee: Employee, proposal: Proposal): Result<Employee> {
  const wrong = aboutThem(employee, proposal);
  if (wrong.length > 0) return err(wrong);
  return updateEmployee(employee, asChanges(proposal, "after"), { supervisor: null });
}

function decided(
  proposal: Proposal,
  status: Extract<ProposalStatus, "accepted" | "declined">,
  by: string,
  at: Date,
): Result<Proposal> {
  if (proposal.status !== "waiting") {
    return err([{ path: "status", message: `this proposal was already ${proposal.status}` }]);
  }
  if (by.trim().length === 0) {
    return err([{ path: "decidedBy", message: "a person decides a proposal, and is recorded" }]);
  }
  return ok({ ...proposal, status, decidedBy: by, decidedAt: at });
}

export const acceptProposal = (proposal: Proposal, by: string, at: Date): Result<Proposal> =>
  decided(proposal, "accepted", by, at);

export const declineProposal = (proposal: Proposal, by: string, at: Date): Result<Proposal> =>
  decided(proposal, "declined", by, at);

export interface PutBack {
  readonly employee: Employee;
  readonly proposal: Proposal;
}

/**
 * Puts an accepted proposal back, both halves at once.
 *
 * Refused when what the proposal wrote is not what the person holds now:
 * somebody has edited it since, and putting back their own words over that is
 * not a revert, it is a second change nobody asked for.
 */
export function revertProposal(employee: Employee, proposal: Proposal): Result<PutBack> {
  const wrong = aboutThem(employee, proposal);
  if (wrong.length > 0) return err(wrong);
  if (proposal.status !== "accepted") {
    return err([{ path: "status", message: "only a proposal that was accepted can be put back" }]);
  }

  const held = employee as unknown as Record<string, unknown>;
  for (const change of proposal.changes) {
    if (JSON.stringify(held[change.field] ?? null) !== JSON.stringify(change.after ?? null)) {
      return err([
        {
          path: change.field,
          message: `has been changed since this was accepted, so putting it back would undo that too`,
        },
      ]);
    }
  }

  const restored = updateEmployee(employee, asChanges(proposal, "before"), { supervisor: null });
  if (!restored.ok) return err(restored.error);
  return ok({ employee: restored.value, proposal: { ...proposal, status: "reverted" } });
}
