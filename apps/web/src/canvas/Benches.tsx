/**
 * The benches in one department: boxes that take work in turn.
 *
 * Part of the department's draft, like its definition of done and its tool
 * grants, because a bench is a field of the department — so it is saved by the
 * drawer's Save and abandoned by Cancel, unlike the connectors panel, which
 * edits entities of the office's own.
 *
 * Membership is ticked from the room's own people rather than typed: the office
 * refuses a member who works elsewhere, so a text field would exist only to be
 * refused. Each person is shown with the model they are running, because
 * choosing who goes on a bench *is* choosing which models to compare — a list
 * of bare names would hide the one thing this feature is for.
 *
 * Somebody already on another bench in this room is shown ticked-out rather
 * than hidden: the office refuses two benches over one person, since "whose
 * turn" would have two answers, and saying where they are beats a save that
 * fails for a reason nobody can see.
 */
import { useState, type ReactNode } from "react";
import {
  BENCH_STRATEGIES,
  type Bench,
  type BenchId,
  type BenchStrategy,
  type Employee,
  type EmployeeId,
} from "@vo/core";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

const WHAT_IT_DOES: Readonly<Record<BenchStrategy, string>> = {
  round_robin: "Takes work in turn",
  shootout: "Everybody does the same job",
};

function OneBench({
  bench,
  people,
  everyone,
  elsewhere,
  onChange,
  onRemove,
}: {
  readonly bench: Bench;
  readonly people: readonly Employee[];
  /** The whole office, for the judge: judging is not this room's work. */
  readonly everyone: readonly Employee[];
  /** Who is on another bench here, and which one, so it can be said. */
  readonly elsewhere: ReadonlyMap<string, string>;
  readonly onChange: (bench: Bench) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const toggle = (id: EmployeeId, on: boolean): void => {
    const memberIds = on
      ? [...bench.memberIds, id]
      : bench.memberIds.filter((candidate) => candidate !== id);
    onChange({
      ...bench,
      memberIds,
      // Somebody put on the bench stops being its judge. The office refuses an
      // entrant judging its own entry, and a save refused for a reason nobody
      // can see is worse than a choice quietly going back to "a person decides".
      ...(bench.judgeId !== null && memberIds.includes(bench.judgeId) ? { judgeId: null } : {}),
    });
  };

  return (
    <div
      role="group"
      aria-label={bench.name}
      className="flex flex-col gap-1 rounded-panel border border-border p-2"
    >
      <div className="flex items-center gap-2 text-xs text-ink">
        <span className="min-w-0 truncate font-medium">{bench.name}</span>
        <button
          type="button"
          aria-label={`Remove ${bench.name}`}
          className="ml-auto shrink-0 text-ink-muted hover:text-ink"
          onClick={onRemove}
        >
          ×
        </button>
      </div>

      {people.length === 0 ? (
        <p className="text-[10px] text-ink-muted">
          Nobody works here yet, so there is nobody to add.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {people.map((one) => {
            const on = bench.memberIds.includes(one.id);
            const other = elsewhere.get(one.id);
            return (
              <li key={one.id}>
                <label className="flex items-center gap-1.5 text-[11px] text-ink">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    aria-label={one.name}
                    checked={on}
                    disabled={!on && other !== undefined}
                    onChange={(event) => {
                      toggle(one.id, event.target.checked);
                    }}
                  />
                  {one.name}
                  <span className="text-ink-muted">{one.llm.model}</span>
                  {!on && other !== undefined && (
                    <span className="text-ink-muted">· on {other}</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {bench.memberIds.length === 0 && people.length > 0 && (
        // Valid, and useless until somebody is on it. Worth saying, rather than
        // letting work aimed at it pile up unassigned in a backlog.
        <p className="text-[10px] text-ink-muted">Nobody on it yet, so it will place nothing.</p>
      )}

      <Field label="What it does">
        <select
          className={inputClass}
          value={bench.strategy}
          onChange={(event) => {
            onChange({ ...bench, strategy: event.target.value as BenchStrategy });
          }}
        >
          {BENCH_STRATEGIES.map((strategy) => (
            <option key={strategy} value={strategy}>
              {WHAT_IT_DOES[strategy]}
            </option>
          ))}
        </select>
      </Field>

      {bench.strategy === "shootout" && (
        <>
          <p className="text-[10px] text-ink-muted">
            {/* Said before the money is spent rather than discovered on a bill:
                every piece of work aimed here is done once per person. */}
            Every piece of work sent here is done by all{" "}
            {bench.memberIds.length === 0 ? "" : `${String(bench.memberIds.length)} `}
            of them, so it costs that many times — and you compare the answers.
          </p>
          <Field label="Judge">
            <select
              className={inputClass}
              value={bench.judgeId ?? ""}
              onChange={(event) => {
                onChange({
                  ...bench,
                  judgeId: event.target.value === "" ? null : (event.target.value as EmployeeId),
                });
              }}
            >
              <option value="">Nobody — I decide</option>
              {/* The whole office minus this bench's own people: an entrant
                  marking its own entry is the one thing this cannot survive. */}
              {everyone
                .filter((one) => !bench.memberIds.includes(one.id))
                .map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

export function Benches({
  benches,
  people,
  everyone,
  newId,
  onChange,
}: {
  readonly benches: readonly Bench[];
  /** The department's own people; the office refuses anybody else. */
  readonly people: readonly Employee[];
  /** Everybody in the office, for choosing a judge from outside the room. */
  readonly everyone: readonly Employee[];
  readonly newId: () => string;
  readonly onChange: (benches: readonly Bench[]) => void;
}): ReactNode {
  const [name, setName] = useState("");

  /** Who is on which other bench, for the tick that cannot be ticked. */
  const homeOf = (exceptId: BenchId): ReadonlyMap<string, string> => {
    const map = new Map<string, string>();
    for (const bench of benches) {
      if (bench.id === exceptId) continue;
      for (const memberId of bench.memberIds) map.set(memberId, bench.name);
    }
    return map;
  };

  return (
    <section
      role="group"
      aria-label="Benches"
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">Benches</p>
      <p className="text-[11px] text-ink-muted">
        A box several people take work from. Put two people on different models in one: either the
        work splits between them in turn, or every one of them does the same job and you compare the
        answers — which is how you find out whose output is better.
      </p>

      {benches.map((bench) => (
        <OneBench
          key={bench.id}
          bench={bench}
          people={people}
          everyone={everyone}
          elsewhere={homeOf(bench.id)}
          onChange={(changed) => {
            onChange(benches.map((one) => (one.id === bench.id ? changed : one)));
          }}
          onRemove={() => {
            onChange(benches.filter((one) => one.id !== bench.id));
          }}
        />
      ))}

      <div className="flex items-end gap-2">
        <Field label="New bench">
          <input
            className={inputClass}
            placeholder="Drafting"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Button
          aria-label="Add bench"
          disabled={name.trim().length === 0}
          onClick={() => {
            onChange([
              ...benches,
              {
                id: newId() as BenchId,
                name: name.trim(),
                memberIds: [],
                strategy: "round_robin",
                judgeId: null,
              },
            ]);
            setName("");
          }}
        >
          Add
        </Button>
      </div>
    </section>
  );
}
