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
 *
 * Two shapes, because a bench does one of two things. A bench that takes work in
 * turn handed out a list of different jobs, and that is what it shows. A
 * shootout asked everybody the same question, so the question is stated once and
 * the answers sit under it to be read against each other — and that is also
 * where a winner is chosen, because the moment somebody has just read both is
 * the only moment they know which was better.
 */
import { useState, type ReactNode } from "react";
import {
  contestStanding,
  type Bench,
  type Document,
  type Employee,
  type Task,
  type TaskId,
  type UsageRecord,
  type ValidationError,
} from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, inputClass, Problems } from "../ui/field.js";

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
  // Two decimals would render a few tenths of a cent as "$0.01", overstating
  // the cheap model whose whole point is that it is cheap; four decimals would
  // pad every ordinary figure with zeros it does not have.
  const money =
    spend.usd > 0 && spend.usd < 0.01
      ? `$${spend.usd.toFixed(4).replace(/0+$/, "")}`
      : `$${spend.usd.toFixed(2)}`;
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

/** What an entry produced, as the office holds it. */
function producedBy(documents: readonly Document[], taskId: string): readonly Document[] {
  return documents.filter(
    (document) =>
      document.ownerKind === "task" && document.ownerId === taskId && document.tray === "out",
  );
}

/**
 * One answer in a contest: who gave it, on what, at what cost — and the text.
 *
 * The text is fetched when somebody asks for it rather than with the page: a
 * contest of four answers is four documents nobody has said they want to read.
 * It opens below the row instead of in a column beside the others, because this
 * is a drawer — two columns here would be two inches of text each.
 */
