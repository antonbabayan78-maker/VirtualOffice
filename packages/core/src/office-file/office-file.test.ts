import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createConnection, type Connection, type ConnectionId } from "../connection/connection.js";
import { createConnector, type Connector, type ConnectorId } from "../connector/connector.js";
import { createDepartment, type Department, type DepartmentId } from "../department/department.js";
import {
  createEmployee,
  recordCorrection,
  transitionEmployee,
  type Employee,
  type EmployeeId,
} from "../employee/employee.js";
import {
  createLlmService,
  type LlmService,
  type LlmServiceId,
} from "../llm-service/llm-service.js";
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
  const workshop = unwrap(
    createLlmService(
      {
        officeId,
        kind: "openai-compatible",
        name: "workshop",
        baseUrl: "http://10.0.0.12:11434/v1",
        models: [{ id: "qwen3-coder", pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
      },
      [],
      { id: () => "svc-workshop" as LlmServiceId, now: () => t0 },
    ),
  );
  return {
    office,
    departments: [eng, sales],
    employees: [boss, paused],
    connections: [handoff],
    connectors: [github],
    services: [workshop],
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
    services: sortById(config.services),
  };
}

describe("department hours", () => {
  it("carries a department's own working hours through the file", () => {
    const config = sampleConfig();
    const withHours: OfficeConfig = {
      ...config,
      departments: config.departments.map((d, i) =>
        i === 0
          ? {
              ...d,
              schedule: {
                kind: "windows" as const,
                timezone: "Asia/Nicosia",
                windows: [{ days: ["mon" as const], start: "09:00", end: "17:00" }],
              },
            }
          : d,
      ),
    };
    const reloaded = unwrap(importOfficeYaml(exportOfficeYaml(withHours), deps));
    expect(reloaded.departments[0]?.schedule).toEqual(withHours.departments[0]?.schedule);
  });
});

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
    services: fc.uniqueArray(
      fc.record({
        name: kebab,
        local: fc.boolean(),
        priced: fc.boolean(),
      }),
      { maxLength: 3, selector: (s) => s.name },
    ),
    employees: fc.array(
      fc.record({
        name: label,
        role: label,
        deptIndex: fc.nat(),
        skills: fc.uniqueArray(word, { maxLength: 3 }),
        // A paragraph, as somebody would type one: newlines and all.
        instructions: fc.option(fc.lorem({ maxCount: 12, mode: "sentences" }), { nil: undefined }),
        understudy: fc.option(
          fc.record({
            person: fc.lorem({ maxCount: 2 }),
            recordedBy: fc.lorem({ maxCount: 2 }),
            card: fc.option(fc.lorem({ maxCount: 30, mode: "sentences" }), { nil: undefined }),
            enabled: fc.boolean(),
          }),
          { nil: undefined },
        ),
        examples: fc.array(
          fc.record({
            when: fc.option(fc.lorem({ maxCount: 4 }), { nil: undefined }),
            good: fc.lorem({ maxCount: 20, mode: "sentences" }),
          }),
          { maxLength: 3 },
        ),
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
            ...(e.instructions === undefined ? {} : { instructions: e.instructions }),
            ...(e.understudy === undefined
              ? {}
              : {
                  understudy: {
                    person: e.understudy.person,
                    recordedBy: e.understudy.recordedBy,
                    enabled: e.understudy.enabled,
                    ...(e.understudy.card === undefined ? {} : { card: e.understudy.card }),
                  },
                }),
            examples: e.examples.map((one) =>
              one.when === undefined ? { good: one.good } : { when: one.when, good: one.good },
            ),
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
    const services: LlmService[] = [];
    g.services.forEach((svc, i) => {
      const r = createLlmService(
        {
          officeId,
          kind: "openai-compatible",
          name: svc.name,
          baseUrl: svc.local ? "http://localhost:11434/v1" : "https://api.openai.com/v1",
          ...(svc.local ? {} : { tokenEnv: "OPENAI_API_KEY" }),
          models: [
            {
              id: "a-model",
              ...(svc.priced ? { pricing: { inputPerMTok: 1, outputPerMTok: 2 } } : {}),
            },
          ],
        },
        services,
        mk(`s${String(i)}` as LlmServiceId),
      );
      if (r.ok) services.push(r.value);
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
    return { office, departments, employees, connections, connectors, services };
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

describe("standing priority in an office file", () => {
  const YAML = `
version: 1
office:
  id: office-1
  name: Acme
  priority: high
departments:
  - id: dept-eng
    name: Engineering
    color: "#3366ff"
    position: { x: 0, y: 0 }
    priority: urgent
employees:
  - id: emp-ada
    department: dept-eng
    name: Ada
    role: Engineer
    color: "#00aa66"
    priority: low
    llm: { provider: anthropic, model: claude-sonnet-5 }
`;

  it("reads a priority for the office, a department and a person", () => {
    const config = unwrap(importOfficeYaml(YAML, deps));
    expect(config.office.priority).toBe("high");
    expect(at(config.departments, 0).priority).toBe("urgent");
    expect(at(config.employees, 0).priority).toBe("low");
  });

  it("defaults each of them to normal when the file is silent", () => {
    const plain = YAML.replace(/^ *priority: .*$/gm, "");
    const config = unwrap(importOfficeYaml(plain, deps));
    expect(config.office.priority).toBe("normal");
    expect(at(config.departments, 0).priority).toBe("normal");
    expect(at(config.employees, 0).priority).toBe("normal");
  });

  it("refuses a priority that is not one, naming the file's own key", () => {
    const bad = YAML.replace("priority: urgent", "priority: asap");
    const result = importOfficeYaml(bad, deps);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((error) => error.path.includes("priority"))).toBe(true);
    }
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));
    expect(again.office.priority).toBe("high");
    expect(at(again.departments, 0).priority).toBe("urgent");
    expect(at(again.employees, 0).priority).toBe("low");
  });

  it("keeps a default out of the file, so nothing gains noise by being exported", () => {
    const plain = unwrap(importOfficeYaml(YAML.replace(/^ *priority: .*$/gm, ""), deps));
    expect(exportOfficeYaml(plain)).not.toContain("priority");
  });
});

describe("a department's definition of done in an office file", () => {
  const YAML = `
version: 1
office:
  id: office-1
  name: Acme
departments:
  - id: dept-eng
    name: Engineering
    color: "#3366ff"
    position: { x: 0, y: 0 }
    definitionOfDone:
      - the tests cover the error path
      - nothing was left commented out
`;

  it("reads what the department expects of everything it makes", () => {
    const config = unwrap(importOfficeYaml(YAML, deps));
    expect(at(config.departments, 0).definitionOfDone).toEqual([
      "the tests cover the error path",
      "nothing was left commented out",
    ]);
  });

  it("expects nothing when the file says nothing", () => {
    const silent = YAML.replace(/ *definitionOfDone:[\s\S]*$/, "");
    expect(at(unwrap(importOfficeYaml(silent, deps)).departments, 0).definitionOfDone).toEqual([]);
  });

  it("refuses an entry that is not text, rather than dropping it", () => {
    const bad = YAML.replace("- nothing was left commented out", "- { not: text }");
    expect(isErr(importOfficeYaml(bad, deps))).toBe(true);
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));
    expect(at(again.departments, 0).definitionOfDone).toEqual(
      at(once.departments, 0).definitionOfDone,
    );
  });

  it("keeps an empty list out of the file, so nothing gains noise", () => {
    const silent = unwrap(importOfficeYaml(YAML.replace(/ *definitionOfDone:[\s\S]*$/, ""), deps));
    expect(exportOfficeYaml(silent)).not.toContain("definitionOfDone");
  });
});

