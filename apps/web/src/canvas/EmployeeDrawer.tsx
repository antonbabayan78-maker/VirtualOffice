/**
 * Configuring one employee.
 *
 * The drawer edits a draft and saves it in one go, so a half-typed name is not
 * a validation failure and an abandoned edit changes nothing. Saving goes
 * through the same core rules the office file and the API obey, and whatever
 * core refuses is shown rather than swallowed.
 *
 * Its choices are derived, never typed out: models come from the registry,
 * supervisors from the office. A hand-written list would offer things the
 * system then rejects on save.
 */
import { useEffect, useState, type ReactNode } from "react";
import type {
  Budget,
  Employee,
  TaskPriority,
  ToolGrant,
  ValidationError,
  WorkExample,
} from "@vo/core";
import { availableModels, supervisorChoices } from "../office/employee-edit.js";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";
import { Grants } from "./Grants.js";
import { PriorityField } from "./PriorityField.js";
import { BudgetField } from "./BudgetField.js";
import { Produced } from "./Produced.js";
import { RunSwitch } from "./RunSwitch.js";
import { Teaching } from "./Teaching.js";
import { SelfImprovement } from "./SelfImprovement.js";
import { Understudy, voiceChangeOf, voiceDraftOf, type VoiceDraft } from "./Understudy.js";
import { Tray } from "./Tray.js";

interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

/** One window is enough for the common case; several is a later refinement. */
interface HoursDraft {
  readonly own: boolean;
  readonly timezone: string;
  readonly days: readonly string[];
  readonly start: string;
  readonly end: string;
}

