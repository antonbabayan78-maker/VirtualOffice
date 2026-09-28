/**
 * Picking a standing priority.
 *
 * The same control wherever a level sets one — an office, a department, a
 * person — so the four words mean the same thing in all three places, and the
 * note underneath says what setting it actually costs somebody else.
 */
import type { ReactNode } from "react";
import { TASK_PRIORITIES, type TaskPriority } from "@vo/core";
import { Field } from "../ui/field.js";

export function PriorityField({
  value,
  onChange,
  note,
  className,
}: {
  readonly value: TaskPriority;
  readonly onChange: (priority: TaskPriority) => void;
  /** What raising it does to everything below, in this particular place. */
  readonly note: string;
  readonly className: string;
}): ReactNode {
  return (
    <>
      <Field label="Priority">
        <select
          className={className}
          value={value}
          onChange={(event) => {
            onChange(event.target.value as TaskPriority);
          }}
        >
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </Field>
      <p className="-mt-1 text-xs text-ink-muted">{note}</p>
    </>
  );
}
