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
import type { Bench, BenchId, Employee, EmployeeId } from "@vo/core";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

function OneBench({
  bench,
  people,
  elsewhere,
  onChange,
  onRemove,
}: {
  readonly bench: Bench;
  readonly people: readonly Employee[];
  /** Who is on another bench here, and which one, so it can be said. */
  readonly elsewhere: ReadonlyMap<string, string>;
  readonly onChange: (bench: Bench) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const toggle = (id: EmployeeId, on: boolean): void => {
    onChange({
      ...bench,
      memberIds: on
        ? [...bench.memberIds, id]
        : bench.memberIds.filter((candidate) => candidate !== id),
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
    </div>
  );
}

export function Benches({
  benches,
  people,
  newId,
  onChange,
}: {
  readonly benches: readonly Bench[];
  /** The department's own people; the office refuses anybody else. */
  readonly people: readonly Employee[];
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
        A box several people take work from in turn. Put two people on different models in one, and
        the work splits between them — which is how you find out whose output is better.
      </p>

      {benches.map((bench) => (
        <OneBench
          key={bench.id}
          bench={bench}
          people={people}
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