describe("an arrow switched off in an office file", () => {
  const YAML = `
version: 1
office:
  id: office-1
  name: Acme
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 } }
  - { id: dept-b, name: B, color: "#cc3366", position: { x: 600, y: 0 } }
connections:
  - { id: conn-1, from: dept-a, to: dept-b, kind: handoff, enabled: false }
  - id: conn-2
    from: dept-b
    to: dept-a
    kind: watches
    rules: { for: [work_went_wrong] }
`;

  it("reads that the arrow is off", () => {
    const config = unwrap(importOfficeYaml(YAML, deps));
    expect(at(config.connections, 0).enabled).toBe(false);
  });

  it("leaves an arrow on when the file says nothing", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).connections, 1).enabled).toBe(true);
  });

  it("reads what a watching arrow is pointed at", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).connections, 1).rules).toEqual({
      for: ["work_went_wrong"],
    });
  });

  it("refuses a moment nobody has heard of, on the way in", () => {
    const bad = YAML.replace("work_went_wrong", "work_vanished");
    expect(isErr(importOfficeYaml(bad, deps))).toBe(true);
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));
    expect(at(again.connections, 0).enabled).toBe(false);
    expect(at(again.connections, 1).rules).toEqual({ for: ["work_went_wrong"] });
  });

  it("keeps an arrow that is simply on out of the file", () => {
    const on = `
version: 1
office: { id: office-1, name: Acme }
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 } }
  - { id: dept-b, name: B, color: "#cc3366", position: { x: 600, y: 0 } }
connections:
  - { id: conn-1, from: dept-a, to: dept-b, kind: handoff }
`;
    expect(exportOfficeYaml(unwrap(importOfficeYaml(on, deps)))).not.toContain("enabled");
  });
});

