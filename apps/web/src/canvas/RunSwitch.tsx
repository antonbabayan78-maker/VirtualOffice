/**
 * The switch that stops work, and starts it again.
 *
 * One component for an office, a room and a person, because it is one control:
 * three switches that behaved differently would be three things to learn, and
 * the only real difference is how much stops.
 *
 * Pressed, not drafted. Every other field on these drawers is edited into a
 * draft and committed by Save, and this deliberately is not: a stop switch that
 * waits for a Save button somewhere else reads as a switch that did not work,
 * and stopping work is the thing you most want to be instant. It also means
 * Cancel cannot quietly restart something, or un-pause somebody.
 *
 * It says *stopped*, not *idle*: an unticked box reads as a setting nobody
 * turned on, and the whole failure this exists to prevent is work that is not
 * happening looking exactly like work there is none of.
 */
import type { ReactNode } from "react";

export type RunSwitchSubject = "office" | "department" | "person";

/**
 * "Picks up work", not "is working". The switch governs whether work is taken
 * on; the hours still gate when. A control that said "working" would be making
 * a promise it has no way to keep, and the group label follows the same rule.
 */
const LABEL: Readonly<Record<RunSwitchSubject, string>> = {
  office: "Whether this office picks up work",
  department: "Whether this department picks up work",
  person: "Whether this person picks up work",
};

const SWITCH_TEXT = "Picking up work";

/**
 * What stopping actually stops. Deliberately different per subject: "nothing
 * here gets picked up" is true of a person and badly wrong about an office.
 */
const NOTE: Readonly<Record<RunSwitchSubject, string>> = {
  office:
    "Switch this off and nobody in the office picks anything up, whatever their hours say. Work already under way finishes its turn.",
  department:
    "Switch this off and nobody in this department picks anything up. The rest of the office carries on.",
  person:
    "Switch this off and they pick nothing up. Their open work stays on their desk, waiting for them.",
};

const STOPPED: Readonly<Record<RunSwitchSubject, string>> = {
  office: "Stopped. Nothing in this office is being picked up.",
  department: "Stopped. Nothing in this department is being picked up.",
  person: "Paused. Their work is waiting for them.",
};

export function RunSwitch({
  what,
  running,
  onChange,
}: {
  readonly what: RunSwitchSubject;
  readonly running: boolean;
  readonly onChange: (running: boolean) => void;
}): ReactNode {
  return (
    <section
      role="group"
      aria-label={LABEL[what]}
      className="flex flex-col gap-1 rounded-panel border border-border p-2"
    >
      <label className="flex items-center gap-2 text-xs font-medium text-ink">
        <input
          type="checkbox"
          className="accent-accent"
          checked={running}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {SWITCH_TEXT}
      </label>

      {/* Said in words, not left to an unticked box. Hours are not mentioned
          when it is on: this control does not know them, and "working now"
          would be a promise it cannot keep. */}
      <p className="text-[11px] text-ink-muted">{running ? NOTE[what] : STOPPED[what]}</p>
    </section>
  );
}
