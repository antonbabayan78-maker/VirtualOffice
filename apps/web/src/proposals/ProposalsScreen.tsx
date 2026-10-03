/**
 * What the office has proposed about its own people.
 *
 * The office reads somebody's finished work overnight — how often it went back,
 * the reason written into the review, what it cost — and suggests a change to
 * how that person has been told to work. Every one of them waits here for a
 * person. That is what makes the switch safe to leave on.
 *
 * **Its own screen, not a fourth kind of approval.** Everything in the
 * approvals inbox is a piece of work stopped for a person, answered and gone.
 * A proposal is not a piece of work: it is a change to somebody, it stays on
 * the record after it is decided, and an accepted one can be put back. Mixed
 * into that inbox it would be the one row where "approve" meant something else.
 *
 * **Before and after, side by side, always.** A change you cannot read
 * backwards is a change nobody can weigh, and a change nobody can weigh is one
 * people accept out of politeness. The evidence is named for the same reason:
 * the office says which work taught it this, so nobody has to take its word.
 */
import { useState, type ReactNode } from "react";
import type { Proposal, ProposedChange, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Problems } from "../ui/field.js";
import type { ProposalDecision } from "../office/office-store.js";

/** What a proposal would change, as something a person reads rather than a diff. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  instructions: "How they work",
  examples: "Work that was good",
};

const readable = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

function Change({ change }: { readonly change: ProposedChange }): ReactNode {
  const empty = change.before === null || change.before === undefined;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink">
        {FIELD_NAMES[change.field] ?? change.field}
      </span>
      <div className="flex flex-col gap-1 sm:flex-row">
        <div className="min-w-0 flex-1 rounded-panel bg-surface-muted p-2">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">Now</span>
          <p className="whitespace-pre-wrap break-words text-[11px] text-ink-muted">
            {empty ? "They have been told nothing." : readable(change.before)}
          </p>
        </div>
        <div className="min-w-0 flex-1 rounded-panel border border-accent/40 bg-surface p-2">
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">Proposed</span>
          <p className="whitespace-pre-wrap break-words text-[11px] text-ink">
            {readable(change.after)}
          </p>
        </div>
      </div>
    </div>
  );
}

const decidedDate = (at: Date | null): string =>
  at === null || Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 16).replace("T", " ");

function Row({
  store,
  proposal,
}: {
  readonly store: OfficeStore;
  readonly proposal: Proposal;
}): ReactNode {
  const employees = store((state) => state.employees);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [deciding, setDeciding] = useState(false);

  // The id rather than nothing for somebody this canvas does not know: a row
  // about nobody is a row nobody can act on.
  const who =
    employees.find((employee) => employee.id === proposal.employeeId)?.name ?? proposal.employeeId;

  const decide = (decision: ProposalDecision): void => {
    setDeciding(true);
    void store
      .getState()
      .decideProposal(proposal.id, decision)
      .then((outcome) => {
        setDeciding(false);
        setProblems(outcome.ok ? [] : outcome.problems);
      });
  };

  return (
    <div
      role="group"
      aria-label={`Proposal about ${who}`}
      className="flex flex-col gap-2 rounded-panel border border-border p-3"
    >
      <span className="flex items-baseline gap-2">
        <span className="truncate text-xs font-medium text-ink">{who}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-muted">
          {decidedDate(proposal.madeAt)}
        </span>
      </span>

      {proposal.changes.map((change) => (
        <Change key={change.field} change={change} />
      ))}

      <p className="text-[11px] text-ink">{proposal.because}</p>

      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wide text-ink-muted">What it read</span>
        <ul className="flex flex-col gap-0.5">
          {proposal.evidence.map((one) => (
            <li key={`${one.taskId}:${one.what}`} className="flex gap-2 text-[11px] text-ink-muted">
              <span className="shrink-0 font-mono">{one.taskId}</span>
              <span className="min-w-0 break-words">{one.what}</span>
            </li>
          ))}
        </ul>
      </div>

      {proposal.status !== "waiting" && (
        <p className="text-[10px] text-ink-muted">
          {proposal.status === "reverted" ? "Put back" : proposal.status}
          {proposal.decidedBy === null ? "" : ` by ${proposal.decidedBy}`}
          {proposal.decidedAt === null ? "" : ` on ${decidedDate(proposal.decidedAt)}`}
        </p>
      )}

      {proposal.status === "waiting" && (
        <div className="flex gap-2">
          <Button
            disabled={deciding}
            onClick={() => {
              decide("accept");
            }}
          >
            Accept
          </Button>
          <Button
            disabled={deciding}
            onClick={() => {
              decide("decline");
            }}
          >
            Decline
          </Button>
        </div>
      )}

      {proposal.status === "accepted" && (
        <div className="flex items-center gap-2">
          <Button
            disabled={deciding}
            onClick={() => {
              decide("revert");
            }}
          >
            Put it back
          </Button>
          <span className="text-[10px] text-ink-muted">
            Returns what they held before this. Refused if somebody has rewritten it since.
          </span>
        </div>
      )}

      <Problems problems={problems} />
    </div>
  );
}

/** Waiting first, then whatever has been decided, newest first within each. */
function inOrder(proposals: readonly Proposal[]): readonly Proposal[] {
  const rank = (proposal: Proposal): number => (proposal.status === "waiting" ? 0 : 1);
  return [...proposals].sort(
    (a, b) => rank(a) - rank(b) || b.madeAt.getTime() - a.madeAt.getTime(),
  );
}

export function ProposalsScreen({ store }: { readonly store: OfficeStore }): ReactNode {
  const proposals = store((state) => state.proposals);

  return (
    <section
      role="region"
      aria-label="Proposals"
      className="flex h-full flex-col gap-3 overflow-auto p-6"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">Proposals</h1>
        <p className="max-w-prose text-sm text-ink-muted">
          Changes this office would make to how its own people work, each waiting for you. Nothing
          here has changed anybody yet.
        </p>
      </div>

      {proposals.length === 0 ? (
        <p className="max-w-prose rounded-panel border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
          Nothing has been proposed. The office looks back over the work of whoever has that
          switched on, on their panel.
        </p>
      ) : (
        <div className="flex max-w-prose flex-col gap-2">
          {inOrder(proposals).map((proposal) => (
            <Row key={proposal.id} store={store} proposal={proposal} />
          ))}
        </div>
      )}
    </section>
  );
}
