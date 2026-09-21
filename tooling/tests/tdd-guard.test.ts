/**
 * TDD guard conformance test.
 *
 * The guard enforces the repo's core rule: production code in a package may only
 * change together with a test in the same package. It is a pure function over the
 * list of changed files, so it is trivially testable and used by CI on every PR.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { evaluateChangedFiles, packageOf } from "../scripts/tdd-guard.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("packageOf", () => {
  it("maps files under packages/* and apps/* to their package root", () => {
    expect(packageOf("packages/core/src/office.ts")).toBe("packages/core");
    expect(packageOf("apps/server/src/routes/tasks.ts")).toBe("apps/server");
  });

  it("returns null for files outside a workspace package", () => {
    expect(packageOf("tooling/tests/ci.test.ts")).toBeNull();
    expect(packageOf("README.md")).toBeNull();
    expect(packageOf(".github/workflows/ci.yml")).toBeNull();
  });
});

describe("evaluateChangedFiles", () => {
  it("fails when a source file changes without any test change in the same package", () => {
    const result = evaluateChangedFiles(["packages/core/src/office.ts"]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { package: "packages/core", sources: ["packages/core/src/office.ts"] },
    ]);
  });

  it("passes when a source file changes together with a test in the same package", () => {
    const result = evaluateChangedFiles([
      "packages/core/src/office.ts",
      "packages/core/src/office.test.ts",
    ]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("does not let a test in another package cover a source change", () => {
    const result = evaluateChangedFiles([
      "packages/core/src/office.ts",
      "packages/llm/src/registry.test.ts",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.package)).toEqual(["packages/core"]);
  });

  it("passes when only tests change", () => {
    expect(evaluateChangedFiles(["packages/core/src/office.test.ts"]).ok).toBe(true);
  });

  it("passes when nothing under a package src changes", () => {
    const result = evaluateChangedFiles([
      "README.md",
      "tooling/tests/ci.test.ts",
      ".github/workflows/ci.yml",
      "packages/core/package.json",
      "packages/core/tsconfig.json",
    ]);
    expect(result.ok).toBe(true);
  });

  it("ignores declaration files and config files inside src", () => {
    const result = evaluateChangedFiles([
      "packages/core/src/types.d.ts",
      "packages/core/vitest.config.ts",
    ]);
    expect(result.ok).toBe(true);
  });

  it("reports every offending package with its source files", () => {
    const result = evaluateChangedFiles([
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
      "apps/cli/src/main.ts",
      "packages/llm/src/x.ts",
      "packages/llm/src/x.test.ts",
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { package: "apps/cli", sources: ["apps/cli/src/main.ts"] },
      { package: "packages/core", sources: ["packages/core/src/a.ts", "packages/core/src/b.ts"] },
    ]);
  });
});

describe("policy artifacts", () => {
  it("ships a pull request template that asks for test-first evidence", () => {
    const path = join(ROOT, ".github", "pull_request_template.md");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/failing test/i);
    expect(body).toMatch(/Notion/);
    expect(body).toMatch(/- \[ \]/);
  });

  it("ships CONTRIBUTING.md describing the red-green-refactor loop and the guard", () => {
    const body = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(body).toMatch(/red/i);
    expect(body).toMatch(/green/i);
    expect(body).toMatch(/refactor/i);
    expect(body).toMatch(/tdd-guard/);
  });

  it("runs the guard in CI on pull requests against the base branch", () => {
    const ci = parseYaml(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: Record<
        string,
        { steps: { run?: string; if?: string; with?: Record<string, unknown> }[] }
      >;
    };
    const steps = Object.values(ci.jobs).flatMap((j) => j.steps);
    const guard = steps.find((s) => s.run?.includes("pnpm tdd-guard"));
    expect(guard, "a step running pnpm tdd-guard").toBeDefined();
    expect(guard?.if).toMatch(/pull_request/);
    expect(guard?.run).toMatch(/github\.base_ref/);
    const checkout = steps.find((s) => s.with?.["fetch-depth"] !== undefined);
    expect(checkout?.with?.["fetch-depth"], "full history so the diff against base works").toBe(0);
  });

  it("exposes a root tdd-guard script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["tdd-guard"]).toBeTruthy();
  });
});
