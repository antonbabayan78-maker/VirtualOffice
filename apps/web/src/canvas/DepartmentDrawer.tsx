/**
 * Configuring one department.
 *
 * The same shape as the employee drawer — a draft, one save, core's refusals
 * shown rather than swallowed — because two settings panels that behave
 * differently is two things to learn.
 *
 * Its centrepiece is the review policy, where the office decides how work gets
 * approved. Each policy asks for what it needs and nothing else, and every kind
 * offered is one the workflow engine can actually run.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Department, GatedAction, TaskPriority, ToolGrant, ValidationError } from "@vo/core";
import type { OfficeStore } from "../office/office-store.js";
import { Button } from "../ui/button.js";
import { Field, Problems, inputClass } from "../ui/field.js";
import { Grants } from "./Grants.js";
import { PriorityField } from "./PriorityField.js";
import { Produced } from "./Produced.js";
import { Tray } from "./Tray.js";
import {
  ALL_GATED_ACTIONS,
  POLICY_DESCRIPTION,
  POLICY_KINDS,
  policyDraftOf,
  policyFromDraft,
  type PolicyDraft,
  type PolicyKind,
} from "./review-policy-draft.js";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface HoursDraft {
  readonly own: boolean;
  readonly timezone: string;
  readonly days: readonly string[];
  readonly start: string;
  readonly end: string;
}

const DEFAULT_HOURS: HoursDraft = {
  own: false,
  timezone: "UTC",
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

interface Draft {
  readonly name: string;
  readonly color: string;
  readonly icon: string;
  readonly priority: TaskPriority;
  readonly definitionOfDone: readonly string[];
  readonly policy: PolicyDraft;
  readonly hours: HoursDraft;
  readonly toolGrants: readonly ToolGrant[];
}

function draftOf(department: Department): Draft {
  return {
    name: department.name,
    color: department.color,
    icon: department.icon ?? "",
    priority: department.priority,
    definitionOfDone: department.definitionOfDone,
    policy: policyDraftOf(department.reviewPolicy),
    toolGrants: department.toolGrants,
    hours:
      department.schedule.kind === "always"
        ? DEFAULT_HOURS
        : {
            own: true,
            timezone: department.schedule.timezone,
            days: department.schedule.windows[0]?.days ?? DEFAULT_HOURS.days,
            start: department.schedule.windows[0]?.start ?? DEFAULT_HOURS.start,
            end: department.schedule.windows[0]?.end ?? DEFAULT_HOURS.end,
          },
  };
}

/** Which settings a policy asks for. Anything not listed is not shown. */
const WANTS_ROUNDS: readonly PolicyKind[] = ["manager", "peer", "quorum", "pipeline", "automated"];