interface Draft {
  readonly name: string;
  readonly role: string;
  readonly color: string;
  readonly avatar: string;
  readonly model: ModelRef;
  readonly fallbacks: readonly ModelRef[];
  readonly skills: string;
  readonly instructions: string;
  readonly examples: readonly WorkExample[];
  readonly selfImprovement: boolean;
  readonly voice: VoiceDraft;
  readonly supervisorId: string;
  readonly workspace: string;
  readonly priority: TaskPriority;
  readonly hours: HoursDraft;
  readonly toolGrants: readonly ToolGrant[];
  readonly budget: Budget | null;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const DEFAULT_HOURS: HoursDraft = {
  own: false,
  timezone: "UTC",
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

const refKey = (ref: ModelRef): string => `${ref.provider}/${ref.model}`;
const parseRef = (key: string): ModelRef => {
  const [provider = "", model = ""] = key.split("/");
  return { provider, model };
};

function draftOf(employee: Employee): Draft {
  return {
    name: employee.name,
    role: employee.role,
    color: employee.color,
    avatar: employee.avatar ?? "",
    model: { provider: employee.llm.provider, model: employee.llm.model },
    fallbacks: employee.llm.fallbacks,
    skills: employee.skillIds.join(", "),
    instructions: employee.instructions ?? "",
    examples: employee.examples,
    selfImprovement: employee.selfImprovement,
    voice: voiceDraftOf(employee),
    supervisorId: employee.supervisorId ?? "",
    workspace: employee.workspaceRef ?? "",
    priority: employee.priority,
    toolGrants: employee.toolGrants,
    budget: employee.budget,
    hours:
      employee.schedule === null || employee.schedule.kind === "always"
        ? DEFAULT_HOURS
        : {
            own: true,
            timezone: employee.schedule.timezone,
            days: employee.schedule.windows[0]?.days ?? DEFAULT_HOURS.days,
            start: employee.schedule.windows[0]?.start ?? DEFAULT_HOURS.start,
            end: employee.schedule.windows[0]?.end ?? DEFAULT_HOURS.end,
          },
  };
}

export function EmployeeDrawer({ store }: { readonly store: OfficeStore }): ReactNode {
  const selectedEmployeeId = store((state) => state.selectedEmployeeId);
  const employees = store((state) => state.employees);
  const departments = store((state) => state.departments);
  const connectors = store((state) => state.connectors);
  const spend = store((state) => state.spend);

  const employee = employees.find((candidate) => candidate.id === selectedEmployeeId) ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [pending, setPending] = useState("");

  useEffect(() => {
    setDraft(employee === null ? null : draftOf(employee));
    setProblems([]);
  }, [employee]);

  const close = (): void => {
    store.getState().selectEmployee(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  });

  if (employee === null || draft === null) return null;

  const department = departments.find((candidate) => candidate.id === employee.departmentId);
  const models = availableModels();
  const supervisors = supervisorChoices(employees, employee);
  const edit = (change: Partial<Draft>): void => {
    setDraft({ ...draft, ...change });
  };

  const save = (): void => {
    void store
      .getState()
      .saveEmployee(employee.id, {
        name: draft.name,
        role: draft.role,
        color: draft.color,
        avatar: draft.avatar.trim().length === 0 ? null : draft.avatar.trim(),
        priority: draft.priority,
        llm: {
          provider: draft.model.provider,
          model: draft.model.model,
          params: employee.llm.params,
          fallbacks: draft.fallbacks,
        },
        skillIds: draft.skills
          .split(",")
          .map((skill) => skill.trim())
          .filter((skill) => skill.length > 0),
        // Sent as typed: core reads a blank paragraph as nothing written, so
        // clearing the field is how somebody is untaught. Deciding that again
        // here would be the same rule in two places.
        instructions: draft.instructions,
        examples: draft.examples,
        selfImprovement: draft.selfImprovement,
        ...voiceChangeOf(draft.voice, employee),
        supervisorId: draft.supervisorId.length === 0 ? null : draft.supervisorId,
        workspaceRef: draft.workspace.trim().length === 0 ? null : draft.workspace.trim(),
        toolGrants: draft.toolGrants,
        budget: draft.budget,
        // Null hands the employee back to their department's hours.
        schedule: draft.hours.own
          ? {
              kind: "windows",
              timezone: draft.hours.timezone,
              windows: [{ days: draft.hours.days, start: draft.hours.start, end: draft.hours.end }],
            }
          : null,
      })
      .then((result) => {
        if (result.ok) {
          close();
          return;
        }
        setProblems(result.problems);
      });
  };

  return (
    <aside
      role="dialog"
      aria-label={`Configure ${employee.name}`}
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4"
    >
      <header>
        <h2 className="text-sm font-semibold text-ink">{employee.name}</h2>
        <p className="text-xs text-ink-muted">{department?.name ?? "No department"}</p>
      </header>

      <Problems problems={problems} />

      <Field label="Name">
        <input
          className={inputClass}
          value={draft.name}
          onChange={(event) => {
            edit({ name: event.target.value });
          }}
        />
      </Field>

      <Field label="Role">
        <input
          className={inputClass}
          value={draft.role}
          onChange={(event) => {
            edit({ role: event.target.value });
          }}
        />
      </Field>

      <Field label="Colour">
        <input
          type="color"
          className="h-8 w-16 rounded border border-border bg-surface"
          value={draft.color}
          onChange={(event) => {
            edit({ color: event.target.value });
          }}
        />
      </Field>

      <Field label="Model">
        <select
          className={inputClass}
          value={refKey(draft.model)}
          onChange={(event) => {
            edit({ model: parseRef(event.target.value) });
          }}
        >
          {models.map((model) => (
            <option key={refKey(model)} value={refKey(model)}>
              {model.label} ({model.tier})
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-2">
        <span className="text-xs text-ink-muted">
          Fallbacks, tried in order when the model above will not answer
        </span>
        <ol className="flex flex-col gap-1">
          {draft.fallbacks.map((fallback, index) => (
            <li key={refKey(fallback)} className="flex items-center gap-2 text-xs text-ink">
              <span className="text-ink-muted">{index + 1}.</span>
              {fallback.model}
              <button
                type="button"
                aria-label={`Remove ${fallback.model}`}
                className="ml-auto text-ink-muted hover:text-ink"
                onClick={() => {
                  edit({
                    fallbacks: draft.fallbacks.filter((candidate) => candidate !== fallback),
                  });
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        <div className="flex items-end gap-2">
          <Field label="Add a fallback">
            <select
              className={inputClass}
              value={pending}
              onChange={(event) => {
                setPending(event.target.value);
              }}
            >
              <option value="">Choose a model</option>
              {models
                .filter((model) => refKey(model) !== refKey(draft.model))
                .filter((model) => !draft.fallbacks.some((f) => refKey(f) === refKey(model)))
                .map((model) => (
                  <option key={refKey(model)} value={refKey(model)}>
                    {model.label}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            aria-label="Add fallback"
            disabled={pending.length === 0}
            onClick={() => {
              edit({ fallbacks: [...draft.fallbacks, parseRef(pending)] });
              setPending("");
            }}
          >
            Add
          </Button>
        </div>
      </div>

      <Field label="Skills">
        <input
          className={inputClass}
          placeholder="sql, code-review"
          value={draft.skills}
          onChange={(event) => {
            edit({ skills: event.target.value });
          }}
        />
      </Field>

      <Teaching
        instructions={draft.instructions}
        examples={draft.examples}
        onChange={(changes) => {
          edit(changes);
        }}
      />

      <SelfImprovement
        store={store}
        employee={employee}
        on={draft.selfImprovement}
        onChange={(selfImprovement) => {
          edit({ selfImprovement });
        }}
      />

      <Understudy
        store={store}
        employee={employee}
        draft={draft.voice}
        onChange={(changes) => {
          edit({ voice: { ...draft.voice, ...changes } });
        }}
      />

      <PriorityField
        value={draft.priority}
        onChange={(priority) => {
          edit({ priority });
        }}
        note="This person's own standing, within what their department and the office have already decided. Lowering it tells them to yield to their colleagues."
        className={inputClass}
      />

      <Field label="Reports to">
        <select
          className={inputClass}
          value={draft.supervisorId}
          onChange={(event) => {
            edit({ supervisorId: event.target.value });
          }}
        >
          <option value="">Nobody</option>
          {supervisors.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Working hours">
        <select
          className={inputClass}
          value={draft.hours.own ? "own" : "department"}
          onChange={(event) => {
            edit({ hours: { ...draft.hours, own: event.target.value === "own" } });
          }}
        >
          <option value="department">Same as the department</option>
          <option value="own">Hours of their own</option>
        </select>
      </Field>

      {draft.hours.own && (
        <div className="flex flex-col gap-2 rounded-panel border border-border p-2">
          <Field label="Timezone">
            <input
              className={inputClass}
              value={draft.hours.timezone}
              onChange={(event) => {
                edit({ hours: { ...draft.hours, timezone: event.target.value } });
              }}
            />
          </Field>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="text-xs text-ink-muted">Days</legend>
            {WEEKDAYS.map((day) => (
              <label key={day} className="flex items-center gap-1 text-xs text-ink">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={draft.hours.days.includes(day)}
                  aria-label={day}
                  onChange={(event) => {
                    edit({
                      hours: {
                        ...draft.hours,
                        days: event.target.checked
                          ? [...draft.hours.days, day]
                          : draft.hours.days.filter((candidate) => candidate !== day),
                      },
                    });
                  }}
                />
                {day}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Field label="From">
              <input
                type="time"
                className={inputClass}
                value={draft.hours.start}
                onChange={(event) => {
                  edit({ hours: { ...draft.hours, start: event.target.value } });
                }}
              />
            </Field>
            <Field label="To">
              <input
                type="time"
                className={inputClass}
                value={draft.hours.end}
                onChange={(event) => {
                  edit({ hours: { ...draft.hours, end: event.target.value } });
                }}
              />
            </Field>
          </div>
        </div>
      )}

      <Field label="Workspace">
        <input
          className={inputClass}
          placeholder="git://acme/backend"
          value={draft.workspace}
          onChange={(event) => {
            edit({ workspace: event.target.value });
          }}
        />
      </Field>

      <Field label="Avatar">
        <input
          className={inputClass}
          placeholder="https://…"
          value={draft.avatar}
          onChange={(event) => {
            edit({ avatar: event.target.value });
          }}
        />
      </Field>

      <BudgetField
        what="person"
        value={draft.budget}
        {...(spend === null ? {} : { spentUsd: spend.byEmployee[employee.id] ?? 0 })}
        onChange={(budget) => {
          edit({ budget });
        }}
      />

      {/* Terminating is final, so it is not offered here: a settings panel is
          not where somebody's employment ends, and a disabled switch would
          imply it could be undone. */}
      {employee.status === "terminated" ? (
        <p className="rounded-panel border border-border p-2 text-xs text-ink-muted">
          No longer works here. Their record is kept; they pick up nothing.
        </p>
      ) : (
        <RunSwitch
          what="person"
          running={employee.status === "active"}
          onChange={(running) => {
            void store.getState().saveEmployeeStatus(employee.id, running ? "active" : "paused");
          }}
        />
      )}

      {/* The department's grants go in as inherited, never as the person's own:
          copied onto them they would outlive the department's. */}
      <Grants
        connectors={connectors}
        grants={draft.toolGrants}
        inherited={department?.toolGrants ?? []}
        owner="employee"
        onChange={(toolGrants) => {
          edit({ toolGrants });
        }}
      />

      <Tray store={store} owner={{ kind: "employee", id: employee.id }} tray="in" />
      <Tray store={store} owner={{ kind: "employee", id: employee.id }} tray="out" />
      <Produced store={store} owner={{ kind: "employee", id: employee.id }} tray="in" />
      <Produced store={store} owner={{ kind: "employee", id: employee.id }} tray="out" />

      <div className="mt-auto flex gap-2 pt-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </aside>
  );
}
