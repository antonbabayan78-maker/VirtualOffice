import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createConnection, type Connection, type ConnectionId } from "../connection/connection.js";
import { createConnector, type Connector, type ConnectorId } from "../connector/connector.js";
import { createDepartment, type Department, type DepartmentId } from "../department/department.js";
import {
  createEmployee,
  transitionEmployee,
  type Employee,
  type EmployeeId,
} from "../employee/employee.js";
import { createOffice, type Office, type OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import type { OfficeConfig } from "../snapshot/snapshot.js";
import { exportOfficeYaml, importOfficeYaml, OFFICE_FILE_VERSION } from "./office-file.js";

const t0 = new Date("2026-09-22T00:00:00Z");
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}
const deps = { id: () => "generated-id", now: () => t0 };

function sampleConfig(): OfficeConfig {
  const officeId = "office-1" as OfficeId;
  const office: Office = {
    ...unwrap(
      createOffice(
        {
          name: "Acme Studio",
          schedule: {
            kind: "windows",
            timezone: "Europe/Nicosia",
            windows: [{ days: ["mon", "tue"], start: "09:00", end: "18:00" }],
          },
        },
        { id: () => officeId, now: () => t0 },
      ),
    ),
    configVersion: 4,
  };
  const eng = unwrap(
    createDepartment(
      {
        officeId,
        name: "Engineering",
        color: "#3B82F6",
        position: { x: 10, y: 20 },
        icon: "🛠️",
        config: { tier: 1 },
        reviewPolicy: { kind: "quorum", required: 2 },
      },
      [],
      { id: () => "d-eng" as DepartmentId, now: () => t0 },
    ),
  );
  const sales = unwrap(
    createDepartment(
      { officeId, name: "Sales", color: "#10b981", position: { x: 600, y: 20 } },
      [eng],
      { id: () => "d-sales" as DepartmentId, now: () => t0 },
    ),
  );
  const github = unwrap(
    createConnector(
      {
        officeId,
        kind: "mcp",
        name: "github",
        tools: ["get_diff", "create_review"],
        secretRef: "vault://abc",
        config: { url: "x" },
      },
      [],
      { id: () => "k-github" as ConnectorId, now: () => t0 },
    ),
  );
  const boss = unwrap(
    createEmployee(
      {
        name: "Grace",
        role: "Lead",
        color: "#000000",
        llm: { provider: "anthropic", model: "claude-fable-5-1" },
      },
      { department: { id: eng.id, officeId }, supervisor: null },
      { id: () => "e-grace" as EmployeeId, now: () => t0 },
    ),
  );
  const ada = unwrap(
    createEmployee(
      {
        name: "Ada",
        role: "Engineer",
        color: "#ff8800",
        avatar: "robot-2",
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-5",
          params: { temperature: 0.2 },
          fallbacks: [{ provider: "openai", model: "gpt-5" }],
        },
        skillIds: ["tdd", "code-review"],
        toolGrants: [{ connectorId: github.id, tool: "*" }],
        schedule: { kind: "always" },
        supervisorId: boss.id,
        workspaceRef: "git://acme/backend",
      },
      {
        department: { id: eng.id, officeId },
        supervisor: { id: boss.id, officeId, status: "active" },
      },
      { id: () => "e-ada" as EmployeeId, now: () => t0 },
    ),
  );
  const paused = unwrap(transitionEmployee(ada, "paused", new Date("2026-09-23T00:00:00Z")));
  const handoff = unwrap(
    createConnection(
      { officeId, fromId: eng.id, toId: sales.id, kind: "handoff", rules: { brief: true } },
      { departments: new Set([eng.id, sales.id]), existing: [] },
      { id: () => "c-1" as ConnectionId, now: () => t0 },
    ),
  );
  return {
    office,
    departments: [eng, sales],
    employees: [boss, paused],
    connections: [handoff],
    connectors: [github],
  };
}

const sortById = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));
function normalize(config: OfficeConfig): OfficeConfig {
  return {
    office: config.office,
    departments: sortById(config.departments),
    employees: sortById(config.employees),
    connections: sortById(config.connections),
    connectors: sortById(config.connectors),
  };
}

describe("exportOfficeYaml", () => {
  it("writes a versioned, human-readable document with entities sorted by id", () => {
    const yaml = exportOfficeYaml(sampleConfig());
    expect(yaml.startsWith(`version: ${String(OFFICE_FILE_VERSION)}\n`)).toBe(true);
    expect(yaml).toMatch(/^office:\n {2}id: office-1\n {2}name: Acme Studio/m);
    expect(yaml.indexOf("id: d-eng")).toBeLessThan(yaml.indexOf("id: d-sales"));
    expect(yaml.indexOf("id: e-ada")).toBeLessThan(yaml.indexOf("id: e-grace"));
    expect(yaml).toContain("secretRef: vault://abc");
    expect(yaml).not.toMatch(/tasks:|memories:/);
    expect(yaml).toContain("createdAt: 2026-09-22T00:00:00.000Z");
  });

  it("is deterministic", () => {
    expect(exportOfficeYaml(sampleConfig())).toBe(exportOfficeYaml(sampleConfig()));
  });
});

