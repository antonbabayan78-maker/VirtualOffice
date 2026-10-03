/**
 * What the office has told this person, on their own panel.
 *
 * Two things an owner writes in their own words: how this person works, and a
 * few pieces of work that were good. Both are carried in every prompt this
 * person's model is sent, which is why the examples are few and short.
 *
 * **It says where this stops.** Instructions are how one person works; a skill
 * is a procedure with steps, shared between people; a memory is what somebody
 * has learned for themselves. Without that line on the panel, every skill in
 * the office ends up pasted into somebody's instructions, and nobody can say
 * afterwards why a reply came out the way it did.
 *
 * Edited in the drawer's draft and written by the one Save, like the rest of
 * this panel — a half-typed paragraph is not an instruction yet.
 */
import { useState, type ReactNode } from "react";
import type { WorkExample } from "@vo/core";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

export interface TeachingChange {
  readonly instructions?: string;
  readonly examples?: readonly WorkExample[];
}

export function Teaching({
  instructions,
  examples,
  onChange,
}: {
  readonly instructions: string;
  readonly examples: readonly WorkExample[];
  readonly onChange: (changes: TeachingChange) => void;
}): ReactNode {
  const [when, setWhen] = useState("");
  const [good, setGood] = useState("");

  const add = (): void => {
    const said = when.trim();
    onChange({
      examples: [...examples, { when: said.length === 0 ? null : said, good: good.trim() }],
    });
    setWhen("");
    setGood("");
  };

  return (
    <section className="flex flex-col gap-2 rounded-panel border border-border p-2">
      <p className="text-xs font-medium text-ink">What they have been told</p>

      <Field label="How they work">
        <textarea
          className={`${inputClass} min-h-24 resize-y`}
          placeholder={
            "Always check the order number against the shipping system before replying.\n" +
            "Never promise a date we have not confirmed."
          }
          value={instructions}
          onChange={(event) => {
            onChange({ instructions: event.target.value });
          }}
        />
      </Field>

      <p className="text-[10px] text-ink-muted">
        Standing instructions: how this person works, every time. A skill is a procedure with steps,
        shared between people; what they have learned for themselves is their memory. Neither
        belongs here.
      </p>

      {examples.length > 0 && (
        <ul className="flex flex-col gap-1">
          {examples.map((example, index) => (
            <li
              key={`${example.when ?? ""}:${example.good}`}
              className="flex items-start gap-1.5 rounded border border-border p-1.5 text-[10px] text-ink"
            >
              <span className="min-w-0 flex-1">
                {example.when !== null && (
                  <span className="mr-1 rounded bg-surface-muted px-1 text-ink-muted">
                    {example.when}
                  </span>
                )}
                <span className="whitespace-pre-wrap">{example.good}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove example ${String(index + 1)}`}
                className="shrink-0 text-ink-muted hover:text-ink"
                onClick={() => {
                  onChange({ examples: examples.filter((_, at) => at !== index) });
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <Field label="When">
        <input
          className={inputClass}
          placeholder="an angry customer"
          value={when}
          onChange={(event) => {
            setWhen(event.target.value);
          }}
        />
      </Field>

      <Field label="What good looks like">
        <textarea
          className={`${inputClass} min-h-16 resize-y`}
          placeholder="Thank you for flagging this. I have checked the order and…"
          value={good}
          onChange={(event) => {
            setGood(event.target.value);
          }}
        />
      </Field>

      <Button aria-label="Add example" disabled={good.trim().length === 0} onClick={add}>
        Add example
      </Button>

      <p className="text-[10px] text-ink-muted">
        Examples are work somebody judged good, kept to show the manner of it. Every one is carried
        in every call this person makes, so a few short ones beat a long list.
      </p>
    </section>
  );
}