describe("what a department may reach, in the office file", () => {
  const office = (departmentTools: string, connectors = CONNECTORS_YAML): string => `
version: 1
office:
  id: office-1
  name: Acme
${connectors}
departments:
  - id: dept-design
    name: Design
    color: "#7c5cff"
    position: { x: 0, y: 0 }
${departmentTools}
employees: []
connections: []
`;

  const CONNECTORS_YAML = `connectors:
  - id: conn-web
    kind: rest
    name: web
    tools: [fetch_url]`;

  it("reads the tools a whole room may call", () => {
    const config = unwrap(
      importOfficeYaml(
        office("    tools:\n      - { connector: conn-web, tool: fetch_url }"),
        deps,
      ),
    );
    expect(config.departments[0]?.toolGrants).toEqual([
      { connectorId: "conn-web", tool: "fetch_url" },
    ]);
  });

  it("gives a room none when it says nothing", () => {
    expect(unwrap(importOfficeYaml(office(""), deps)).departments[0]?.toolGrants).toEqual([]);
  });

  it("refuses a grant naming a connector this office does not have", () => {
    const refused = importOfficeYaml(
      office("    tools:\n      - { connector: conn-nope, tool: fetch_url }"),
      deps,
    );
    if (!isErr(refused)) throw new Error("expected this office to be refused");
    expect(refused.error.map((problem) => problem.path)).toContain(
      "departments[0].tools[0].connector",
    );
  });

  it("refuses a grant naming a tool the connector does not have", () => {
    const refused = importOfficeYaml(
      office("    tools:\n      - { connector: conn-web, tool: send_email }"),
      deps,
    );
    if (!isErr(refused)) throw new Error("expected this office to be refused");
    expect(refused.error.map((problem) => problem.path)).toContain("departments[0].tools[0].tool");
  });

  it("allows a wildcard, which names no particular tool", () => {
    const config = unwrap(
      importOfficeYaml(office("    tools:\n      - { connector: conn-web, tool: '*' }"), deps),
    );
    expect(config.departments[0]?.toolGrants).toEqual([{ connectorId: "conn-web", tool: "*" }]);
  });

  it("writes them back out under the same key it read them from", () => {
    const config = unwrap(
      importOfficeYaml(
        office("    tools:\n      - { connector: conn-web, tool: fetch_url }"),
        deps,
      ),
    );
    const yaml = exportOfficeYaml(config);

    expect(yaml).toContain("connector: conn-web");
    expect(unwrap(importOfficeYaml(yaml, deps)).departments[0]?.toolGrants).toEqual(
      config.departments[0]?.toolGrants,
    );
  });
});

