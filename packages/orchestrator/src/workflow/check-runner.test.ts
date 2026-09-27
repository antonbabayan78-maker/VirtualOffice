import { describe, expect, it } from "vitest";
import {
  createTask,
  unwrap,
  type DepartmentId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import {
  fixedCheckRunner,
  reportCheck,
  type CheckReport,
  type CheckRunner,
} from "./check-runner.js";

const task: Task = unwrap(
  createTask(
    { officeId: "office-1" as OfficeId, departmentId: "dept-1" as DepartmentId, title: "Ship it" },
    { id: () => "task-1" as TaskId, now: () => new Date("2026-09-27T09:00:00Z") },
  ),
);

const passed: CheckReport = { checkId: "unit-tests", outcome: "passed", output: "42 passed" };

describe("fixedCheckRunner", () => {
  it("reports what it was configured with and runs no command", async () => {
    const runner = fixedCheckRunner({ "unit-tests": passed });
    await expect(runner.run("unit-tests", task)).resolves.toEqual(passed);
  });

  it("refuses a check it does not know", async () => {
    const runner = fixedCheckRunner({ "unit-tests": passed });
    await expect(runner.run("lint", task)).rejects.toThrow(/lint/);
  });
});

describe("reportCheck", () => {
  it("passes a successful report straight through", async () => {
    await expect(
      reportCheck(fixedCheckRunner({ "unit-tests": passed }), "unit-tests", task),
    ).resolves.toEqual(passed);
  });

  it("turns a thrown runner into an errored report rather than a pass", async () => {
    const broken: CheckRunner = {
      run: () => Promise.reject(new Error("vitest: command not found")),
    };
    const report = await reportCheck(broken, "unit-tests", task);
    expect(report).toEqual({
      checkId: "unit-tests",
      outcome: "errored",
      output: "vitest: command not found",
    });
  });

  it("survives a runner that rejects with something that is not an Error", async () => {
    const odd: CheckRunner = {
      // A badly behaved runner is the point of this test.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      run: () => Promise.reject("exit 137"),
    };
    const report = await reportCheck(odd, "unit-tests", task);
    expect(report.outcome).toBe("errored");
    expect(report.output).toBe("exit 137");
  });

  it("treats a report about a different check as an error", async () => {
    const confused: CheckRunner = {
      run: () => Promise.resolve({ checkId: "lint", outcome: "passed", output: "" } as const),
    };
    const report = await reportCheck(confused, "unit-tests", task);
    expect(report.outcome).toBe("errored");
    expect(report.output).toMatch(/lint/);
  });
});
