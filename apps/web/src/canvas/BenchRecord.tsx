/**
 * What a bench handed out, and what came back.
 *
 * The reason the bench exists: two people on different models taking the same
 * kind of work, so you can read their output side by side and say which is
 * better. So the model each person is running is on every row — a record that
 * answered "who" and not "which model" would be a record of the wrong thing.
 *
 * Derived, like every other view on this canvas. The work is the office's tasks
 * filtered by the bench that placed them, and the output is the documents those
 * tasks produced — both already in the store, neither kept as a second list
 * somebody has to remember to update.
 *
 * There is no cost or time here, deliberately. `UsageEvent` already records
 * tokens, priced cost and duration per run, but nothing persists it: the only
 * sink is in-memory inside `vo run`. A column of blanks promising numbers that
 * never arrive is worse than a record that says what it can.
 */
import type { ReactNode } from "react";
import type { Bench, Employee, Task } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";

/** One person's share, for the line that makes the split visible at a glance. */
interface Share {
  readonly name: string;
  readonly model: string;
  readonly taken: number;
}

function sharesOf(placed: readonly Task[], people: readonly Employee[]): readonly Share[] {
  const byId = new Map(people.map((one) => [one.id as string, one]));
  const counts = new Map<string, number>();
  for (const task of placed) {
    if (task.assigneeId === null) continue;
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, taken]) => ({
    name: byId.get(id)?.name ?? "Someone who has left",
    model: byId.get(id)?.llm.model ?? "—",
    taken,
  }));
}

export function BenchRecord({
  store,
  bench,
}: {
  readonly store: OfficeStore;
  readonly bench: Bench;
}): ReactNode {
  const tasks = store((state) => state.tasks);
  const employees = store((state) => state.employees);
  const documents = store((state) => state.documents);

  const placed = tasks.filter((task) => task.benchId === bench.id);
  const byId = new Map(employees.map((one) => [one.id as string, one]));
  const shares = sharesOf(placed, employees);

  return (
    <section
      role="group"
      aria-label={`What ${bench.name} handed out`}
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">What {bench.name} handed out</p>

      {placed.length === 0 ? (
        <p className="text-[11px] text-ink-muted">
          Nothing yet. Work aimed at this bench will appear here, with who took it and what they
          produced.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-ink-muted">
            {shares
              .map((share) => `${share.name} (${share.model}): ${String(share.taken)}`)
              .join(" · ")}
          </p>

          <ul className="flex flex-col gap-1.5">
            {placed.map((task) => {
              const who = task.assigneeId === null ? undefined : byId.get(task.assigneeId);
              const produced = documents.filter(
                (document) =>
                  document.ownerKind === "task" &&
                  document.ownerId === task.id &&
                  document.tray === "out",
              );
              return (
                <li key={task.id} className="flex flex-col gap-0.5 text-xs text-ink">
                  <span className="min-w-0 truncate">{task.title}</span>
                  <span className="text-[10px] text-ink-muted">
                    {/* A bare id would be unreadable, and somebody can leave
                        between taking work and this being read. */}
                    {who?.name ?? "Someone who has left"}
                    {who === undefined ? "" : ` · ${who.llm.model}`}
                  </span>
                  <span className="text-[10px] text-ink-muted">
                    {produced.length === 0
                      ? "Produced nothing yet"
                      : produced.map((document) => document.name).join(", ")}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