describe("an office or a room stopped, in the office file", () => {
  const YAML = `
version: 1
office:
  id: office-1
  name: Acme
  runState: paused
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 }, runState: paused }
  - { id: dept-b, name: B, color: "#cc3366", position: { x: 600, y: 0 } }
`;

  it("reads that the office is stopped", () => {
    expect(unwrap(importOfficeYaml(YAML, deps)).office.runState).toBe("paused");
  });

  it("reads that a room is stopped", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).departments, 0).runState).toBe("paused");
  });

  it("leaves one running when the file says nothing", () => {
    // Every office file written before this switch existed has to keep working.
    expect(at(unwrap(importOfficeYaml(YAML, deps)).departments, 1).runState).toBe("running");
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));

    expect(again.office.runState).toBe("paused");
    expect(at(again.departments, 0).runState).toBe("paused");
    expect(at(again.departments, 1).runState).toBe("running");
  });

  it("keeps something that is simply running out of the file", () => {
    // A default on every entity in every file says nothing, exactly as with
    // priority and a switched-on arrow.
    const running = `
version: 1
office: { id: office-1, name: Acme }
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 } }
`;
    expect(exportOfficeYaml(unwrap(importOfficeYaml(running, deps)))).not.toContain("runState");
  });

  it("refuses a run state nobody has heard of", () => {
    expect(
      isErr(importOfficeYaml(YAML.replace("runState: paused", "runState: asleep"), deps)),
    ).toBe(true);
  });

  it("says which department had the bad run state", () => {
    const bad = YAML.replace(", runState: paused }", ", runState: dozing }");
    const result = importOfficeYaml(bad, deps);
    expect(isErr(result) && result.error.some((e) => e.path.includes("departments[0]"))).toBe(true);
  });
});

describe("a bench in an office file", () => {
  const YAML = `
version: 1
office: { id: office-1, name: Acme }
departments:
  - id: dept-design
    name: Design
    color: "#3366ff"
    position: { x: 0, y: 0 }
    benches:
      - { id: bench-draft, name: Drafting, members: [emp-iris, emp-theo] }
  - { id: dept-eng, name: Engineering, color: "#cc3366", position: { x: 600, y: 0 } }
employees:
  - { id: emp-iris, name: Iris, role: Designer, color: "#00aa66", department: dept-design, llm: { provider: anthropic, model: claude-sonnet-5 } }
  - { id: emp-theo, name: Theo, role: Designer, color: "#7c5cff", department: dept-design, llm: { provider: anthropic, model: claude-opus-5 } }
`;

  it("reads the bench and who is on it", () => {
    const design = at(unwrap(importOfficeYaml(YAML, deps)).departments, 0);
    expect(design.benches).toEqual([
      {
        id: "bench-draft",
        name: "Drafting",
        memberIds: ["emp-iris", "emp-theo"],
        strategy: "round_robin",
        judgeId: null,
      },
    ]);
  });

  it("leaves a department that says nothing with no benches", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).departments, 1).benches).toEqual([]);
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));
    expect(at(again.departments, 0).benches[0]?.memberIds).toEqual(["emp-iris", "emp-theo"]);
  });

  it("keeps a department with no benches out of the file", () => {
    const plain = `
version: 1
office: { id: office-1, name: Acme }
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 } }
`;
    expect(exportOfficeYaml(unwrap(importOfficeYaml(plain, deps)))).not.toContain("benches");
  });

  it("refuses a bench holding somebody who works elsewhere", () => {
    // The cross-check an office file can afford, as it already does for tools.
    const wrong = YAML.replace("emp-theo]", "emp-nobody]");
    expect(isErr(importOfficeYaml(wrong, deps))).toBe(true);
  });

  it("refuses a strategy nobody has heard of", () => {
    const wrong = YAML.replace("name: Drafting,", "name: Drafting, strategy: vibes,");
    expect(isErr(importOfficeYaml(wrong, deps))).toBe(true);
  });

  it("reads a shootout and who judges it", () => {
    const shootout = YAML.replace(
      "name: Drafting,",
      "name: Drafting, strategy: shootout, judge: emp-ada,",
    ).replace(
      "employees:",
      'employees:\n  - { id: emp-ada, name: Ada, role: Lead, color: "#112233", department: dept-eng, llm: { provider: anthropic, model: claude-opus-5 } }',
    );
    const design = at(unwrap(importOfficeYaml(shootout, deps)).departments, 0);

    expect(design.benches[0]?.strategy).toBe("shootout");
    expect(design.benches[0]?.judgeId).toBe("emp-ada");
  });

  it("carries a shootout and its judge back out to the file", () => {
    // A round robin bench writes no strategy, because a default on every bench
    // in every file says nothing — so a shootout has to write both of these.
    const shootout = YAML.replace(
      "members: [emp-iris, emp-theo]",
      "members: [emp-iris], strategy: shootout, judge: emp-theo",
    );
    const written = exportOfficeYaml(unwrap(importOfficeYaml(shootout, deps)));

    expect(written).toContain("shootout");
    expect(written).toContain("judge: emp-theo");
    const again = unwrap(importOfficeYaml(written, deps));
    expect(at(again.departments, 0).benches[0]?.judgeId).toBe("emp-theo");
  });

  it("keeps a bench nobody judges out of the file", () => {
    expect(exportOfficeYaml(unwrap(importOfficeYaml(YAML, deps)))).not.toContain("judge");
  });

  it("refuses a judge who is on the bench being judged", () => {
    const rigged = YAML.replace("name: Drafting,", "name: Drafting, judge: emp-iris,");
    expect(isErr(importOfficeYaml(rigged, deps))).toBe(true);
  });

  it("refuses a judge who does not work in this office", () => {
    const wrong = YAML.replace("name: Drafting,", "name: Drafting, judge: emp-nobody,");
    expect(isErr(importOfficeYaml(wrong, deps))).toBe(true);
  });
});

