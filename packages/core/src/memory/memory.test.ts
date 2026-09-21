import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { isErr, unwrap } from "../shared/result.js";
import {
  canRead,
  canWrite,
  createMemoryItem,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  PRIVATE,
  updateMemoryContent,
  type MemoryItem,
  type MemoryItemId,
  type MemoryReader,
  type MemorySharing,
} from "./memory.js";

const office = "office-1" as OfficeId;
const otherOffice = "office-2" as OfficeId;
const eng = "dept-eng" as DepartmentId;
const sales = "dept-sales" as DepartmentId;
const ada = "emp-ada" as EmployeeId; // eng
const bob = "emp-bob" as EmployeeId; // eng
const cyd = "emp-cyd" as EmployeeId; // sales
const dan = "emp-dan" as EmployeeId; // sales
const t0 = new Date("2026-09-22T00:00:00Z");
const t1 = new Date("2026-09-23T00:00:00Z");
const deps = { id: () => "mem-1" as MemoryItemId, now: () => t0 };

const readers = {
  ada: { officeId: office, departmentId: eng, employeeId: ada },
  bob: { officeId: office, departmentId: eng, employeeId: bob },
  cyd: { officeId: office, departmentId: sales, employeeId: cyd },
  dan: { officeId: office, departmentId: sales, employeeId: dan },
  outsider: {
    officeId: otherOffice,
    departmentId: "dept-x" as DepartmentId,
    employeeId: "emp-x" as EmployeeId,
  },
} satisfies Record<string, MemoryReader>;

function item(
  scope: MemoryItem["scope"],
  ownerId: string,
  sharing: MemorySharing = PRIVATE,
): MemoryItem {
  return unwrap(
    createMemoryItem(
      { officeId: office, scope, ownerId, kind: "fact", content: "The API uses cursors.", sharing },
      deps,
    ),
  );
}

describe("createMemoryItem", () => {
  it("lists scopes and kinds", () => {
    expect(MEMORY_SCOPES).toEqual(["office", "department", "employee"]);
    expect(MEMORY_KINDS).toEqual(["fact", "procedure", "episode", "summary"]);
  });

  it("creates a private fact at version 1 with no ttl", () => {
    const m = item("employee", ada);
    expect(m).toEqual<MemoryItem>({
      id: "mem-1" as MemoryItemId,
      officeId: office,
      scope: "employee",
      ownerId: ada,
      kind: "fact",
      content: "The API uses cursors.",
      sharing: { office: false, departments: [], employees: [] },
      version: 1,
      expiresAt: null,
      createdAt: t0,
      updatedAt: t0,
    });
  });

  it("accepts an expiry and copies sharing lists", () => {
    const sharing = { office: false, departments: [sales], employees: [cyd] };
    const m = unwrap(
      createMemoryItem(
        {
          officeId: office,
          scope: "employee",
          ownerId: ada,
          kind: "episode",
          content: "x",
          sharing,
          expiresAt: t1,
        },
        deps,
      ),
    );
    expect(m.expiresAt).toEqual(t1);
    expect(m.sharing).toEqual(sharing);
    expect(m.sharing.departments).not.toBe(sharing.departments);
  });

  it("rejects unknown scope or kind, empty or over-long content, empty owner", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["scope", { scope: "team" }],
      ["kind", { kind: "rumor" }],
      ["content", { content: "  " }],
      ["content", { content: "x".repeat(50_001) }],
      ["ownerId", { ownerId: "" }],
    ];
    for (const [path, overrides] of cases) {
      const r = createMemoryItem(
        {
          officeId: office,
          scope: "employee",
          ownerId: ada,
          kind: "fact",
          content: "ok",
          ...overrides,
        },
        deps,
      );
      expect(isErr(r), JSON.stringify(overrides)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe(path);
    }
  });

  it("rejects duplicate ids in sharing lists and an invalid expiry", () => {
    const dupDept = createMemoryItem(
      {
        officeId: office,
        scope: "employee",
        ownerId: ada,
        kind: "fact",
        content: "ok",
        sharing: { office: false, departments: [sales, sales], employees: [] },
      },
      deps,
    );
    expect(isErr(dupDept)).toBe(true);
    if (isErr(dupDept)) expect(dupDept.error[0]?.path).toBe("sharing.departments");
    const dupEmp = createMemoryItem(
      {
        officeId: office,
        scope: "employee",
        ownerId: ada,
        kind: "fact",
        content: "ok",
        sharing: { office: false, departments: [], employees: [cyd, cyd] },
      },
      deps,
    );
    expect(isErr(dupEmp)).toBe(true);
    const badTtl = createMemoryItem(
      {
        officeId: office,
        scope: "employee",
        ownerId: ada,
        kind: "fact",
        content: "ok",
        expiresAt: new Date("nope"),
      },
      deps,
    );
    expect(isErr(badTtl)).toBe(true);
    if (isErr(badTtl)) expect(badTtl.error[0]?.path).toBe("expiresAt");
  });
});

