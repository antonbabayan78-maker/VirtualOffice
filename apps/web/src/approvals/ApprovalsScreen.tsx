/**
 * What this office is waiting on a person for.
 *
 * Three kinds, and the screen's job is to keep them apart, because they are not
 * the same question. A **call** a run may not make is answered with its own
 * arguments in front of you — approving the tool in advance is the thing the
 * gate exists not to be, so the arguments are shown and the decision names the
 * one call. **Finished work** a department holds is the older kind of gate: it
 * is approved or sent back, and sending it back needs a reason the office
 * insists on. **Stopped work** is not a decision at all; it is here because it
 * is a person's to deal with, and the one thing to do with it from here is
 * start it again.
 *
 * The wording carries the meaning. Refusing a call is not rejecting the work:
 * the run is told and carries on without it, and a screen that said "reject"
 * would be describing something that does not happen.
 *
 * Everything comes from the store, which asked the office: the held calls live
 * in the run checkpoints and a canvas has no business reading those.
 */
import { useState, type ReactNode } from "react";
import type { Waiting } from "@vo/api-client";
import type { TaskId, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { inTheirVoice } from "../office/voice.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";

/** When it started waiting, to the minute: enough to tell this morning from last week. */
function waitingSince(since: Date): string {
  return Number.isNaN(since.getTime()) ? "" : since.toISOString().slice(0, 16).replace("T", " ");
}

/** What a call would do it with, as something a person can read. */
function argumentsOf(input: Readonly<Record<string, unknown>>): readonly [string, string][] {
  return Object.entries(input).map(([name, value]) => [
    name,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

/** A row's heading: enough to tell two pieces of work apart out loud. */
function labelFor(item: Waiting): string {
  if (item.kind === "call") return `${item.name} on "${item.title}"`;
  if (item.kind === "review") return `Finished work: "${item.title}"`;
  return `Stopped: "${item.title}"`;
}

function Who({ store, item }: { readonly store: OfficeStore; readonly item: Waiting }): ReactNode {
  const employees = store((state) => state.employees);
  const departments = store((state) => state.departments);
  // An id rather than nothing for somebody this canvas does not know: a row
  // naming nobody is a row nobody can act on.
  const who =
    item.assigneeId === null
      ? "nobody"
      : (employees.find((employee) => employee.id === item.assigneeId)?.name ?? item.assigneeId);
  const room =
    departments.find((department) => department.id === item.departmentId)?.name ??
    item.departmentId;

  // Whose name this would be done in, where it is not their own. The decision
  // on the desk is not "may this task send an email" but "may it send an email
  // as Anna Petrova", and a row that does not say so asks the wrong question.
  const voice = inTheirVoice(employees.find((employee) => employee.id === item.assigneeId));

  return (
    <span className="flex items-baseline gap-2 text-[11px] text-ink-muted">
      <span className="truncate">
        {who} · {room}
        {voice !== null && <span className="ml-1 text-ink">{voice}</span>}
      </span>
      <span className="ml-auto shrink-0 tabular-nums">{waitingSince(item.since)}</span>
    </span>
  );
}

function Gates({ gates }: { readonly gates: readonly string[] }): ReactNode {
  if (gates.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {gates.map((gate) => (
        <span
          key={gate}
          className="rounded bg-surface-muted px-1 text-[10px] text-ink-muted"
          title="what this involves that the office holds for a person"
        >
          {gate}
        </span>
      ))}
    </span>
  );
}

/**
 * One row, and the decision it carries.
 *
 * The refusal half opens rather than sitting there: a reason box under every
 * row reads as a form to fill in, and most of these are answered with one
 * press.
 */
function Row({ store, item }: { readonly store: OfficeStore; readonly item: Waiting }): ReactNode {
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [deciding, setDeciding] = useState(false);

  const answered = (outcome: { ok: boolean; problems?: readonly ValidationError[] }): void => {
    setDeciding(false);
    setProblems(outcome.ok ? [] : (outcome.problems ?? []));
    if (outcome.ok) {
      setRefusing(false);
      setReason("");
    }
  };

  const decide = (make: () => Promise<{ ok: boolean; problems?: readonly ValidationError[] }>) => {
    setDeciding(true);
    void make().then(answered);
  };

  const taskId = item.taskId as TaskId;

  return (
    <div
      role="group"
      aria-label={labelFor(item)}
      className="flex flex-col gap-1.5 rounded-panel border border-border p-3"
    >
      <span className="truncate text-xs font-medium text-ink">{item.title}</span>
      <Who store={store} item={item} />

      {item.kind === "call" && (
        <>
          <span className="text-xs text-ink">
            wants to call <span className="font-medium">{item.name}</span>
          </span>
          {argumentsOf(item.input).length === 0 ? (
            <span className="text-[11px] text-ink-muted">with nothing</span>
          ) : (
            <ul className="flex flex-col gap-0.5 rounded-panel bg-surface-muted p-2">
              {argumentsOf(item.input).map(([name, value]) => (
                <li key={name} className="flex gap-2 text-[11px] text-ink">
                  <span className="shrink-0 text-ink-muted">{name}</span>
                  <span className="min-w-0 break-words">{value}</span>
                </li>
              ))}
            </ul>
          )}
          <Gates gates={item.gates} />
        </>
      )}

      {item.kind === "review" && (
        <>
          <span className="text-xs text-ink">finished, and waiting for a decision</span>
          <Gates gates={item.gates} />
        </>
      )}

      {item.kind === "stopped" && (
        <span className="text-xs text-ink">
          {item.status === "escalated" ? "escalated to you" : "stopped"}
          {item.reason === null ? "" : `: ${item.reason}`}
        </span>
      )}

      {refusing ? (
        <div className="flex flex-col gap-1.5">
          {item.kind === "call" && (
            <span className="text-[11px] text-ink-muted">
              The run is told, and carries on without it.
            </span>
          )}
          <Field label={item.kind === "call" ? "Why not (optional)" : "Why it is going back"}>
            <input
              className={inputClass}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              disabled={deciding || (item.kind === "review" && reason.trim().length === 0)}
              onClick={() => {
                decide(() =>
                  item.kind === "call"
                    ? store.getState().decideCall(taskId, item.key, "declined", reason)
                    : store.getState().decideGate(taskId, "rejected", reason),
                );
              }}
            >
              {item.kind === "call" ? "Refuse this call" : "Send it back"}
            </Button>
            <Button
              onClick={() => {
                setRefusing(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {item.kind === "call" && (
            <>
              <Button
                disabled={deciding}
                onClick={() => {
                  decide(() => store.getState().decideCall(taskId, item.key, "approved"));
                }}
              >
                Allow
              </Button>
              <Button
                onClick={() => {
                  setRefusing(true);
                }}
              >
                Refuse…
              </Button>
            </>
          )}

          {item.kind === "review" && (
            <>
              <Button
                disabled={deciding}
                onClick={() => {
                  decide(() => store.getState().decideGate(taskId, "approved"));
                }}
              >
                Approve
              </Button>
              <Button
                onClick={() => {
                  setRefusing(true);
                }}
              >
                Send it back…
              </Button>
            </>
          )}

          {item.kind === "stopped" && (
            <Button
              disabled={deciding}
              onClick={() => {
                decide(() => store.getState().putBackToWork(taskId));
              }}
            >
              Put it back to work
            </Button>
          )}
        </div>
      )}

      <Problems problems={problems} />
    </div>
  );
}

/** A key that is this one item, since a task can be waiting on several calls. */
const keyFor = (item: Waiting): string =>
  item.kind === "call" ? `${item.taskId}:${item.key}` : `${item.taskId}:${item.kind}`;

export function ApprovalsScreen({ store }: { readonly store: OfficeStore }): ReactNode {
  const waiting = store((state) => state.waiting);

  return (
    <section
      role="region"
      aria-label="Approvals"
      className="flex h-full flex-col gap-3 overflow-auto p-6"
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">Approvals</h1>
        <p className="max-w-prose text-sm text-ink-muted">
          Work waiting on a decision only a person can make, oldest first.
        </p>
      </div>

      {waiting.length === 0 ? (
        <p className="max-w-prose rounded-panel border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
          Nothing is waiting for you.
        </p>
      ) : (
        <div className="flex max-w-prose flex-col gap-2">
          {waiting.map((item) => (
            <Row key={keyFor(item)} store={store} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