describe("budgets in an office file", () => {
  const YAML = `
version: 1
office:
  id: office-1
  name: Acme
  budget: { limitUsd: 100, warnAtUsd: 80, period: month }
departments:
  - id: dept-design
    name: Design
    color: "#3366ff"
    position: { x: 0, y: 0 }
    budget: { limitUsd: 20, period: day }
  - { id: dept-eng, name: Engineering, color: "#cc3366", position: { x: 600, y: 0 } }
employees:
  - id: emp-iris
    name: Iris
    role: Designer
    color: "#00aa66"
    department: dept-design
    llm: { provider: anthropic, model: claude-sonnet-5 }
    budget: { limitUsd: 5, period: day }
`;

  it("reads the office's budget", () => {
    expect(unwrap(importOfficeYaml(YAML, deps)).office.budget).toEqual({
      limitUsd: 100,
      warnAtUsd: 80,
      period: "month",
    });
  });

  it("reads a department's, warning at the limit when none was named", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).departments, 0).budget).toEqual({
      limitUsd: 20,
      warnAtUsd: null,
      period: "day",
    });
  });

  it("reads a person's", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).employees, 0).budget?.limitUsd).toBe(5);
  });

  it("leaves a level that says nothing with no ceiling", () => {
    expect(at(unwrap(importOfficeYaml(YAML, deps)).departments, 1).budget).toBeNull();
  });

  it("survives a round trip through the file and back", () => {
    const once = unwrap(importOfficeYaml(YAML, deps));
    const again = unwrap(importOfficeYaml(exportOfficeYaml(once), deps));

    expect(again.office.budget).toEqual({ limitUsd: 100, warnAtUsd: 80, period: "month" });
    expect(at(again.departments, 0).budget?.limitUsd).toBe(20);
    expect(at(again.employees, 0).budget?.limitUsd).toBe(5);
  });

  it("keeps a level with no budget out of the file", () => {
    const plain = `
version: 1
office: { id: office-1, name: Acme }
departments:
  - { id: dept-a, name: A, color: "#3366ff", position: { x: 0, y: 0 } }
`;
    expect(exportOfficeYaml(unwrap(importOfficeYaml(plain, deps)))).not.toContain("budget");
  });

  it("refuses a warning above the limit", () => {
    const wrong = YAML.replace("warnAtUsd: 80", "warnAtUsd: 180");
    expect(isErr(importOfficeYaml(wrong, deps))).toBe(true);
  });

  it("refuses a period nobody has heard of", () => {
    expect(isErr(importOfficeYaml(YAML.replace("period: day", "period: fortnight"), deps))).toBe(
      true,
    );
  });
});

