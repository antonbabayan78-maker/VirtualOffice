/**
 * A spending limit on one level of the office.
 *
 * One component for the office, a room and a person, because it is one control
 * — the only difference is how much stops, and that is in a sentence rather
 * than in the markup.
 *
 * It says what reaching the limit *does*, because that is not obvious and the
 * two possibilities need very different reactions: this stops work picking up
 * and starts again on its own when the period rolls, rather than pausing
 * anybody. Somebody who assumed the other would wait all night for a person to
 * restart an office that was going to restart itself.
 *
 * Spend is shown only when there is a limit to show it against, and "not known"
 * is said rather than drawn as $0.00 — nothing spent and never asked look
 * identical as zero, and one of them means the office could not be reached.
 */
import type { ReactNode } from "react";
import { budgetStanding, BUDGET_PERIODS, type Budget, type BudgetPeriod } from "@vo/core";
import { Field, inputClass } from "../ui/field.js";

export type BudgetSubject = "office" | "department" | "person";

const NO_LIMIT: Readonly<Record<BudgetSubject, string>> = {
  office: "No limit — this office spends what its work needs.",
  department: "No limit — this department spends what its work needs.",
  person: "No limit — they spend what their work needs.",
};

const WHAT_HAPPENS: Readonly<Record<BudgetSubject, string>> = {
  office:
    "At the limit nobody in the office picks anything up. Nobody is paused, and work starts again on its own when the period rolls.",
  department:
    "At the limit nobody in this department picks anything up. The rest of the office carries on, and work here starts again when the period rolls.",
  person:
    "At the limit they pick nothing up. Their open work stays on their desk, and they start again when the period rolls.",
};

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** The number a text field holds, or null when it holds nothing usable. */
const amount = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export function BudgetField({
  what,
  value,
  spentUsd,
  onChange,
}: {
  readonly what: BudgetSubject;
  readonly value: Budget | null;
  /** Absent means the office has not been asked, which is not the same as nil. */
  readonly spentUsd?: number;
  readonly onChange: (budget: Budget | null) => void;
}): ReactNode {
  const standing = budgetStanding(value, spentUsd ?? 0);

  const edit = (changes: Partial<Budget>): void => {
    const next: Budget = {
      limitUsd: value?.limitUsd ?? 0,
      warnAtUsd: value?.warnAtUsd ?? null,
      period: value?.period ?? "day",
      ...changes,
    };
    // No limit is no budget: clearing the amount takes the ceiling away rather
    // than leaving a limit of nothing, which would stop all work for ever.
    onChange(next.limitUsd > 0 ? next : null);
  };

  return (
    <section
      role="group"
      aria-label="Spending limit"
      className="flex flex-col gap-1.5 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">Spending limit</p>

      <div className="flex items-end gap-2">
        <Field label="Limit (USD)">
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="none"
            value={value === null ? "" : String(value.limitUsd)}
            onChange={(event) => {
              const limitUsd = amount(event.target.value);
              if (limitUsd === null) onChange(null);
              else edit({ limitUsd });
            }}
          />
        </Field>
        <Field label="Period">
          <select
            className={inputClass}
            value={value?.period ?? "day"}
            onChange={(event) => {
              edit({ period: event.target.value as BudgetPeriod });
            }}
          >
            {BUDGET_PERIODS.map((period) => (
              <option key={period} value={period}>
                {period}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {value !== null && (
        <Field label="Warn at (USD)">
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="at the limit"
            value={value.warnAtUsd === null ? "" : String(value.warnAtUsd)}
            onChange={(event) => {
              edit({ warnAtUsd: amount(event.target.value) });
            }}
          />
        </Field>
      )}

      {value === null ? (
        <p className="text-[11px] text-ink-muted">{NO_LIMIT[what]}</p>
      ) : (
        <>
          <p className="text-[11px] text-ink-muted">{WHAT_HAPPENS[what]}</p>
          <p className="text-[11px] text-ink-muted">
            {spentUsd === undefined
              ? "Spent so far: not known — the office has not been asked yet."
              : `Spent ${money(spentUsd)} of ${money(value.limitUsd)} this ${value.period}.`}
            {standing === "warn" && spentUsd !== undefined ? " Near the warning." : ""}
            {standing === "over" && spentUsd !== undefined
              ? " The limit is reached, so work here has stopped."
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
