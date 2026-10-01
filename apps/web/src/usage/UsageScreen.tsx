/**
 * What the office has spent, and where.
 *
 * The page exists to answer one question — "which model is costing us, and on
 * whose work" — so the breakdowns are sorted biggest first and the first row of
 * each is the answer. Everything is derived from the usage rows the store
 * already holds; there is no second source of figures to disagree with the
 * bench record or the drawers.
 *
 * The bars are drawn rather than charted. A chart library for three sorted
 * lists would be a dependency that earns nothing, and a bar whose width is the
 * share of the largest row says the same thing. `meter` is the role for a
 * value within a known range, so a screen reader gets the number rather than a
 * decorative div.
 *
 * Costs that could not be priced are never folded into a total silently: the
 * registry returns nothing for a model it does not know, and a figure quietly
 * too low is worse than one that says how much it is missing.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { OfficeStore } from "../office/office-store.js";
import { asCsv, usageReport, type SpendRow, type UsageReport } from "../office/usage-report.js";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

const money = (usd: number): string =>
  usd > 0 && usd < 0.01 ? `$${usd.toFixed(4).replace(/0+$/, "")}` : `$${usd.toFixed(2)}`;

function Breakdown({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly SpendRow[];
}): ReactNode {
  // Share of the largest, so the top row fills the width and the rest are read
  // against it. Against the total instead, a dozen even rows would all be slivers.
  const largest = rows.reduce((most, row) => Math.max(most, row.usd), 0);

  return (
    <section
      role="group"
      aria-label={title}
      className="flex min-w-0 flex-1 flex-col gap-2 rounded-panel border border-border p-3"
    >
      <h2 className="text-xs font-medium text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-[11px] text-ink-muted">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.name} className="flex flex-col gap-0.5">
              {/* The name and the amount on one line, the model under it. Beside
                  each other they compete for a narrow column, and it was the
                  name that lost — "A…" identifies nobody. */}
              <span className="flex items-baseline gap-2 text-xs text-ink">
                <span className="min-w-0 truncate">{row.name}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {/* A row with nothing priced shows no figure at all: "$0.00"
                      beside a model reads as "this one is free", which is the
                      opposite of what is known about it. */}
                  {row.unpricedCalls === row.calls ? "not priced" : money(row.usd)}
                </span>
              </span>
              {(row.detail !== null ||
                (row.unpricedCalls > 0 && row.unpricedCalls < row.calls)) && (
                <span className="truncate text-[10px] text-ink-muted">
                  {row.detail ?? ""}
                  {row.detail !== null && row.unpricedCalls > 0 && row.unpricedCalls < row.calls
                    ? " · "
                    : ""}
                  {row.unpricedCalls > 0 && row.unpricedCalls < row.calls
                    ? `at least — ${String(row.unpricedCalls)} ${
                        row.unpricedCalls === 1 ? "call not priced" : "calls not priced"
                      }`
                    : ""}
                </span>
              )}
              <span
                role="meter"
                aria-label={`${row.name}: ${money(row.usd)}`}
                aria-valuenow={row.usd}
                aria-valuemin={0}
                aria-valuemax={largest}
                className="h-1.5 rounded-full bg-surface-muted"
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${String(largest === 0 ? 0 : (row.usd / largest) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Totals({ report }: { readonly report: UsageReport }): ReactNode {
  return (
    <section
      role="group"
      aria-label="What this office has spent"
      className="flex flex-col gap-1 rounded-panel border border-border p-3"
    >
      {report.calls === 0 ? (
        <p className="text-xs text-ink-muted">
          Nothing yet. Figures appear here as the office does work.
        </p>
      ) : (
        <>
          <p className="text-2xl font-semibold tabular-nums text-ink">{money(report.totalUsd)}</p>
          <p className="text-[11px] text-ink-muted">
            {report.calls === 1 ? "1 call" : `${String(report.calls)} calls`}
            {report.unpricedCalls > 0
              ? ` · at least: ${
                  report.unpricedCalls === 1
                    ? "1 call could not be priced"
                    : `${String(report.unpricedCalls)} calls could not be priced`
                }`
              : ""}
          </p>
          <p className="text-[11px] text-ink-muted">
            {report.usdPerCompletedTask === null
              ? "No work has finished yet, so there is no cost per piece of work."
              : `${money(report.usdPerCompletedTask)} per finished piece of work, over ${
                  report.completedTasks === 1
                    ? "1 of them"
                    : `${String(report.completedTasks)} of them`
                }.`}
          </p>
        </>
      )}
    </section>
  );
}

export function UsageScreen({ store }: { readonly store: OfficeStore }): ReactNode {
  const departments = store((state) => state.departments);
  const employees = store((state) => state.employees);
  const tasks = store((state) => state.tasks);
  const usage = store((state) => state.usage);
  const [departmentId, setDepartmentId] = useState("");

  const report = useMemo(
    () =>
      usageReport({
        departments,
        employees,
        tasks,
        usage,
        filter: departmentId === "" ? {} : { departmentId },
      }),
    [departments, employees, tasks, usage, departmentId],
  );

  /**
   * Hands the bytes to the browser rather than linking to the office: a link
   * would have to carry the token, and a token in a URL is a token in a log.
   */
  const exportCsv = (): void => {
    const url = URL.createObjectURL(new Blob([asCsv(report)], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "usage.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flex flex-col gap-3 p-6">
      <header className="flex items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Usage</h1>
          <p className="text-xs text-ink-muted">
            Tokens and cost, by model, person and department.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <Field label="Department">
            <select
              className={inputClass}
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
              }}
            >
              <option value="">Every department</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </Field>
          <Button aria-label="Export as CSV" disabled={report.calls === 0} onClick={exportCsv}>
            Export
          </Button>
        </div>
      </header>

      <Totals report={report} />

      <div className="flex flex-wrap gap-3">
        <Breakdown title="By model" rows={report.byModel} />
        <Breakdown title="By person" rows={report.byEmployee} />
        <Breakdown title="By department" rows={report.byDepartment} />
      </div>
    </section>
  );
}
