/**
 * What somebody's work was handed, and what it produced — as opposed to what is
 * on their desk.
 *
 * A document an agent files, and every document a handoff carries next door,
 * belongs to the task rather than to a person or a room — which is right, since
 * work outlives whoever happened to be holding it. There is no task drawer on
 * the canvas, so without this none of it is visible at all: the trays show only
 * what a person put there by hand.
 *
 * Deliberately not a tray, and it looks different for that reason. A tray is a
 * place you put things; this is a view of what exists, gathered from the tasks
 * the store already holds — so it has no drop zone and no way to remove
 * anything. Taking somebody's work product away should not be a stray click on
 * a panel that is otherwise about their model settings, and there is no single
 * desk it would be taken off in any case.
 *
 * Empty means absent rather than an empty box: a person with nothing to show
 * has nothing to show, and a row of empty containers reads as something broken.
 */
import type { ReactNode } from "react";
import type { Document, DocumentTray, Task } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { offerToSave, readableSize } from "./Tray.js";

export interface WorkOwner {
  readonly kind: "employee" | "department";
  readonly id: string;
}

const HEADING: Readonly<Record<DocumentTray, Readonly<Record<WorkOwner["kind"], string>>>> = {
  in: { employee: "Handed to their work", department: "Handed to this department" },
  out: { employee: "Produced by their work", department: "Produced here" },
};

const NOTE: Readonly<Record<DocumentTray, Readonly<Record<WorkOwner["kind"], string>>>> = {
  in: {
    employee: "Documents another department handed to the tasks assigned to them.",
    department: "Documents another department handed to work here.",
  },
  out: {
    employee: "Documents that came out of the tasks assigned to them.",
    department: "Documents that came out of this department's work.",
  },
};

/** The work this owner answers for. */
function workOf(tasks: readonly Task[], owner: WorkOwner): readonly Task[] {
  return owner.kind === "employee"
    ? tasks.filter((task) => task.assigneeId === owner.id)
    : tasks.filter((task) => task.departmentId === owner.id);
}

export function Produced({
  store,
  owner,
  tray,
}: {
  readonly store: OfficeStore;
  readonly owner: WorkOwner;
  readonly tray: DocumentTray;
}): ReactNode {
  const documents = store((state) => state.documents);
  const tasks = store((state) => state.tasks);

  const mine = workOf(tasks, owner);
  const titles = new Map(mine.map((task) => [task.id as string, task.title]));
  const produced: readonly Document[] = documents.filter(
    (document) =>
      document.ownerKind === "task" && document.tray === tray && titles.has(document.ownerId),
  );

  if (produced.length === 0) return null;

  return (
    <section
      role="group"
      aria-label={HEADING[tray][owner.kind]}
      className="flex flex-col gap-2 rounded-panel border border-border p-2"
    >
      <p className="text-xs font-medium text-ink">{HEADING[tray][owner.kind]}</p>
      <p className="text-[11px] text-ink-muted">{NOTE[tray][owner.kind]}</p>

      <ul className="flex flex-col gap-1">
        {produced.map((document) => (
          <li key={document.id} className="flex flex-col gap-0.5 text-xs text-ink">
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate">{document.name}</span>
              <span className="shrink-0 text-[10px] text-ink-muted">
                {readableSize(document.size)}
              </span>
              <button
                type="button"
                aria-label={`Download ${document.name}`}
                className="ml-auto shrink-0 text-ink-muted hover:text-ink"
                onClick={() => {
                  void store
                    .getState()
                    .fetchBody(document.id)
                    .then((body) => {
                      if (body !== null) offerToSave(document.name, body);
                    });
                }}
              >
                ↓
              </button>
            </span>
            {/* Which piece of work it came out of: a document with nothing
                attached to it is an orphan on a settings panel. */}
            <span className="text-[10px] text-ink-muted">{titles.get(document.ownerId)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
