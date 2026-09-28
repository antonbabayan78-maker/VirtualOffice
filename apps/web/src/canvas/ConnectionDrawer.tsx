/**
 * Configuring one of the arrows between departments.
 *
 * An arrow is a relationship the office actually acts on — work handed forward,
 * trouble routed upward, one department watching another — so it needs somewhere
 * to be read and switched off, and until now there was nowhere at all: the
 * canvas drew arrows and nothing more.
 *
 * Which departments an arrow joins, and what kind of relationship it is, are not
 * editable here. That is a different arrow, and anything already referring to
 * this one — work raised along it, a route recorded through it — would be
 * describing something that never happened.
 */
import { useEffect, useState, type ReactNode } from "react";
import { WATCHABLE_MOMENTS, type ValidationError, type WatchableMoment } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";
import { LINK_LABELS } from "../office/links.js";

/** What the moments are called to somebody reading the canvas. */
const MOMENT_LABELS: Readonly<Record<WatchableMoment, string>> = {
  work_started: "work started",
  work_finished: "work finished",
  work_went_wrong: "work went wrong",
  decision_wanted: "a person was asked to decide",
};

export function ConnectionDrawer({ store }: { readonly store: OfficeStore }): ReactNode {
  const selectedId = store((state) => state.selectedConnectionId);
  const connections = store((state) => state.connections);
  const departments = store((state) => state.departments);
  const connection = connections.find((candidate) => candidate.id === selectedId);

  const [enabled, setEnabled] = useState(true);
  const [moments, setMoments] = useState<readonly string[]>([]);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  useEffect(() => {
    if (connection === undefined) return;
    setEnabled(connection.enabled);
    const asked = connection.rules["for"];
    setMoments(Array.isArray(asked) ? (asked as string[]) : []);
    setProblems([]);
  }, [connection]);

  if (connection === undefined) return null;

  const name = (id: string): string =>
    departments.find((department) => department.id === id)?.name ?? id;
  const close = (): void => {
    store.getState().selectConnection(null);
  };

  const save = (): void => {
    void store
      .getState()
      .saveConnection(connection.id, {
        enabled,
        ...(connection.kind === "watches" ? { rules: { ...connection.rules, for: moments } } : {}),
      })
      .then((result) => {
        if (result.ok) {
          close();
          return;
        }
        setProblems(result.problems);
      });
  };

  return (
    <aside
      role="dialog"
      aria-label={`Configure the arrow from ${name(connection.fromId)}`}
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4"
    >
      <header>
        <h2 className="text-sm font-semibold text-ink">
          {name(connection.fromId)} → {name(connection.toId)}
        </h2>
        <p className="text-xs text-ink-muted">{LINK_LABELS[connection.kind]}</p>
      </header>

      <Problems problems={problems} />

      <label className="flex items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          className="accent-accent"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        In force
      </label>
      <p className="-mt-1 text-[11px] text-ink-muted">
        An arrow switched off is an arrow the office does not act on. It stays drawn, and keeps its
        identity, so anything already referring to it still makes sense.
      </p>

      {connection.kind === "watches" && (
        <Field label="Watching for">
          <div className="flex flex-col gap-1">
            {WATCHABLE_MOMENTS.map((moment) => (
              <label key={moment} className="flex items-center gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={moments.includes(moment)}
                  onChange={(event) => {
                    setMoments((current) =>
                      event.target.checked
                        ? [...current, moment]
                        : current.filter((candidate) => candidate !== moment),
                    );
                  }}
                />
                {MOMENT_LABELS[moment]}
              </label>
            ))}
          </div>
        </Field>
      )}

      <div className={`mt-auto flex gap-2 pt-2 ${inputClass.length === 0 ? "" : ""}`}>
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </aside>
  );
}
