import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import type { TaskId } from "../task/task.js";
import { isErr, unwrap } from "../shared/result.js";
import { usageRecordOf, type UsageRecord } from "./usage-record.js";

const officeId = "office-1" as OfficeId;
const taskId = "task-1" as TaskId;
const ada = "emp-ada" as EmployeeId;
const eng = "dept-eng" as DepartmentId;
const at = new Date("2026-10-01T09:00:00Z");

const deps = { id: () => "usage-1", now: () => at };

/** An event shaped the way telemetry writes one. */
const event = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "ev-1",
  kind: "llm_call",
  at: at.getTime(),
  attribution: { officeId, departmentId: eng, employeeId: ada, taskId, runId: "run-1" },
  durationMs: 1200,
  ok: true,
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage: { inputTokens: 100, outputTokens: 50 },
  cost: { totalUsd: 0.004 },
  streamed: false,
  ...overrides,
});

const made = (raw: Record<string, unknown> = event()): UsageRecord =>
  unwrap(usageRecordOf(raw, deps));

describe("turning a usage event into something the office can keep", () => {
  it("promotes the office it was spent in", () => {
    expect(made().officeId).toBe(officeId);
  });

  it("promotes the task and the person, which is what anybody filters on", () => {
    expect(made().taskId).toBe(taskId);
    expect(made().employeeId).toBe(ada);
  });

  it("takes the moment from the event, not from the clock", () => {
    // The row is written after the call finished, sometimes much later if the
    // office was unreachable. Stamping it on arrival would misdate the spend.
    expect(made().at).toEqual(at);
  });

  it("keeps the whole event, unread", () => {
    // Core stores it and does not interpret it, the way a connector's config is
    // stored — so a new kind of event never touches core or storage.
    expect(made().event).toEqual(event());
  });

  it("gives the row its own id, not the event's", () => {
    // Two rows could carry one event if a worker retried; the row is the thing
    // the store keys on.
    expect(made().id).toBe("usage-1");
  });
});

describe("events that say less than the full picture", () => {
  it("takes one with no task, since not every call is on a task", () => {
    const record = made(event({ attribution: { officeId, employeeId: ada } }));
    expect(record.taskId).toBeNull();
    expect(record.employeeId).toBe(ada);
  });

  it("takes one with nobody named", () => {
    expect(made(event({ attribution: { officeId } })).employeeId).toBeNull();
  });

  it("refuses one that names no office, which nothing could file", () => {
    expect(isErr(usageRecordOf(event({ attribution: {} }), deps))).toBe(true);
  });

  it("refuses one with no attribution at all", () => {
    expect(isErr(usageRecordOf(event({ attribution: undefined }), deps))).toBe(true);
  });

  it("refuses one that is not an object", () => {
    expect(isErr(usageRecordOf("not an event" as never, deps))).toBe(true);
  });

  it("refuses one with no moment, rather than guessing at now", () => {
    // A row with an invented time would quietly land in the wrong day's total.
    expect(isErr(usageRecordOf(event({ at: undefined }), deps))).toBe(true);
    expect(isErr(usageRecordOf(event({ at: "lunchtime" }), deps))).toBe(true);
  });

  it("says which field it refused", () => {
    const result = usageRecordOf(event({ attribution: {} }), deps);
    expect(isErr(result) && result.error[0]?.path).toContain("officeId");
  });
});
