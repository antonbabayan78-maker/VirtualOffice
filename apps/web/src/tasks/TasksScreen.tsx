/**
 * What every department is working on, and how far along it is.
 *
 * The lanes are the task's own: backlog, assigned, in progress, in review,
 * approved, done. Not a board you drag things across — a status is the result
 * of something the office did, and the transitions that exist have their own
 * buttons elsewhere. This is the view, and the one place a piece of work can be
 * opened and read.
 *
 * **Blocked and escalated are not lanes.** They are not stages of anything;
 * they are the stage the work was at with something wrong, so the card stays
 * where the work is and says so. Putting them in columns of their own would
 * make a piece of work look finished with it when it is not, and the approvals
 * inbox is where they are answered.
 *
 * **Cancelled work is not shown at all.** It stopped existing; a lane of it is
 * a lane nobody reads.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { Task, TaskId, TaskStatus } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Field, inputClass } from "../ui/field.js";
import { voiceOf } from "../office/voice.js";
import { SAID, TaskDetail } from "./TaskDetail.js";

/** The lanes, in the order work moves along them. */
const LANES: readonly TaskStatus[] = [
  "backlog",
  "assigned",
  "in_progress",
  "in_review",
  "approved",
  "done",
];

/**
 * Which lane a piece of work sits in.
 *
 * Work that stopped sits in the lane it stopped in: blocked and escalated are
 * what happened to it, not where it got to. `changes_requested` is work on its
 * way back to whoever did it, which is in progress as far as a board is
 * concerned.
 */
export function laneOf(status: TaskStatus): TaskStatus | null {
  if (status === "cancelled") return null;
  if (status === "blocked" || status === "escalated" || status === "changes_requested") {
    return "in_progress";
  }
  if (status === "transferred") return "assigned";
  return LANES.includes(status) ? status : null;
}

const LANE_NAME: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  assigned: "Assigned",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
};

function Card({
  store,
  task,
  onOpen,
}: {
  readonly store: OfficeStore;
  readonly task: Task;
  readonly onOpen: () => void;
}): ReactNode {
  const people = store((state) => state.employees);
  const holder = people.find((person) => person.id === task.assigneeId);
  // Said on the card rather than only in the drawer: a piece of work that
  // stopped looks exactly like one in flight otherwise.
  const wrong =
    task.status === "blocked" || task.status === "escalated" || task.status === "changes_requested"
      ? (SAID[task.status] ?? task.status)
      : null;

  return (
    <button
      type="button"
      aria-label={task.title}
      onClick={onOpen}
      className="flex w-full flex-col gap-0.5 rounded-panel border border-border bg-surface p-2 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="truncate text-[11px] text-ink">{task.title}</span>
      <span className="flex items-baseline gap-1.5 text-[10px] text-ink-muted">
        <span className="min-w-0 truncate">
          {holder?.name ?? "nobody"}
          {/* Said on the card as well as in the drawer: an office where you
              cannot tell at a glance is an office nobody can trust. */}
          {voiceOf(holder) !== null && ` as ${voiceOf(holder) ?? ""}`}
        </span>
        {task.priority !== "normal" && (
          <span className="shrink-0 rounded bg-surface-muted px-1">{task.priority}</span>
        )}
        {wrong !== null && <span className="shrink-0 text-ink">{wrong}</span>}
      </span>
    </button>
  );
}

export function TasksScreen({ store }: { readonly store: OfficeStore }): ReactNode {
  const tasks = store((state) => state.tasks);
  const departments = store((state) => state.departments);
  const [room, setRoom] = useState("");
  const [opened, setOpened] = useState<TaskId | null>(null);

  const showing = useMemo(
    () => tasks.filter((task) => (room === "" ? true : task.departmentId === room)),
    [tasks, room],
  );

  const byLane = useMemo(() => {
    const lanes = new Map<TaskStatus, Task[]>(LANES.map((lane) => [lane, []]));
    for (const task of showing) {
      const lane = laneOf(task.status);
      if (lane !== null) lanes.get(lane)?.push(task);
    }
    return lanes;
  }, [showing]);

  const anything = [...byLane.values()].some((lane) => lane.length > 0);

  return (
    <div className="flex h-full min-h-0">
      <section
        role="region"
        aria-label="Tasks"
        className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-6"
      >
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-ink">Tasks</h1>
            <p className="text-sm text-ink-muted">
              What every department is working on, and how far along it is.
            </p>
          </div>
          <div className="ml-auto w-48">
            <Field label="Room">
              <select
                className={inputClass}
                value={room}
                onChange={(event) => {
                  setRoom(event.target.value);
                }}
              >
                <option value="">All rooms</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        {!anything ? (
          <p className="max-w-prose rounded-panel border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
            Nothing is on the go here yet.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
            {LANES.map((lane) => {
              const inLane = byLane.get(lane) ?? [];
              return (
                <section
                  role="group"
                  aria-label={LANE_NAME[lane] ?? lane}
                  key={lane}
                  className="flex w-52 shrink-0 flex-col gap-1.5 rounded-panel border border-border p-2"
                >
                  <h2 className="flex items-baseline gap-2 text-[11px] font-medium text-ink">
                    {LANE_NAME[lane] ?? lane}
                    <span className="ml-auto tabular-nums text-ink-muted">{inLane.length}</span>
                  </h2>
                  {inLane.map((task) => (
                    <Card
                      key={task.id}
                      store={store}
                      task={task}
                      onOpen={() => {
                        setOpened(task.id);
                      }}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </section>

      {opened !== null && (
        <TaskDetail
          store={store}
          taskId={opened}
          onClose={() => {
            setOpened(null);
          }}
        />
      )}
    </div>
  );
}
