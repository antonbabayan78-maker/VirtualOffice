/**
 * @vo/core
 *
 * Pure domain model and invariants: Office, Department, Employee, Task, Skill, Memory, Connection, Connector. No IO.
 */
export const PACKAGE_NAME = "@vo/core" as const;

export * from "./shared/result.js";
export * from "./office/schedule.js";
export * from "./office/office.js";
export * from "./department/review-policy.js";
export * from "./department/department.js";
export * from "./employee/llm-config.js";
export * from "./employee/employee.js";
export * from "./connection/connection.js";
export * from "./task/task.js";
