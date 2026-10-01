/**
 * Which office this browser is looking at.
 *
 * Shown when the answer is not obvious: there are several, or — the case a
 * fresh deployment starts in — there are none, and the first one is made here
 * rather than with a curl somebody has to be told about.
 *
 * The choice is remembered by id, which is not a secret and is the only thing
 * the browser keeps.
 */
import { useState, type ReactNode } from "react";
import type { Office } from "@vo/core";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

export function ChooseOffice({
  offices,
  onOpen,
  onCreate,
  onSignOut,
}: {
  readonly offices: readonly Office[];
  readonly onOpen: (officeId: string) => void;
  /** Answers with what went wrong, or null when it worked. */
  readonly onCreate: (name: string) => Promise<string | null>;
  readonly onSignOut: () => void;
}): ReactNode {
  const [name, setName] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  const create = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (name.trim().length === 0 || making) return;
    setMaking(true);
    void onCreate(name.trim()).then((failure) => {
      setMaking(false);
      setRefused(failure);
      if (failure === null) setName("");
    });
  };

  return (
    <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <section
        aria-label="Choose an office"
        className="flex w-full max-w-sm flex-col gap-3 rounded-panel border border-border bg-surface p-5"
      >
        <h1 className="text-lg font-semibold">
          {offices.length === 0 ? "No office yet" : "Which office?"}
        </h1>

        {offices.length === 0 ? (
          <p className="text-xs text-ink-muted">
            Nothing has been set up here. Make the first one and the canvas opens on it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {offices.map((office) => (
              <li key={office.id}>
                <Button
                  aria-label={`Open ${office.name}`}
                  onClick={() => {
                    onOpen(office.id);
                  }}
                >
                  {office.name}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={create} className="flex items-end gap-2 border-t border-border pt-3">
          <Field label={offices.length === 0 ? "Name it" : "Or make another"}>
            <input
              className={inputClass}
              placeholder="Northwind Studio"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          <Button
            type="submit"
            aria-label="Create office"
            disabled={name.trim().length === 0 || making}
          >
            {making ? "Creating…" : "Create"}
          </Button>
        </form>

        {refused !== null && (
          <p role="alert" className="text-xs text-ink">
            {refused}
          </p>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="self-start text-[11px] text-ink-muted underline hover:text-ink"
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
