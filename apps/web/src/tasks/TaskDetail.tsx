/**
 * One piece of work, opened.
 *
 * Everything about a task lives somewhere in the office already — its history
 * in the task, what it produced in the trays, what it cost in the usage rows,
 * what it has to achieve on the task or its department — and until now none of
 * it had anywhere to be read. This is that place, and it is the first screen
 * where work can be described again or handed to somebody else.
 *
 * The two actions are deliberately different shapes. Changing what the work is
 * *for* is an edit, and it saves as you make it, like the drawers. Handing it
 * over is a transition: the office decides whether it may happen, so it is
 * pressed once and the answer is what the board shows.
 */
import { useState, type ReactNode } from "react";
import {
  acceptanceCriteriaFor,
  type Department,
  type Document,
  type Employee,
  type EmployeeId,
  type Task,
  type TaskId,
  type UsageRecord,
  type ValidationError,
} from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { readableSpend, readableTime, readableTokens, spendOf, tokensOf } from "../office/spend.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";
import { readableSize } from "../canvas/Tray.js";

/** A status as somebody says it out loud. */
export const SAID: Readonly<Record<string, string>> = {
  backlog: "backlog",
  assigned: "assigned",
  in_progress: "in progress",
  in_review: "in review",
  changes_requested: "changes requested",
  approved: "approved",
  done: "done",
  blocked: "blocked",
  escalated: "escalated",
  transferred: "handed on",
  cancelled: "cancelled",
};

const WHEN = (date: Date): string => date.toISOString().slice(0, 16).replace("T", " ");