describe("canRead: scope x sharing x reader matrix", () => {
  const share = {
    private: PRIVATE,
    department: { office: false, departments: [eng], employees: [] },
    otherDepartment: { office: false, departments: [sales], employees: [] },
    employees: { office: false, departments: [], employees: [cyd] },
    office: { office: true, departments: [], employees: [] },
  } satisfies Record<string, MemorySharing>;

  // rows: [scope, owner, sharing, expected readers]
  const matrix: [MemoryItem["scope"], string, keyof typeof share, string[]][] = [
    ["employee", ada, "private", ["ada"]],
    ["employee", ada, "department", ["ada", "bob"]],
    ["employee", ada, "otherDepartment", ["ada", "cyd", "dan"]],
    ["employee", ada, "employees", ["ada", "cyd"]],
    ["employee", ada, "office", ["ada", "bob", "cyd", "dan"]],
    ["department", eng, "private", ["ada", "bob"]],
    ["department", eng, "otherDepartment", ["ada", "bob", "cyd", "dan"]],
    ["department", eng, "employees", ["ada", "bob", "cyd"]],
    ["department", eng, "office", ["ada", "bob", "cyd", "dan"]],
    ["office", office, "private", ["ada", "bob", "cyd", "dan"]],
    ["office", office, "employees", ["ada", "bob", "cyd", "dan"]],
  ];

  for (const [scope, owner, sharingKey, expected] of matrix) {
    it(`${scope} memory owned by ${owner}, sharing=${sharingKey}: readable by ${expected.join(",")}`, () => {
      const m = item(scope, owner, share[sharingKey]);
      for (const [name, reader] of Object.entries(readers)) {
        expect(canRead(m, reader, t0), name).toBe(expected.includes(name));
      }
    });
  }

  it("never crosses office boundaries, even with office-wide sharing", () => {
    const m = item("office", office, share.office);
    expect(canRead(m, readers.outsider, t0)).toBe(false);
  });

  it("hides expired items from everyone including the owner", () => {
    const m = unwrap(
      createMemoryItem(
        {
          officeId: office,
          scope: "employee",
          ownerId: ada,
          kind: "fact",
          content: "x",
          sharing: share.office,
          expiresAt: t1,
        },
        deps,
      ),
    );
    expect(canRead(m, readers.ada, t0)).toBe(true);
    expect(canRead(m, readers.ada, t1)).toBe(false);
    expect(canRead(m, readers.bob, new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });
});

describe("canWrite", () => {
  it("employee memory: only the owner", () => {
    const m = item("employee", ada, { office: true, departments: [], employees: [] });
    expect(canWrite(m, readers.ada)).toBe(true);
    expect(canWrite(m, readers.bob)).toBe(false);
  });

  it("department memory: members of the department", () => {
    const m = item("department", eng, { office: true, departments: [], employees: [] });
    expect(canWrite(m, readers.bob)).toBe(true);
    expect(canWrite(m, readers.cyd)).toBe(false);
  });

  it("office memory: any employee of the office, never outsiders", () => {
    const m = item("office", office);
    expect(canWrite(m, readers.dan)).toBe(true);
    expect(canWrite(m, readers.outsider)).toBe(false);
  });
});

describe("updateMemoryContent", () => {
  it("bumps the version and updatedAt, keeps everything else, and does not mutate", () => {
    const m = item("employee", ada);
    const next = unwrap(updateMemoryContent(m, "The API uses keyset pagination.", t1));
    expect(next.version).toBe(2);
    expect(next.updatedAt).toEqual(t1);
    expect(next.content).toBe("The API uses keyset pagination.");
    expect(next.createdAt).toEqual(t0);
    expect(m.version).toBe(1);
  });

  it("rejects empty content", () => {
    expect(isErr(updateMemoryContent(item("employee", ada), "  ", t1))).toBe(true);
  });
});
