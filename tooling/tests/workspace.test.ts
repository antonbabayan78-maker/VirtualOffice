/**
 * Workspace conformance test.
 *
 * This is the executable definition of "the monorepo is scaffolded correctly".
 * Every workspace package must be a strict-TypeScript, testable, lintable unit,
 * and the repo must enforce TDD via a pre-commit hook.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
  engines?: Record<string, string>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listWorkspacePackageDirs(): string[] {
  const workspace = parseYaml(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8")) as {
    packages: string[];
  };
  const dirs: string[] = [];
  for (const pattern of workspace.packages) {
    if (pattern.endsWith("/*")) {
      const parent = join(ROOT, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent)) {
        const dir = join(parent, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
    } else if (existsSync(join(ROOT, pattern, "package.json"))) {
      dirs.push(join(ROOT, pattern));
    }
  }
  return dirs;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const EXPECTED_PACKAGES = [
  "packages/core",
  "packages/orchestrator",
  "packages/llm",
  "packages/connectors",
  "packages/memory",
  "packages/skills",
  "packages/storage",
  "packages/telemetry",
  "packages/notifications",
  "apps/server",
  "apps/cli",
];

describe("monorepo root", () => {
  const rootPkg = readJson(join(ROOT, "package.json")) as PackageJson;

  it("pins the package manager to pnpm and requires Node 22+", () => {
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(rootPkg.engines?.["node"]).toMatch(/22/);
  });

  it("exposes test, lint, typecheck and build scripts", () => {
    for (const script of ["test", "lint", "typecheck", "build"]) {
      expect(rootPkg.scripts?.[script], `root script "${script}"`).toBeTruthy();
    }
  });

  it("has a strict TypeScript base config", () => {
    const base = readJson(join(ROOT, "tsconfig.base.json")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(base.compilerOptions["strict"]).toBe(true);
    expect(base.compilerOptions["noUncheckedIndexedAccess"]).toBe(true);
    expect(base.compilerOptions["verbatimModuleSyntax"]).toBe(true);
  });

  it("defines turbo tasks for build, typecheck, test and lint", () => {
    const turbo = readJson(join(ROOT, "turbo.json")) as { tasks: Record<string, unknown> };
    for (const task of ["build", "typecheck", "test", "lint"]) {
      expect(turbo.tasks[task], `turbo task "${task}"`).toBeDefined();
    }
  });

  it("has ESLint and Prettier configuration", () => {
    expect(existsSync(join(ROOT, "eslint.config.js"))).toBe(true);
    expect(existsSync(join(ROOT, ".prettierrc"))).toBe(true);
  });

  it("blocks commits that fail tests via a Husky pre-commit hook", () => {
    const hook = join(ROOT, ".husky", "pre-commit");
    expect(existsSync(hook), ".husky/pre-commit must exist").toBe(true);
    const body = readFileSync(hook, "utf8");
    expect(body).toMatch(/pnpm (run )?test/);
    expect(body).toMatch(/lint-staged/);
  });

  it("documents the TDD rule for contributors and agents", () => {
    const claudeMd = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/TDD/);
    expect(claudeMd).toMatch(/failing test/i);
  });
});

describe("workspace packages", () => {
  const dirs = listWorkspacePackageDirs();

  it("contains every planned package", () => {
    const relative = dirs.map((d) => d.slice(ROOT.length + 1)).sort();
    for (const expected of EXPECTED_PACKAGES) {
      expect(relative, `missing workspace package ${expected}`).toContain(expected);
    }
  });

  for (const dir of dirs) {
    const rel = dir.slice(ROOT.length + 1);
    if (rel === "tooling") continue;

    describe(rel, () => {
      const pkg = readJson(join(dir, "package.json")) as PackageJson;

      it("is a scoped, private ESM package", () => {
        expect(pkg.name).toMatch(/^@vo\/[a-z-]+$/);
        expect(pkg.private).toBe(true);
        expect(pkg.type).toBe("module");
      });

      it("exposes test, typecheck and build scripts", () => {
        for (const script of ["test", "typecheck", "build"]) {
          expect(pkg.scripts?.[script], `${rel} script "${script}"`).toBeTruthy();
        }
      });

      it("extends the strict base tsconfig", () => {
        const tsconfig = readJson(join(dir, "tsconfig.json")) as { extends?: string };
        expect(tsconfig.extends).toMatch(/tsconfig\.base\.json$/);
      });

      it("has a vitest project config", () => {
        expect(existsSync(join(dir, "vitest.config.ts"))).toBe(true);
      });

      it("has a src entry point and at least one test", () => {
        expect(existsSync(join(dir, "src", "index.ts"))).toBe(true);
        const tests = walk(join(dir, "src")).filter((f) => f.endsWith(".test.ts"));
        expect(tests.length, `${rel} must ship at least one test`).toBeGreaterThan(0);
      });
    });
  }
});
