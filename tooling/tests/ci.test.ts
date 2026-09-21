/**
 * CI conformance test.
 *
 * Executable definition of the CI pipeline: every push and PR must run
 * typecheck, lint, tests with coverage, and the coverage gate for core packages
 * must be enforced. A nightly job runs mutation testing and publishes the report.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on": string;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown> | string[];
  jobs: Record<string, Job>;
}

function loadWorkflow(file: string): Workflow {
  const path = join(WORKFLOWS, file);
  expect(existsSync(path), `${file} must exist`).toBe(true);
  return parseYaml(readFileSync(path, "utf8")) as Workflow;
}

function lazy<T>(factory: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= factory());
}

function allSteps(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

function runCommands(workflow: Workflow): string[] {
  return allSteps(workflow)
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string");
}

describe("ci workflow", () => {
  const ci = lazy(() => loadWorkflow("ci.yml"));

  it("runs on pushes to main and on pull requests", () => {
    const on = ci().on as Record<string, unknown>;
    expect(on["push"]).toBeDefined();
    expect(on["pull_request"]).toBeDefined();
  });

  it("installs with pnpm using the lockfile", () => {
    const steps = allSteps(ci());
    expect(steps.some((s) => s.uses?.startsWith("pnpm/action-setup"))).toBe(true);
    expect(runCommands(ci()).some((r) => r.includes("pnpm install --frozen-lockfile"))).toBe(true);
  });

  it("runs typecheck, lint, format check and tests with coverage", () => {
    const cmds = runCommands(ci()).join("\n");
    expect(cmds).toMatch(/pnpm typecheck/);
    expect(cmds).toMatch(/pnpm lint/);
    expect(cmds).toMatch(/pnpm format:check/);
    expect(cmds).toMatch(/pnpm test:coverage/);
  });

  it("uploads the coverage report as an artifact", () => {
    const upload = allSteps(ci()).find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload).toBeDefined();
    expect(String(upload?.with?.["path"])).toMatch(/coverage/);
  });
});

describe("coverage gate", () => {
  it("enforces 90% on packages/core in the vitest coverage config", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/thresholds/);
    expect(config).toMatch(/packages\/core\/src\/\*\*/);
    for (const metric of ["lines", "functions", "branches", "statements"]) {
      expect(config, `core threshold for ${metric}`).toMatch(new RegExp(`${metric}:\\s*90`));
    }
  });
});

describe("nightly mutation testing", () => {
  const nightly = lazy(() => loadWorkflow("nightly.yml"));

  it("runs on a schedule and can be triggered manually", () => {
    const on = nightly().on as Record<string, unknown>;
    expect(on["schedule"]).toBeDefined();
    expect(on["workflow_dispatch"]).toBeDefined();
  });

  it("runs Stryker and uploads the mutation report as an artifact", () => {
    expect(runCommands(nightly()).some((r) => /pnpm (run )?mutation/.test(r))).toBe(true);
    const upload = allSteps(nightly()).find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload).toBeDefined();
    expect(String(upload?.with?.["path"])).toMatch(/mutation/);
  });

  it("has a Stryker config targeting core and orchestrator with the vitest runner", () => {
    const path = join(ROOT, "stryker.config.json");
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      testRunner: string;
      mutate: string[];
      reporters: string[];
    };
    expect(config.testRunner).toBe("vitest");
    expect(config.mutate.some((m) => m.includes("packages/core/src"))).toBe(true);
    expect(config.mutate.some((m) => m.includes("packages/orchestrator/src"))).toBe(true);
    expect(config.reporters).toContain("json");
  });
});
