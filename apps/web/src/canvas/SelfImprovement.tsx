/**
 * Whether this office may look back over one person's work and propose better
 * instructions for them.
 *
 * Off for everybody until somebody switches it on, per person rather than per
 * office: an office will want it on for the clerk who drafts replies and off
 * for the one that touches money.
 *
 * **The panel says what the loop may and may not do**, because that is the
 * whole reason it is safe to leave on. It proposes; a person accepts. It may
 * change how somebody works — their instructions and their examples — and it
 * can never widen what they may call, what they may spend, or an approval gate,
 * nor switch itself on. A switch that did not say that is a switch nobody
 * should flip.
 *
 * The switch is the drawer's draft and goes in with its one Save. **Look back
 * over the work** does not: it is a question put to the office, which answers
 * with a proposal or with nothing.
 */
import { useState, type ReactNode } from "react";
import type { Employee, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Problems } from "../ui/field.js";

export function SelfImprovement({
  store,
  employee,
  on,
  onChange,
}: {
  readonly store: OfficeStore;
  readonly employee: Employee;
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}): ReactNode {
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  const look = (): void => {
    setLooking(true);
    setFound(null);
    void store
      .getState()
      .lookBack(employee.id)
      .then((outcome) => {
        setLooking(false);
        setProblems(outcome.ok ? [] : outcome.problems);
        if (!outcome.ok) return;
        // Nothing found is an answer, and a press that says nothing reads as a
        // press that failed.
        setFound(
          outcome.proposed
            ? "Proposed a change — it is on the Proposals screen, waiting for you."
            : "Read their finished work and found nothing worth changing.",
        );
      });
  };

  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border p-2">
      <p className="text-xs font-medium text-ink">Getting better at the job</p>

      <label className="flex items-center gap-1.5 text-[10px] text-ink-muted">
        <input
          type="checkbox"
          className="accent-accent"
          aria-label="Look back over their work"
          checked={on}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        Look back over their work
      </label>

      {on ? (
        <>
          <p className="text-[10px] text-ink-muted">
            Once a night the office reads this person&rsquo;s finished work — how often it went
            back, the reason given, what it cost — and may <span className="text-ink">propose</span>{" "}
            a change to how they work. Every proposal waits for you on the Proposals screen, and you
            can put an accepted one back.
          </p>
          <p className="text-[10px] text-ink-muted">
            It can only ever change their instructions and their examples. It can never change what
            they may call, what they may spend, what waits for your approval, or this switch.
          </p>

          <div className="flex items-center gap-2">
            <Button aria-label="Look back over the work" disabled={looking} onClick={look}>
              {looking ? "Reading…" : "Look back over the work"}
            </Button>
            {found !== null && <span className="text-[10px] text-ink-muted">{found}</span>}
          </div>
        </>
      ) : (
        <p className="text-[10px] text-ink-muted">
          Off. Nobody reads this person&rsquo;s record and nothing about how they work changes
          unless you change it.
        </p>
      )}

      <Problems problems={problems} />
    </section>
  );
}
