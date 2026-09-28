/**
 * What the colours mean. Small, but the canvas is unreadable without it: a
 * pulsing orange head means nothing until someone tells you it means waiting.
 */
import type { ReactNode } from "react";
import { ACTIVITY_STATES, EmployeeAvatar } from "./EmployeeAvatar.js";

const MEANING: Record<(typeof ACTIVITY_STATES)[number], string> = {
  working: "Working",
  waiting: "Waiting",
  error: "Error",
  idle: "Idle",
};

export function ActivityLegend(): ReactNode {
  return (
    <ul aria-label="What the colours mean" className="flex items-center gap-3">
      {ACTIVITY_STATES.map((state) => (
        <li key={state} className="flex items-center gap-1.5 text-xs text-ink-muted">
          <EmployeeAvatar name={MEANING[state]} state={state} size={16} />
          {MEANING[state]}
        </li>
      ))}
    </ul>
  );
}