function History({
  task,
  people,
}: {
  readonly task: Task;
  readonly people: readonly Employee[];
}): ReactNode {
  const named = (id: string | null): string =>
    id === null ? "the office" : (people.find((one) => one.id === id)?.name ?? id);

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium text-ink">History</h3>
      {task.history.length === 0 ? (
        <p className="text-[11px] text-ink-muted">Nothing has happened to it yet.</p>
      ) : (
        <ul aria-label="History" className="flex flex-col gap-0.5">
          {task.history.map((event, index) => (
            <li
              key={`${String(index)}:${event.to}`}
              className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-ink"
            >
              <span className="font-medium">{SAID[event.to] ?? event.to}</span>
              <span className="text-ink-muted">{named(event.actorId)}</span>
              <span className="text-ink-muted tabular-nums">{WHEN(event.at)}</span>
              {event.reason !== null && (
                <span className="w-full text-ink-muted">{event.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Produced({
  task,
  documents,
}: {
  readonly task: Task;
  readonly documents: readonly Document[];
}): ReactNode {
  const produced = documents.filter(
    (document) =>
      document.ownerKind === "task" && document.ownerId === task.id && document.tray === "out",
  );
  if (produced.length === 0 && task.artifacts.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium text-ink">What it produced</h3>
      <ul className="flex flex-col gap-0.5">
        {produced.map((document) => (
          <li key={document.id} className="flex items-baseline gap-2 text-[11px] text-ink">
            <span className="min-w-0 truncate">{document.name}</span>
            <span className="ml-auto shrink-0 text-ink-muted">{readableSize(document.size)}</span>
          </li>
        ))}
        {task.artifacts.map((artifact) => (
          <li key={artifact} className="text-[11px] text-ink-muted">
            {artifact}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cost({ task, usage }: { readonly task: Task; readonly usage: readonly UsageRecord[] }) {
  const mine = usage.filter((row) => row.taskId === task.id);
  const spend = spendOf(mine);
  const tokens = readableTokens(tokensOf(mine));

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium text-ink">What it cost</h3>
      <p className="text-[11px] text-ink-muted">
        {readableSpend(spend)}
        {spend.calls === 0 ? "" : ` · ${readableTime(spend.ms)}`}
        {tokens === "" ? "" : ` · ${tokens}`}
      </p>
    </section>
  );
}

/**
 * What would make this work acceptable.
 *
 * The department's standing list is shown when the task states none of its own,
 * named as the department's — because a reviewer answers one list, and seeing
 * where it came from is how somebody knows whether to change it here or there.
 */
function Criteria({
  store,
  task,
  department,
  onProblem,
}: {
  readonly store: OfficeStore;
  readonly task: Task;
  readonly department: Department | undefined;
  readonly onProblem: (problems: readonly ValidationError[]) => void;
}): ReactNode {
  const [another, setAnother] = useState("");
  const standing = department?.definitionOfDone ?? [];
  const own = task.acceptanceCriteria;
  const shown = acceptanceCriteriaFor(own, standing);
  const inherited = own.length === 0 && standing.length > 0;

  const save = (criteria: readonly string[]): void => {
    void store
      .getState()
      .saveTask(task.id, { acceptanceCriteria: criteria })
      .then((outcome) => {
        onProblem(outcome.ok ? [] : outcome.problems);
      });
  };

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium text-ink">What it has to achieve</h3>
      {shown.length === 0 ? (
        <p className="text-[11px] text-ink-muted">Nothing stated, so a reviewer decides.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {shown.map((criterion) => (
            <li key={criterion} className="flex items-baseline gap-2 text-[11px] text-ink">
              <span className="min-w-0">{criterion}</span>
              {!inherited && (
                <button
                  type="button"
                  aria-label={`Remove ${criterion}`}
                  className="ml-auto shrink-0 text-ink-muted hover:text-ink"
                  onClick={() => {
                    save(own.filter((candidate) => candidate !== criterion));
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {inherited && (
        <p className="text-[10px] text-ink-muted">
          {department?.name ?? "the department"}&apos;s standing list. Adding one here states this
          work&apos;s own.
        </p>
      )}

      <div className="flex items-end gap-2">
        <Field label="Another one">
          <input
            className={inputClass}
            placeholder="the order number is right"
            value={another}
            onChange={(event) => {
              setAnother(event.target.value);
            }}
          />
        </Field>
        <Button
          disabled={another.trim().length === 0}
          onClick={() => {
            save([...shown, another.trim()]);
            setAnother("");
          }}
        >
          Add
        </Button>
      </div>
    </section>
  );
}

/** Finished work is not handed anywhere, and there is nothing to offer for it. */
const CAN_BE_HANDED_ON: readonly string[] = [
  "backlog",
  "assigned",
  "in_progress",
  "blocked",
  "escalated",
  "changes_requested",
];

function HandOver({
  store,
  task,
  people,
  onProblem,
}: {
  readonly store: OfficeStore;
  readonly task: Task;
  readonly people: readonly Employee[];
  readonly onProblem: (problems: readonly ValidationError[]) => void;
}): ReactNode {
  const [to, setTo] = useState("");
  const [why, setWhy] = useState("");
  const [handing, setHanding] = useState(false);
  const others = people.filter((person) => person.id !== task.assigneeId);

  if (!CAN_BE_HANDED_ON.includes(task.status) || others.length === 0) return null;

  return (
    <section className="flex flex-col gap-1.5 border-t border-border pt-2">
      <h3 className="text-[11px] font-medium text-ink">Hand it over</h3>
      <div className="flex items-end gap-2">
        <Field label="Hand it to">
          <select
            className={inputClass}
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
            }}
          >
            <option value="">somebody…</option>
            {others.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Why (optional)">
          <input
            className={inputClass}
            value={why}
            onChange={(event) => {
              setWhy(event.target.value);
            }}
          />
        </Field>
        <Button
          disabled={to === "" || handing}
          onClick={() => {
            setHanding(true);
            void store
              .getState()
              .reassignTask(task.id, to as EmployeeId, why)
              .then((outcome) => {
                setHanding(false);
                onProblem(outcome.ok ? [] : outcome.problems);
                if (outcome.ok) {
                  setTo("");
                  setWhy("");
                }
              });
          }}
        >
          Hand it over
        </Button>
      </div>
    </section>
  );
}

export function TaskDetail({
  store,
  taskId,
  onClose,
}: {
  readonly store: OfficeStore;
  readonly taskId: TaskId;
  readonly onClose: () => void;
}): ReactNode {
  const task = store((state) => state.tasks.find((candidate) => candidate.id === taskId));
  const people = store((state) => state.employees);
  const departments = store((state) => state.departments);
  const documents = store((state) => state.documents);
  const usage = store((state) => state.usage);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);

  // Gone while it was open — handed on to a department this canvas cannot see,
  // or cancelled by somebody else. Closing is the honest thing.
  if (task === undefined) return null;

  const department = departments.find((candidate) => candidate.id === task.departmentId);
  const holder = people.find((person) => person.id === task.assigneeId);

  return (
    <aside
      aria-label={`What this work is: ${task.title}`}
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-surface p-3"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium text-ink">{task.title}</span>
          <span className="text-[11px] text-ink-muted">
            {SAID[task.status] ?? task.status} · {holder?.name ?? "nobody"} ·{" "}
            {department?.name ?? task.departmentId}
          </span>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="ml-auto shrink-0 text-ink-muted hover:text-ink"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {task.brief !== "" && <p className="text-[11px] text-ink-muted">{task.brief}</p>}

      <Criteria store={store} task={task} department={department} onProblem={setProblems} />
      <Cost task={task} usage={usage} />
      <Produced task={task} documents={documents} />
      <History task={task} people={people} />
      <HandOver store={store} task={task} people={people} onProblem={setProblems} />

      <Problems problems={problems} />
    </aside>
  );
}