function Answer({
  entry,
  who,
  produced,
  spend,
  read,
}: {
  readonly entry: Task;
  readonly who: Employee | undefined;
  readonly produced: readonly Document[];
  readonly spend: Spend;
  readonly read: (id: Document["id"]) => Promise<string | null>;
}): ReactNode {
  const [showing, setShowing] = useState<readonly { id: string; name: string; text: string }[]>([]);

  const open = (document: Document): void => {
    void read(document.id).then((text) => {
      if (text === null) return;
      setShowing((already) =>
        already.some((one) => one.id === document.id)
          ? already.filter((one) => one.id !== document.id)
          : [...already, { id: document.id, name: document.name, text }],
      );
    });
  };

  return (
    <li className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-xs text-ink">
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 truncate">
          {/* A bare id would be unreadable, and somebody can leave between
              taking work and this being read. */}
          {who?.name ?? "Someone who has left"}
          {entry.won === null ? "" : " · won"}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
          {readableSpend(spend)}
          {spend.calls === 0 ? "" : ` · ${readableTime(spend.ms)}`}
        </span>
      </span>
      <span className="text-[10px] text-ink-muted">{who?.llm.model ?? "—"}</span>

      {produced.length === 0 ? (
        <span className="text-[10px] text-ink-muted">
          {entry.status === "done" ? "Produced nothing" : "Still working"}
        </span>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {produced.map((document) => (
            <li key={document.id} className="flex items-baseline gap-2 text-[10px] text-ink-muted">
              <span className="min-w-0 truncate">{document.name}</span>
              {document.mediaType.startsWith("text/") && (
                <button
                  type="button"
                  aria-label={`Read ${document.name}`}
                  className="ml-auto shrink-0 text-ink-muted hover:text-ink"
                  onClick={() => {
                    open(document);
                  }}
                >
                  Read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showing.map((one) => (
        <pre
          key={one.id}
          aria-label={one.name}
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded-panel bg-surface-muted p-2 text-[10px] text-ink"
        >
          {one.text}
        </pre>
      ))}
    </li>
  );
}

/** How a verdict is said out loud, once there is one. */
function wonLine(winner: Task, by: Employee | undefined, judge: Employee | undefined): string {
  const decided =
    winner.won?.decidedBy === null ? "a person" : (judge?.name ?? "somebody who has left");
  return `${by?.name ?? "Someone who has left"} won — ${winner.won?.reason ?? ""} · decided by ${decided}`;
}

/**
 * One contest: the question, every answer to it, and which one won.
 *
 * Choosing happens here and nowhere else. A verdict is only worth anything from
 * somebody who has just read the answers, and this is where they are.
 */
function Contest({
  store,
  entries,
  people,
  documents,
  usage,
}: {
  readonly store: OfficeStore;
  readonly entries: readonly Task[];
  readonly people: ReadonlyMap<string, Employee>;
  readonly documents: readonly Document[];
  readonly usage: readonly UsageRecord[];
}): ReactNode {
  const first = entries[0];
  const standing = contestStanding(entries);
  const finished = entries.filter((entry) => entry.status === "done");
  const [winnerId, setWinnerId] = useState("");
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  if (first === undefined) return null;
  const won = entries.find((entry) => entry.won !== null);
  const chosen = winnerId === "" ? finished[0]?.id : (winnerId as TaskId);

  const decide = (): void => {
    if (chosen === undefined) return;
    void store
      .getState()
      .recordContestWin(chosen, reason)
      .then((outcome) => {
        setProblems(outcome.ok ? [] : outcome.problems);
        if (outcome.ok) setReason("");
      });
  };

  return (
    <section
      role="group"
      aria-label={first.title}
      className="flex flex-col gap-1 rounded-panel border border-border p-2"
    >
      {/* Once, not once per answer: everybody was asked exactly this. */}
      <p className="text-xs font-medium text-ink">{first.title}</p>
      {first.acceptanceCriteria.length > 0 && (
        <p className="text-[10px] text-ink-muted">
          Done when: {first.acceptanceCriteria.join("; ")}
        </p>
      )}
      <p className="text-[10px] text-ink-muted">
        {standing === "running"
          ? `${String(entries.length - finished.length)} of ${String(entries.length)} still working — the answers are not all in yet.`
          : standing === "ready"
            ? `${String(finished.length)} answers in. Read them and say which won.`
            : ""}
      </p>

      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <Answer
            key={entry.id}
            entry={entry}
            who={entry.assigneeId === null ? undefined : people.get(entry.assigneeId)}
            produced={producedBy(documents, entry.id)}
            spend={spendOf(usage.filter((row) => row.taskId === entry.id))}
            read={async (id) => {
              const body = await store.getState().fetchBody(id);
              return body === null ? null : new TextDecoder().decode(body);
            }}
          />
        ))}
      </ul>

      {won?.won != null && (
        <p className="border-t border-border pt-1.5 text-[11px] text-ink">
          {wonLine(
            won,
            won.assigneeId === null ? undefined : people.get(won.assigneeId),
            won.won.decidedBy === null ? undefined : people.get(won.won.decidedBy),
          )}
        </p>
      )}

      {won === undefined && standing === "ready" && (
        <div className="flex flex-col gap-1 border-t border-border pt-1.5">
          <Field label="Winner">
            <select
              className={inputClass}
              value={chosen ?? ""}
              onChange={(event) => {
                setWinnerId(event.target.value);
              }}
            >
              {finished.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.assigneeId === null
                    ? "Nobody in particular"
                    : (people.get(entry.assigneeId)?.name ?? "Someone who has left")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Why it won">
            <textarea
              className={inputClass}
              rows={2}
              placeholder="tighter, and it kept the detail"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </Field>
          <Problems problems={problems} />
          <Button
            aria-label="Record verdict"
            // A winner with no reason is a preference rather than a judgement,
            // and the reason is the only part anybody can act on later.
            disabled={reason.trim().length === 0}
            onClick={decide}
          >
            Record verdict
          </Button>
        </div>
      )}
    </section>
  );
}

/** Every contest this bench has run, newest first. */
function contestsOf(placed: readonly Task[]): readonly (readonly Task[])[] {
  const byContest = new Map<string, Task[]>();
  for (const task of placed) {
    if (task.contestId === null) continue;
    const already = byContest.get(task.contestId);
    if (already === undefined) byContest.set(task.contestId, [task]);
    else already.push(task);
  }
  const newest = (entries: readonly Task[]): number =>
    Math.max(...entries.map((entry) => entry.createdAt.getTime()));
  return [...byContest.values()].sort((a, b) => newest(b) - newest(a));
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
  const contests = bench.strategy === "shootout" ? contestsOf(placed) : [];
  // A bench switched from one strategy to the other still holds what it placed
  // before, and that work is a list rather than a contest.
  const loose = bench.strategy === "shootout" ? placed.filter((t) => t.contestId === null) : placed;

  return (
    <section
      role="group"
      aria-label={`What ${bench.name} handed out`}
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">What {bench.name} handed out</p>

      {contests.map((entries) => (
        <Contest
          key={entries[0]?.contestId ?? ""}
          store={store}
          entries={entries}
          people={byId}
          documents={documents}
          usage={usage}
        />
      ))}

      {placed.length === 0 ? (
        <p className="text-[11px] text-ink-muted">
          Nothing yet. Work aimed at this bench will appear here, with who took it and what they
          produced.
        </p>
      ) : loose.length === 0 ? null : (
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
            {loose.map((task) => {
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