describe("importOfficeYaml", () => {
  it("round-trips the sample config exactly (entity order is not significant)", () => {
    const config = sampleConfig();
    const back = importOfficeYaml(exportOfficeYaml(config), deps);
    expect(isOk(back)).toBe(true);
    expect(normalize(unwrap(back))).toEqual(normalize(config));
  });

  it("generates ids and timestamps when a hand-written file omits them", () => {
    const yaml = `
version: 1
office:
  name: Tiny
departments:
  - id: dev
    name: Dev
    color: "#123456"
    position: { x: 0, y: 0 }
employees:
  - name: Bo
    role: Builder
    color: "#abcdef"
    department: dev
    llm: { provider: ollama, model: llama3 }
`;
    const r = importOfficeYaml(yaml, { id: () => "gen-1", now: () => t0 });
    expect(isOk(r)).toBe(true);
    const config = unwrap(r);
    expect(config.office.id).toBe("gen-1");
    expect(config.office.schedule).toEqual({ kind: "always" });
    expect(config.office.configVersion).toBe(1);
    expect(config.departments[0]?.officeId).toBe("gen-1");
    expect(config.employees[0]?.id).toBe("gen-1");
    expect(config.employees[0]?.departmentId).toBe("dev");
    expect(config.employees[0]?.status).toBe("active");
    expect(config.employees[0]?.createdAt).toEqual(t0);
  });

  it("reports YAML syntax errors with line and column", () => {
    const r = importOfficeYaml("version: 1\noffice:\n  name: Acme\n  name: Twice\n", deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error[0]?.path).toBe("");
      expect(r.error[0]?.line).toBe(4);
      expect(r.error[0]?.col).toBe(3);
      expect(r.error[0]?.message).toMatch(/unique/i);
    }
  });

  it("reports semantic errors at the line of the offending value", () => {
    const yaml = [
      "version: 1",
      "office:",
      "  name: Acme",
      "departments:",
      "  - id: d1",
      "    name: Eng",
      "    color: red", // line 7
      "    position: { x: 0, y: 0 }",
      "employees:",
      "  - name: Ada",
      "    role: Eng",
      "    color: '#000000'",
      "    department: nope", // line 13
      "    llm: { provider: anthropic }", // line 14
      "connections:",
      "  - from: d1",
      "    to: d1", // line 17
      "    kind: handoff",
    ].join("\n");
    const r = importOfficeYaml(yaml, deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const byPath = new Map(r.error.map((e) => [e.path, e]));
      expect(byPath.get("departments[0].color")).toMatchObject({ line: 7 });
      expect(byPath.get("employees[0].department")).toMatchObject({
        line: 13,
        message: expect.stringMatching(/unknown department "nope"/) as string,
      });
      expect(byPath.get("employees[0].llm.model")).toMatchObject({ line: 14 });
      expect(byPath.get("connections[0]")).toMatchObject({
        line: 16,
        message: expect.stringMatching(/itself/) as string,
      });
    }
  });

  it("rejects unsupported versions, missing office and duplicate ids", () => {
    const v = importOfficeYaml("version: 2\noffice:\n  name: X\n", deps);
    expect(isErr(v)).toBe(true);
    if (isErr(v)) expect(v.error[0]).toMatchObject({ path: "version", line: 1 });
    const noOffice = importOfficeYaml("version: 1\ndepartments: []\n", deps);
    expect(isErr(noOffice)).toBe(true);
    if (isErr(noOffice)) expect(noOffice.error[0]?.path).toBe("office");
    const dup = importOfficeYaml(
      "version: 1\noffice: { name: X }\ndepartments:\n  - { id: a, name: A, color: '#000000', position: { x: 0, y: 0 } }\n  - { id: a, name: B, color: '#000000', position: { x: 0, y: 0 } }\n",
      deps,
    );
    expect(isErr(dup)).toBe(true);
    if (isErr(dup))
      expect(dup.error[0]).toMatchObject({
        path: "departments[1].id",
        line: 5,
        message: expect.stringMatching(/duplicate/) as string,
      });
    expect(isErr(importOfficeYaml("just a string", deps))).toBe(true);
  });

  it("rejects an unknown supervisor and a tool grant on an unknown connector", () => {
    const yaml = `
version: 1
office: { name: X }
departments:
  - { id: d, name: D, color: '#000000', position: { x: 0, y: 0 } }
employees:
  - name: A
    role: R
    color: '#000000'
    department: d
    llm: { provider: p, model: m }
    supervisor: ghost
    tools:
      - { connector: nope, tool: x }
`;
    const r = importOfficeYaml(yaml, deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const paths = r.error.map((e) => e.path);
      expect(paths).toContain("employees[0].supervisor");
      expect(paths).toContain("employees[0].tools[0].connector");
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based round trip
// ---------------------------------------------------------------------------

const word = fc.stringMatching(/^[a-z][a-z0-9]{1,9}$/);
const label = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,18}[A-Za-z0-9]$/);
const hex = fc.stringMatching(/^#[0-9a-f]{6}$/);
const kebab = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/);
const time = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const weekdays = fc.uniqueArray(
  fc.constantFrom("mon", "tue", "wed", "thu", "fri", "sat", "sun" as const),
  { minLength: 1, maxLength: 7 },
);
const schedule = fc.oneof(
  fc.constant({ kind: "always" as const }),
  fc.record({
    kind: fc.constant("windows" as const),
    timezone: fc.constantFrom("UTC", "Europe/Nicosia", "America/New_York", "Asia/Tokyo"),
    windows: fc.array(
      fc.record({ days: weekdays, start: time, end: time }).filter((w) => w.start !== w.end),
      { minLength: 1, maxLength: 3 },
    ),
  }),
);

const configArb: fc.Arbitrary<OfficeConfig> = fc
  .record({
    officeName: label,
    schedule,
    configVersion: fc.integer({ min: 1, max: 500 }),
    departmentNames: fc.uniqueArray(label, {
      minLength: 1,
      maxLength: 4,
      comparator: (a, b) => a.toLowerCase() === b.toLowerCase(),
    }),
    colors: fc.array(hex, { minLength: 8, maxLength: 8 }),
    connectorNames: fc.uniqueArray(kebab, { minLength: 0, maxLength: 3 }),
    employees: fc.array(
      fc.record({
        name: label,
        role: label,
        deptIndex: fc.nat(),
        skills: fc.uniqueArray(word, { maxLength: 3 }),
        temperature: fc.option(fc.double({ min: 0, max: 2, noNaN: true }), { nil: undefined }),
        fallbacks: fc.array(fc.record({ provider: word, model: word }), { maxLength: 2 }),
        status: fc.constantFrom("active", "paused", "terminated" as const),
        wildcardGrant: fc.boolean(),
      }),
      { maxLength: 5 },
    ),
    connections: fc.array(
      fc.record({
        a: fc.nat(),
        b: fc.nat(),
        kind: fc.constantFrom(
          "reports_to",
          "collaborates",
          "handoff",
          "reviews",
          "escalates_to" as const,
        ),
      }),
      { maxLength: 5 },
    ),
  })
  .map((g) => {
    const officeId = "office" as OfficeId;
    const mk = <T extends string>(id: T) => ({ id: () => id, now: () => t0 });
    const office: Office = {
      ...unwrap(createOffice({ name: g.officeName, schedule: g.schedule }, mk(officeId))),
      configVersion: g.configVersion,
    };
    const departments: Department[] = [];
    g.departmentNames.forEach((name, i) => {
      departments.push(
        unwrap(
          createDepartment(
            { officeId, name, color: g.colors[i % 8] ?? "#000000", position: { x: i * 100, y: 0 } },
            departments,
            mk(`d${String(i)}` as DepartmentId),
          ),
        ),
      );
    });
    const connectors: Connector[] = [];
    g.connectorNames.forEach((name, i) => {
      connectors.push(
        unwrap(
          createConnector(
            { officeId, kind: "mcp", name, tools: ["a", "b"] },
            connectors,
            mk(`k${String(i)}` as ConnectorId),
          ),
        ),
      );
    });
    const employees: Employee[] = [];
    g.employees.forEach((e, i) => {
      const dept = at(departments, e.deptIndex % departments.length);
      const grant =
        e.wildcardGrant && connectors.length > 0
          ? [{ connectorId: at(connectors, 0).id, tool: "*" }]
          : [];
      const created = unwrap(
        createEmployee(
          {
            name: e.name,
            role: e.role,
            color: g.colors[(i + 3) % 8] ?? "#000000",
            llm: {
              provider: "anthropic",
              model: "claude-sonnet-5",
              ...(e.temperature === undefined ? {} : { params: { temperature: e.temperature } }),
              fallbacks: e.fallbacks,
            },
            skillIds: e.skills,
            toolGrants: grant,
          },
          { department: { id: dept.id, officeId }, supervisor: null },
          mk(`e${String(i)}` as EmployeeId),
        ),
      );
      employees.push(
        e.status === "active" ? created : unwrap(transitionEmployee(created, e.status, t0)),
      );
    });
    const connections: Connection[] = [];
    for (const c of g.connections) {
      if (departments.length < 2) break;
      const from = at(departments, c.a % departments.length);
      const to = at(departments, c.b % departments.length);
      const r = createConnection(
        { officeId, fromId: from.id, toId: to.id, kind: c.kind },
        { departments: new Set(departments.map((d) => d.id)), existing: connections },
        mk(`c${String(connections.length)}` as ConnectionId),
      );
      if (r.ok) connections.push(r.value);
    }
    return { office, departments, employees, connections, connectors };
  });

describe("property: export then import is the identity", () => {
  it("holds for generated offices", () => {
    fc.assert(
      fc.property(configArb, (config) => {
        const back = importOfficeYaml(exportOfficeYaml(config), deps);
        if (!back.ok) throw new Error(back.error.map((e) => `${e.path}: ${e.message}`).join("; "));
        expect(normalize(back.value)).toEqual(normalize(config));
      }),
      { numRuns: 60 },
    );
  });
});