describe("the services an office can call a model on", () => {
  const file = (services: string): string => `
version: 1
office:
  name: Tiny
departments: []
employees: []
connections: []
${services}
`;

  it("reads a local server with no key at all, which is why the block exists", () => {
    // `vo run office.yaml` against a model on this machine should need nothing
    // in the environment: no key to name, and none to keep.
    const config = unwrap(
      importOfficeYaml(
        file(`services:
  - id: svc-local
    kind: openai-compatible
    name: workshop
    baseUrl: http://localhost:11434/v1
    models:
      - id: qwen3-coder`),
        deps,
      ),
    );

    expect(config.services).toEqual([
      expect.objectContaining({
        id: "svc-local",
        name: "workshop",
        baseUrl: "http://localhost:11434/v1",
        tokenEnv: null,
        secretRef: null,
        models: [{ id: "qwen3-coder" }],
      }),
    ]);
  });

  it("reads the variable that holds a key, and what a model costs", () => {
    const config = unwrap(
      importOfficeYaml(
        file(`services:
  - id: svc-openai
    kind: openai-compatible
    name: openai
    baseUrl: https://api.openai.com/v1
    tokenEnv: OPENAI_API_KEY
    models:
      - id: gpt-5
        displayName: GPT-5
        contextWindow: 400000
        pricing: { inputPerMTok: 1.25, outputPerMTok: 10 }`),
        deps,
      ),
    );

    expect(config.services[0]?.tokenEnv).toBe("OPENAI_API_KEY");
    expect(config.services[0]?.models[0]).toEqual({
      id: "gpt-5",
      displayName: "GPT-5",
      contextWindow: 400_000,
      pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
    });
  });

  it("gives an office none when it says nothing", () => {
    expect(unwrap(importOfficeYaml(file(""), deps)).services).toEqual([]);
  });

  it("says where the trouble is, in the file's own words", () => {
    const bad = importOfficeYaml(
      file(`services:
  - id: svc-bad
    kind: openai-compatible
    name: Open AI
    baseUrl: http://api.openai.com/v1`),
      deps,
    );

    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) {
      expect(bad.error.map((e) => e.path)).toEqual(["services[0].name", "services[0].baseUrl"]);
      expect(bad.error[0]?.line).toBeGreaterThan(0);
    }
  });

  it("refuses two services with the same id, which would silently lose one", () => {
    const bad = importOfficeYaml(
      file(`services:
  - id: svc-1
    kind: anthropic
    name: one
  - id: svc-1
    kind: anthropic
    name: two`),
      deps,
    );

    expect(isErr(bad)).toBe(true);
  });

  it("never writes a key out, because a file is a thing people paste", () => {
    const yaml = exportOfficeYaml(sampleConfig());

    expect(yaml).toContain("services:");
    expect(yaml).not.toMatch(/sk-[a-z]/);
  });
});

