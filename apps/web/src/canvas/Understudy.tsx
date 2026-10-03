/**
 * Who this employee stands in for, and how that person writes.
 *
 * A voice is personal, and an office that writes in somebody's name can be
 * wrong in a way that costs them. So this panel is as much a record as a
 * setting: who they stand in for, who recorded it and when, all said plainly
 * rather than buried.
 *
 * **What the office keeps is a card, not a copy.** The samples are documents in
 * this person's in-tray, where somebody deliberately put them — that act is the
 * consent — and they are read once. Every prompt afterwards carries the page
 * the office wrote, never the writing itself.
 *
 * The name and the switch belong to the drawer's draft and go in with its one
 * Save. **Study the samples** does not: it is a question put to the office,
 * which answers with the card, and a button that waited for a Save somewhere
 * else would read as a button that did nothing.
 */
import { useState, type ReactNode } from "react";
import type { Employee, Understudy as Standing } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";

/** The draft half: what the owner may type and tick. */
export interface VoiceDraft {
  readonly person: string;
  readonly enabled: boolean;
  readonly card: string;
}

export function voiceDraftOf(employee: Employee): VoiceDraft {
  const standing = employee.understudy;
  return {
    person: standing?.person ?? "",
    enabled: standing?.enabled ?? true,
    card: standing?.card ?? "",
  };
}

/**
 * What the drawer sends for this half of the panel.
 *
 * An empty name stops them standing in for anybody, which takes the card with
 * it — there is no half-state where the office holds a voice for nobody.
 */
export function voiceChangeOf(draft: VoiceDraft, employee: Employee): Record<string, unknown> {
  if (draft.person.trim().length === 0) return { understudy: null };
  const standing = employee.understudy;
  return {
    understudy: {
      person: draft.person.trim(),
      // Sent back as the office recorded it; the office stamps who said so from
      // whoever is calling, so this is only what it already holds.
      recordedBy: standing?.recordedBy ?? "",
      enabled: draft.enabled,
      card: draft.card.trim().length === 0 ? null : draft.card,
      cardMadeAt: standing?.cardMadeAt ?? null,
      cardFromSamples: standing?.cardFromSamples ?? 0,
    },
  };
}

const readableDate = (at: Date): string =>
  at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function Recorded({ standing }: { readonly standing: Standing }): ReactNode {
  return (
    <p className="text-[10px] text-ink-muted">
      Recorded by <span className="text-ink">{standing.recordedBy}</span> on{" "}
      {readableDate(standing.recordedAt)}
      {standing.card !== null &&
        standing.cardMadeAt !== null &&
        `. Studied from ${String(standing.cardFromSamples)} samples on ${readableDate(standing.cardMadeAt)}.`}
    </p>
  );
}

export function Understudy({
  store,
  employee,
  draft,
  onChange,
}: {
  readonly store: OfficeStore;
  readonly employee: Employee;
  readonly draft: VoiceDraft;
  readonly onChange: (changes: Partial<VoiceDraft>) => void;
}): ReactNode {
  const [problems, setProblems] = useState<
    readonly { readonly path: string; readonly message: string }[]
  >([]);
  const [studying, setStudying] = useState(false);
  const standing = employee.understudy;

  const study = (): void => {
    setStudying(true);
    void store
      .getState()
      .studyVoice(employee.id)
      .then((result) => {
        setStudying(false);
        setProblems(result.ok ? [] : result.problems);
        // What the office wrote is now what the panel is editing; anything
        // typed into the card before pressing this was a guess at it.
        if (result.ok) {
          const studied = store.getState().employees.find((one) => one.id === employee.id);
          onChange({ card: studied?.understudy?.card ?? "" });
        }
      });
  };

  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border p-2">
      <p className="text-xs font-medium text-ink">Standing in for somebody</p>

      <Field label="Stands in for">
        <input
          className={inputClass}
          placeholder="Anna Petrova"
          value={draft.person}
          onChange={(event) => {
            onChange({ person: event.target.value });
          }}
        />
      </Field>

      {standing !== null && <Recorded standing={standing} />}

      {draft.person.trim().length === 0 ? (
        <p className="text-[10px] text-ink-muted">
          For a person supporting a real colleague. Name them here, put some of their writing in the
          in-tray below, and the office will learn how they write.
        </p>
      ) : (
        <>
          <label className="flex items-center gap-1.5 text-[10px] text-ink-muted">
            <input
              type="checkbox"
              className="accent-accent"
              aria-label="Write in their voice"
              checked={draft.enabled}
              onChange={(event) => {
                onChange({ enabled: event.target.checked });
              }}
            />
            Write in their voice
          </label>

          <Field label="How they write">
            <textarea
              className={`${inputClass} min-h-24 resize-y`}
              placeholder="Press Study the samples, or write it yourself."
              value={draft.card}
              onChange={(event) => {
                onChange({ card: event.target.value });
              }}
            />
          </Field>

          <div className="flex items-center gap-2">
            <Button aria-label="Study the samples" disabled={studying} onClick={study}>
              {studying ? "Reading…" : "Study the samples"}
            </Button>
            <span className="text-[10px] text-ink-muted">
              Reads the writing in their in-tray below.
            </span>
          </div>

          <p className="text-[10px] text-ink-muted">
            The office keeps only the card above — the writing itself stays in the tray and is never
            sent again. Work done in their voice says so wherever it appears, and anything this
            person does through an outside system waits for you first.
          </p>
        </>
      )}

      <Problems problems={problems} />
    </section>
  );
}
