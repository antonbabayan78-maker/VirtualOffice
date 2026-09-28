/**
 * An employee on the canvas.
 *
 * The head carries what the person is doing right now: green at work, orange
 * waiting on something, red when it has gone wrong, and the office's own ink
 * when there is nothing to report. The three that matter fade in and out, so a
 * busy office is legible from across the room and a still figure means a still
 * employee.
 *
 * Idle is ink rather than a literal black: in daylight the ink token is very
 * nearly black, and on a dark canvas a black figure would be invisible.
 */
import type { ReactNode } from "react";
import { cn } from "../ui/cn.js";
import {
  EMPLOYEE_BODY_PATH,
  EMPLOYEE_HEAD_PATH,
  EMPLOYEE_VIEW_BOX,
} from "./employee-silhouette.js";

export const ACTIVITY_STATES = ["working", "waiting", "error", "idle"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

const HEAD_COLOR: Record<ActivityState, string> = {
  working: "var(--color-working)",
  waiting: "var(--color-waiting)",
  error: "var(--color-error)",
  idle: "var(--color-ink)",
};

const DESCRIPTION: Record<ActivityState, string> = {
  working: "working",
  waiting: "waiting",
  error: "error",
  idle: "idle",
};

export interface EmployeeAvatarProps {
  readonly name: string;
  readonly state: ActivityState;
  /** Height in pixels; the figure keeps its proportions. */
  readonly size?: number;
  readonly className?: string;
}

export function EmployeeAvatar({
  name,
  state,
  size = 40,
  className,
}: EmployeeAvatarProps): ReactNode {
  const animated = state !== "idle";
  return (
    <svg
      viewBox={EMPLOYEE_VIEW_BOX}
      height={size}
      role="img"
      aria-label={`${name}: ${DESCRIPTION[state]}`}
      className={cn("overflow-visible", className)}
    >
      <path d={EMPLOYEE_BODY_PATH} data-part="body" fill="var(--color-ink)" />
      <path
        d={EMPLOYEE_HEAD_PATH}
        data-part="head"
        data-animated={animated ? "true" : "false"}
        fill={HEAD_COLOR[state]}
        className={animated ? "vo-pulse" : undefined}
      />
    </svg>
  );
}
