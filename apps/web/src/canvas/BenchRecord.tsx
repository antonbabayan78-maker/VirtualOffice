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
 * Cost and time come from the office's usage rows, joined on the task. An
 * unpriced call is the one thing that cannot be summed away: the registry
 * returns null when it has no price for a model, so that nothing can quietly
 * add it to a total and call it free. A total containing one is shown as a
 * floor — "at least" — with the number of unpriced calls named, because a
 * figure that is silently too low is worse than one that admits it.
 */
import type { ReactNode } from "react";
import type { Bench, Employee, Task, UsageRecord } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";

/** What a set of usage rows comes to. */
interface Spend {
  readonly usd: number;
  /** Calls the registry had no price for; a total holding one is a floor. */
  readonly unpriced: number;
  readonly ms: number;
  readonly calls: number;
}

const NOTHING: Spend = { usd: 0, unpriced: 0, ms: 0, calls: 0 };

function spendOf(rows: readonly UsageRecord[]): Spend {
  return rows.reduce<Spend>((total, row) => {
    const event = row.event;
    const cost = event["cost"];
    const usd =
      typeof cost === "object" &&
      cost !== null &&
      typeof (cost as { totalUsd?: unknown }).totalUsd === "number"
        ? (cost as { totalUsd: number }).totalUsd
        : null;
    const ms = typeof event["durationMs"] === "number" ? event["durationMs"] : 0;
    return {
      usd: total.usd + (usd ?? 0),
      unpriced: total.unpriced + (usd === null ? 1 : 0),
      ms: total.ms + ms,
      calls: total.calls + 1,
    };
  }, NOTHING);
}

/** Money as somebody reads it, with a floor when something could not be priced. */
function readableSpend(spend: Spend): string {
  if (spend.calls === 0) return "cost not recorded";
  const money = `$${spend.usd.toFixed(spend.usd > 0 && spend.usd < 0.01 ? 4 : 2)}`;
  if (spend.unpriced === 0) return money;
  const calls =
    spend.unpriced === 1 ? "1 call unpriced" : `${String(spend.unpriced)} calls unpriced`;
  return `at least ${money} · ${calls}`;
}

const readableTime = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;

/** One person's share, for the line that makes the split visible at a glance. */
interface Share {
  readonly name: string;
  readonly model: string;
  readonly taken: number;
  readonly spend: Spend;
}

function sharesOf(
  placed: readonly Task[],
  people: readonly Employee[],
  usage: readonly UsageRecord[],
): readonly Share[] {
  const byId = new Map(people.map((one) => [one.id as string, one]));
  const counts = new Map<string, number>();
  for (const task of placed) {
    if (task.assigneeId === null) continue;
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }
  // Only spend on work this bench placed: another bench's bill is not part of
  // this comparison, however the same person spent it.
  const mine = new Set(placed.map((task) => task.id as string));
  return [...counts.entries()].map(([id, taken]) => ({
    name: byId.get(id)?.name ?? "Someone who has left",
    model: byId.get(id)?.llm.model ?? "—",
    taken,
    spend: spendOf(
      usage.filter((row) => row.employeeId === id && row.taskId !== null && mine.has(row.taskId)),
    ),
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
  const usage = store((state) => state.usage);

  const placed = tasks.filter((task) => task.benchId === bench.id);
  const byId = new Map(employees.map((one) => [one.id as string, one]));
  const shares = sharesOf(placed, employees, usage);

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
              .map(
                (share) =>
                  `${share.name} (${share.model}): ${String(share.taken)} — ${readableSpend(share.spend)}`,
              )
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
              const spend = spendOf(usage.filter((row) => row.taskId === task.id));
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
                  <span className="text-[10px] text-ink-muted">
                    {readableSpend(spend)}
                    {spend.calls === 0 ? "" : ` · ${readableTime(spend.ms)}`}
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
