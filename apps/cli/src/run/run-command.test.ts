import { describe, expect, it } from "vitest";
import { FakeLlmProvider, toolCall, type CompletionRequest } from "@vo/llm";
import { runCommand } from "./run-command.js";

const YAML = `
version: 1
office: { id: office-acme, name: Acme }
departments:
  - id: dept-eng
    name: Engineering
    color: "#3366ff"
    position: { x: 0, y: 0 }
    reviewPolicy: { kind: manager, maxIterations: 3 }
employees:
  - { id: emp-boss, department: dept-eng, name: Boss, role: Manager, color: "#ff8800", llm: { provider: anthropic, model: claude-sonnet-5 } }
  - { id: emp-ada, department: dept-eng, name: Ada, role: Engineer, color: "#00aa66", supervisor: emp-boss, llm: { provider: anthropic, model: claude-sonnet-5 } }
`;

const provider = (): FakeLlmProvider =>
  new FakeLlmProvider({
    id: "anthropic",
    handler: (request: CompletionRequest) =>
      (request.tools ?? []).some((t) => t.name === "review_verdict")
        ? toolCall("review_verdict", { approved: true, reason: "good" })
        : toolCall("submit_work", { summary: "done" }),
  });

function harness(yaml = YAML) {
  const lines: string[] = [];
  return {
    lines,
    output: () => lines.join("\n"),
    deps: {
      readFile: (path: string) =>
        path.endsWith("office.yaml")
          ? Promise.resolve(yaml)
          : Promise.reject(new Error(`no such file: ${path}`)),
      write: (line: string) => lines.push(line),
      provider: provider(),
      now: () => new Date("2026-09-28T09:00:00.000Z"),
    },
  };
}

describe("vo run", () => {
  it("runs the office and reports what happened", async () => {
    const h = harness();
    const code = await runCommand(["office.yaml", "--task", "Write the parser"], h.deps);

    expect(code).toBe(0);
    expect(h.output()).toMatch(/Acme/);
    expect(h.output()).toMatch(/Write the parser/);
    expect(h.output()).toMatch(/done/);
    // The report accounts for what it spent.
    expect(h.output()).toMatch(/\$/);
    expect(h.output()).toMatch(/emp-ada/);
  });

  it("names the employee the work went to and the one who reviewed it", async () => {
    const h = harness();
    await runCommand(["office.yaml", "--task", "Write the parser"], h.deps);
    expect(h.output()).toMatch(/Ada/);
    expect(h.output()).toMatch(/Boss/);
  });

  it("refuses without an office file", async () => {
    const h = harness();
    expect(await runCommand(["--task", "x"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/usage/i);
  });

  it("refuses without a task to do", async () => {
    const h = harness();
    expect(await runCommand(["office.yaml"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/--task/);
  });

  it("reports a file it cannot read rather than throwing", async () => {
    const h = harness();
    expect(await runCommand(["missing.yaml", "--task", "x"], h.deps)).toBe(1);
    expect(h.output()).toMatch(/no such file/);
  });

  it("reports every problem in a broken office file, with its line", async () => {
    const h = harness("version: 1\noffice: { id: o, name: '' }\ndepartments: []\nemployees: []\n");
    expect(await runCommand(["office.yaml", "--task", "x"], h.deps)).toBe(1);
    expect(h.output()).toMatch(/office\.name/);
  });

  it("refuses an office with nobody to do the work", async () => {
    const empty = `
version: 1
office: { id: office-acme, name: Acme }
departments:
  - { id: dept-eng, name: Engineering, color: "#3366ff", position: { x: 0, y: 0 } }
employees: []
`;
    const h = harness(empty);
    expect(await runCommand(["office.yaml", "--task", "x"], h.deps)).toBe(1);
    expect(h.output()).toMatch(/no active employee/i);
  });

  it("puts the work in the department that was asked for", async () => {
    const two = YAML.replace(
      "employees:",
      `  - { id: dept-ops, name: Ops, color: "#884400", position: { x: 300, y: 0 } }
employees:`,
    );
    const h = harness(two);
    const code = await runCommand(
      ["office.yaml", "--task", "Write the parser", "--department", "dept-eng"],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.output()).toMatch(/Engineering/);
  });
});