describe("what an office file says about how somebody works", () => {
  const file = (employee: string): string => `
version: 1
office:
  name: Tiny
departments:
  - id: dept-support
    name: Support
    color: "#3366ff"
    position: { x: 0, y: 0 }
employees:
  - id: emp-sam
    department: dept-support
    name: Sam
    role: Clerk
    color: "#00aa66"
    llm: { provider: anthropic, model: claude-sonnet-5 }
${employee}
connections: []
`;

  it("reads a paragraph of standing instructions", () => {
    const config = unwrap(
      importOfficeYaml(
        file(`    instructions: |
      Always check the order number against the shipping system before replying.
      Never promise a date we have not confirmed.`),
        deps,
      ),
    );

    expect(config.employees[0]?.instructions).toContain("order number");
    expect(config.employees[0]?.instructions).toContain("Never promise");
  });

  it("reads the examples somebody wrote down", () => {
    const config = unwrap(
      importOfficeYaml(
        file(`    examples:
      - when: an angry customer
        good: Thank you for flagging this.`),
        deps,
      ),
    );

    expect(config.employees[0]?.examples).toEqual([
      { when: "an angry customer", good: "Thank you for flagging this." },
    ]);
  });

  it("gives somebody neither when the file says nothing", () => {
    const config = unwrap(importOfficeYaml(file(""), deps));

    expect(config.employees[0]?.instructions).toBeNull();
    expect(config.employees[0]?.examples).toEqual([]);
  });

  it("says where the trouble is, in the file's own words", () => {
    const bad = importOfficeYaml(file(`    examples:\n      - when: nothing useful`), deps);

    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error[0]?.path).toBe("employees[0].examples[0].good");
  });

  it("writes nothing about somebody who was told nothing", () => {
    // A file that gains two empty keys per person for a feature nobody used is
    // a file nobody wants to read.
    const yaml = exportOfficeYaml(unwrap(importOfficeYaml(file(""), deps)));

    expect(yaml).not.toContain("instructions");
    expect(yaml).not.toContain("examples");
  });
});

describe("what an office file says about standing in for somebody", () => {
  const file = (employee: string): string => `
version: 1
office:
  name: Tiny
departments:
  - id: dept-support
    name: Support
    color: "#3366ff"
    position: { x: 0, y: 0 }
employees:
  - id: emp-sam
    department: dept-support
    name: Sam
    role: Clerk
    color: "#00aa66"
    llm: { provider: anthropic, model: claude-sonnet-5 }
${employee}
connections: []
`;

  it("reads who somebody stands in for, and who said so", () => {
    const config = unwrap(
      importOfficeYaml(
        file(`    understudy:
      person: Anna Petrova
      recordedBy: anton@acme.test
      card: Opens with the first name. Never uses bullets.`),
        deps,
      ),
    );

    expect(config.employees[0]?.understudy).toMatchObject({
      person: "Anna Petrova",
      recordedBy: "anton@acme.test",
      enabled: true,
      card: "Opens with the first name. Never uses bullets.",
    });
  });

  it("refuses a voice nobody recorded, in the file's own words", () => {
    const bad = importOfficeYaml(file(`    understudy:\n      person: Anna Petrova`), deps);

    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error[0]?.path).toBe("employees[0].understudy.recordedBy");
  });

  it("gives somebody no voice when the file says nothing", () => {
    expect(unwrap(importOfficeYaml(file(""), deps)).employees[0]?.understudy).toBeNull();
  });

  it("writes nothing about an employee who stands in for nobody", () => {
    const yaml = exportOfficeYaml(unwrap(importOfficeYaml(file(""), deps)));

    expect(yaml).not.toContain("understudy");
  });

  it("never writes a correction out, because a file is a thing people paste", () => {
    // What the real person changed is theirs, and an office file is passed
    // around. The card is the office's own words about a voice; the drafts
    // behind it are not.
    const config = unwrap(
      importOfficeYaml(
        file(`    understudy:
      person: Anna Petrova
      recordedBy: anton@acme.test`),
        deps,
      ),
    );
    const employee = config.employees[0];
    if (employee === undefined) throw new Error("expected somebody");
    const corrected = unwrap(
      recordCorrection(
        employee,
        { before: "Dear Sir or Madam,", after: "Hi Tom," },
        { now: () => t0 },
      ),
    );

    const yaml = exportOfficeYaml({ ...config, employees: [corrected] });

    expect(yaml).toContain("understudy");
    expect(yaml).not.toContain("Dear Sir or Madam");
    expect(yaml).not.toContain("corrections");
  });
});