export function DepartmentDrawer({ store }: { readonly store: OfficeStore }): ReactNode {
  const selectedId = store((state) => state.selectedId);
  const departments = store((state) => state.departments);
  const employees = store((state) => state.employees);
  const connectors = store((state) => state.connectors);

  const department = departments.find((candidate) => candidate.id === selectedId) ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problems, setProblems] = useState<readonly ValidationError[]>([]);
  const [newStage, setNewStage] = useState("");
  const [newExpectation, setNewExpectation] = useState("");

  useEffect(() => {
    setDraft(department === null ? null : draftOf(department));
    setProblems([]);
    setNewStage("");
  }, [department]);

  const close = (): void => {
    store.getState().select(null);
  };

  if (department === null || draft === null) return null;

  const headcount = employees.filter((e) => e.departmentId === department.id).length;
  const edit = (change: Partial<Draft>): void => {
    setDraft({ ...draft, ...change });
  };
  const editPolicy = (change: Partial<PolicyDraft>): void => {
    edit({ policy: { ...draft.policy, ...change } });
  };

  const save = (): void => {
    void store
      .getState()
      .saveDepartment(department.id, {
        name: draft.name,
        color: draft.color,
        icon: draft.icon.trim().length === 0 ? null : draft.icon.trim(),
        priority: draft.priority,
        definitionOfDone: draft.definitionOfDone,
        reviewPolicy: policyFromDraft(draft.policy),
        toolGrants: draft.toolGrants,
        schedule: draft.hours.own
          ? {
              kind: "windows",
              timezone: draft.hours.timezone,
              windows: [{ days: draft.hours.days, start: draft.hours.start, end: draft.hours.end }],
            }
          : { kind: "always" },
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
      aria-label={`Configure ${department.name}`}
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4"
    >
      <header>
        <h2 className="text-sm font-semibold text-ink">{department.name}</h2>
        <p className="text-xs text-ink-muted">
          {headcount === 1 ? "1 person" : `${String(headcount)} people`}
        </p>
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

      <div className="flex gap-3">
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
        <Field label="Icon">
          <input
            className={inputClass}
            placeholder="wrench"
            value={draft.icon}
            onChange={(event) => {
              edit({ icon: event.target.value });
            }}
          />
        </Field>
      </div>

      <PriorityField
        value={draft.priority}
        onChange={(priority) => {
          edit({ priority });
        }}
        note="A department's own standing. Raising it puts everything this department does ahead of other departments' work, whatever their tasks say."
        className={inputClass}
      />

      <Field label="Review policy">
        <select
          className={inputClass}
          value={draft.policy.kind}
          onChange={(event) => {
            editPolicy({ kind: event.target.value as PolicyKind });
          }}
        >
          {POLICY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </Field>
      <p className="-mt-1 text-xs text-ink-muted">{POLICY_DESCRIPTION[draft.policy.kind]}</p>

      {draft.policy.kind === "quorum" && (
        <Field label="Approvals required">
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.policy.required}
            onChange={(event) => {
              editPolicy({ required: event.target.value });
            }}
          />
        </Field>
      )}

      {draft.policy.kind === "automated" && (
        <Field label="Check to run">
          <input
            className={inputClass}
            placeholder="unit-tests"
            value={draft.policy.checkId}
            onChange={(event) => {
              editPolicy({ checkId: event.target.value });
            }}
          />
        </Field>
      )}

      {draft.policy.kind === "gate" && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="text-xs text-ink-muted">What needs a person</legend>
          {ALL_GATED_ACTIONS.map((action) => (
            <label key={action} className="flex items-center gap-1 text-xs text-ink">
              <input
                type="checkbox"
                className="accent-accent"
                aria-label={action}
                checked={draft.policy.gatedActions.includes(action)}
                onChange={(event) => {
                  editPolicy({
                    gatedActions: event.target.checked
                      ? [...draft.policy.gatedActions, action]
                      : draft.policy.gatedActions.filter(
                          (candidate: GatedAction) => candidate !== action,
                        ),
                  });
                }}
              />
              {action}
            </label>
          ))}
        </fieldset>
      )}

      {draft.policy.kind === "pipeline" && (
        <div className="flex flex-col gap-2 rounded-panel border border-border p-2">
          <ol className="flex flex-col gap-1">
            {draft.policy.stages.map((stage, index) => (
              <li key={stage} className="flex items-center gap-2 text-xs text-ink">
                <span className="text-ink-muted">{index + 1}.</span>
                {stage}
                <button
                  type="button"
                  aria-label={`Remove ${stage}`}
                  className="ml-auto text-ink-muted hover:text-ink"
                  onClick={() => {
                    editPolicy({
                      stages: draft.policy.stages.filter((candidate) => candidate !== stage),
                    });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-end gap-2">
            <Field label="New stage">
              <input
                className={inputClass}
                placeholder="QA"
                value={newStage}
                onChange={(event) => {
                  setNewStage(event.target.value);
                }}
              />
            </Field>
            <Button
              aria-label="Add stage"
              disabled={newStage.trim().length === 0}
              onClick={() => {
                editPolicy({ stages: [...draft.policy.stages, newStage.trim()] });
                setNewStage("");
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {WANTS_ROUNDS.includes(draft.policy.kind) && (
        <Field label="Rounds before escalating">
          <input
            className={inputClass}
            inputMode="numeric"
            value={draft.policy.maxIterations}
            onChange={(event) => {
              editPolicy({ maxIterations: event.target.value });
            }}
          />
        </Field>
      )}

      <Field label="Working hours">
        <select
          className={inputClass}
          value={draft.hours.own ? "own" : "always"}
          onChange={(event) => {
            edit({ hours: { ...draft.hours, own: event.target.value === "own" } });
          }}
        >
          <option value="always">Around the clock</option>
          <option value="own">Working hours</option>
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
                  aria-label={day}
                  checked={draft.hours.days.includes(day)}
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

      <div className="flex flex-col gap-2 rounded-panel border border-border p-2">
        <p className="text-xs font-medium text-ink">Done means</p>
        <p className="text-[11px] text-ink-muted">
          What everything this department makes has to achieve. A reviewer answers this list, and
          work that leaves any of it unmet goes back rather than finishing.
        </p>
        {draft.definitionOfDone.length === 0 ? (
          <p className="text-xs text-ink-muted">Nothing yet — a reviewer decides for itself.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {draft.definitionOfDone.map((expectation) => (
              <li key={expectation} className="flex items-center gap-2 text-xs text-ink">
                {expectation}
                <button
                  type="button"
                  aria-label={`Remove ${expectation}`}
                  className="ml-auto text-ink-muted hover:text-ink"
                  onClick={() => {
                    edit({
                      definitionOfDone: draft.definitionOfDone.filter(
                        (candidate) => candidate !== expectation,
                      ),
                    });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Field label="New expectation">
            <input
              className={inputClass}
              placeholder="the tests cover the error path"
              value={newExpectation}
              onChange={(event) => {
                setNewExpectation(event.target.value);
              }}
            />
          </Field>
          <Button
            aria-label="Add expectation"
            disabled={newExpectation.trim().length === 0}
            onClick={() => {
              edit({ definitionOfDone: [...draft.definitionOfDone, newExpectation.trim()] });
              setNewExpectation("");
            }}
          >
            Add
          </Button>
        </div>
      </div>

      <Grants
        connectors={connectors}
        grants={draft.toolGrants}
        owner="department"
        onChange={(toolGrants) => {
          edit({ toolGrants });
        }}
      />

      <Tray store={store} owner={{ kind: "department", id: department.id }} tray="in" />
      <Tray store={store} owner={{ kind: "department", id: department.id }} tray="out" />
      <Produced store={store} owner={{ kind: "department", id: department.id }} tray="in" />
      <Produced store={store} owner={{ kind: "department", id: department.id }} tray="out" />

      <div className="mt-auto flex gap-2 pt-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </aside>
  );
}
