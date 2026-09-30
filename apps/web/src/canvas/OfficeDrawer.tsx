/**
 * Configuring the office itself.
 *
 * The office had no panel at all until it had something worth setting: a
 * standing priority that outranks every department. It follows the same shape
 * as the department and employee drawers — a draft edited locally, saved as a
 * whole, and problems shown rather than swallowed — because three settings
 * panels that behave differently is three things to learn.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { TaskPriority, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";
import { Connectors } from "./Connectors.js";
import { PriorityField } from "./PriorityField.js";

interface Draft {
  readonly name: string;
  readonly priority: TaskPriority;
}

export function OfficeDrawer({ store }: { readonly store: OfficeStore }): ReactNode {
  const office = store((state) => state.office);
  const isOpen = store((state) => state.officeOpen);
  const [draft, setDraft] = useState<Draft>({ name: "", priority: "normal" });
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  useEffect(() => {
    if (office === null) return;
    setDraft({ name: office.name, priority: office.priority });
    setProblems([]);
  }, [office]);

  if (!isOpen || office === null) return null;

  const edit = (changes: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const close = (): void => {
    store.getState().openOffice(false);
  };

  const save = (): void => {
    void store
      .getState()
      .saveOffice({ name: draft.name, priority: draft.priority })
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
      aria-label={`Configure ${office.name}`}
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4"
    >
      <header>
        <h2 className="text-sm font-semibold text-ink">{office.name}</h2>
        <p className="text-xs text-ink-muted">The whole office</p>
      </header>

      <Problems problems={problems} />

      <Field label="Name">
        <input
          className={inputClass}
          value={draft.name}
          onChange={(event) => {
            edit({ name: event.target.value });
          }}
        />
      </Field>

      <PriorityField
        value={draft.priority}
        onChange={(priority) => {
          edit({ priority });
        }}
        note="The organisation's own standing. It outranks every department, so nothing set below can overturn it."
        className={inputClass}
      />

      {/* Its own saves, not part of this drawer's draft: a connector is an
          entity of the office rather than a field of it. */}
      <Connectors store={store} />

      <div className="mt-auto flex gap-2 pt-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </aside>
  );
}
