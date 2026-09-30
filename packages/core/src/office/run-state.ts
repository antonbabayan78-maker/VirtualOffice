/**
 * Whether a level of the office is working at all, as against when it works.
 *
 * Beside `schedule.ts` and shared the same way: an office and a department each
 * carry one, and the scheduler asks both the same question. Hours say *when*
 * work may happen; this says whether anybody wants it to happen at all, which
 * is the switch you reach for when you do not want to edit the hours — and,
 * unlike narrowing them, it leaves nothing to remember to undo.
 *
 * Setting one is idempotent, deliberately unlike `transitionEmployee`, which
 * refuses a no-op. Employment is a lifecycle with a final state, where "already
 * paused" means the caller's model of the world is stale and worth saying so.
 * This is a switch with two positions and no final one: two people pressing
 * Pause must not make the second of them an error.
 */
import { isOpen, type Schedule } from "./schedule.js";

export const RUN_STATES = ["running", "paused"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Something that can be stopped and started, and keeps hours while running. */
export interface Runnable {
  readonly runState: RunState;
  readonly schedule: Schedule;
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function setRunState<T extends { readonly runState: RunState }>(entity: T, to: RunState): T {
  return { ...entity, runState: to };
}

/**
 * Why this is not working right now, or null when it is.
 *
 * Not a boolean, because the only caller has to tell the two apart: "we are
 * shut until Monday" and "somebody stopped this" are different facts, and
 * waiting will only fix one of them. Paused wins when both are true, for the
 * same reason — the hours reopening would not restart it.
 */
export function whyShut(entity: Runnable, at: Date): "paused" | "closed" | null {
  if (entity.runState === "paused") return "paused";
  return isOpen(entity.schedule, at) ? null : "closed";
}
