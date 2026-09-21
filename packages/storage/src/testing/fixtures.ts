/**
 * Deterministic domain fixtures for storage tests. Built through the core
 * factories so every stored entity is a valid domain object.
 */
import {
  createConnection,
  createConnector,
  createDepartment,
  createEmployee,
  createMemoryItem,
  createOffice,
  createTask,
  parseSkill,
  unwrap,
  type Connection,
  type ConnectionId,
  type Connector,
  type ConnectorId,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type MemoryItem,
  type MemoryItemId,
  type Office,
  type OfficeId,
  type Skill,
  type Task,
  type TaskId,
} from "@vo/core";

export const T0 = new Date("2026-09-22T00:00:00Z");

export function office(id: string, name = `Office ${id}`): Office {
  return unwrap(
    createOffice(
      {
        name,
        schedule: {
          kind: "windows",
          timezone: "Europe/Nicosia",
          windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00" }],
        },
      },
      { id: () => id as OfficeId, now: () => T0 },
    ),
  );
}

export function department(id: string, officeId: string, name = `Dept ${id}`): Department {
  return unwrap(
    createDepartment(
      {
        officeId: officeId as OfficeId,
        name,
        color: "#3b82f6",
        position: { x: 10, y: 20 },
        config: { tier: 2 },
      },
      [],
      { id: () => id as DepartmentId, now: () => T0 },
    ),
  );
}

export function employee(
  id: string,
  officeId: string,
  departmentId: string,
  name = `Emp ${id}`,
): Employee {
  return unwrap(
    createEmployee(
      {
        name,
        role: "Engineer",
        color: "#10b981",
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          fallbacks: [{ provider: "openai", model: "gpt-5" }],
        },
        skillIds: ["tdd"],
        toolGrants: [{ connectorId: "conn-1", tool: "*" }],
      },
      {
        department: { id: departmentId as DepartmentId, officeId: officeId as OfficeId },
        supervisor: null,
      },
      { id: () => id as EmployeeId, now: () => T0 },
    ),
  );
}

export function task(
  id: string,
  officeId: string,
  departmentId: string,
  title = `Task ${id}`,
): Task {
  return unwrap(
    createTask(
      {
        officeId: officeId as OfficeId,
        departmentId: departmentId as DepartmentId,
        title,
        priority: "high",
        tokenBudget: 1000,
      },
      { id: () => id as TaskId, now: () => T0 },
    ),
  );
}

export function connection(id: string, officeId: string, fromId: string, toId: string): Connection {
  return unwrap(
    createConnection(
      {
        officeId: officeId as OfficeId,
        fromId: fromId as DepartmentId,
        toId: toId as DepartmentId,
        kind: "handoff",
        rules: { brief: true },
      },
      { departments: new Set([fromId as DepartmentId, toId as DepartmentId]), existing: [] },
      { id: () => id as ConnectionId, now: () => T0 },
    ),
  );
}

export function connector(id: string, officeId: string, name = `conn-${id}`): Connector {
  return unwrap(
    createConnector(
      {
        officeId: officeId as OfficeId,
        kind: "mcp",
        name,
        tools: ["a", "b"],
        secretRef: "vault://x",
      },
      [],
      { id: () => id as ConnectorId, now: () => T0 },
    ),
  );
}

export function skill(name: string, version = "1.0.0"): Skill {
  return unwrap(
    parseSkill(
      `---\nname: ${name}\nversion: ${version}\ndescription: Skill ${name}\ntags: [t]\n---\nDo the thing.\n`,
      {
        knownTools: new Set(),
      },
    ),
  );
}

export function memory(
  id: string,
  officeId: string,
  ownerId: string,
  content = "fact",
): MemoryItem {
  return unwrap(
    createMemoryItem(
      {
        officeId: officeId as OfficeId,
        scope: "employee",
        ownerId,
        kind: "fact",
        content,
        sharing: { office: false, departments: ["dept-2" as DepartmentId], employees: [] },
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      },
      { id: () => id as MemoryItemId, now: () => T0 },
    ),
  );
}
