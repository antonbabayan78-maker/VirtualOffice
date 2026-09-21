#!/usr/bin/env node
/**
 * TDD guard.
 *
 * Rule: a production source file under `packages/<name>/src` or `apps/<name>/src`
 * may only change together with at least one `*.test.ts` change in the same package.
 *
 * Usage:
 *   node tooling/scripts/tdd-guard.ts                 # checks staged files (pre-commit)
 *   node tooling/scripts/tdd-guard.ts --base origin/main   # checks base...HEAD (CI on PRs)
 *
 * The evaluation is a pure function so it can be unit-tested with fixture file lists.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

export interface Violation {
  package: string;
  sources: string[];
}

export interface GuardResult {
  ok: boolean;
  violations: Violation[];
}

const PACKAGE_ROOT = /^((?:packages|apps)\/[^/]+)\//;
const SRC_FILE = /^(?:packages|apps)\/[^/]+\/src\/.+\.ts$/;

export function packageOf(file: string): string | null {
  const match = PACKAGE_ROOT.exec(file);
  return match?.[1] ?? null;
}

export function isTestFile(file: string): boolean {
  return file.endsWith(".test.ts");
}

export function isProductionSource(file: string): boolean {
  if (!SRC_FILE.test(file)) return false;
  if (isTestFile(file)) return false;
  if (file.endsWith(".d.ts")) return false;
  if (file.endsWith(".config.ts")) return false;
  return true;
}

export function evaluateChangedFiles(changed: readonly string[]): GuardResult {
  const sourcesByPackage = new Map<string, string[]>();
  const packagesWithTests = new Set<string>();

  for (const file of changed) {
    const pkg = packageOf(file);
    if (pkg === null) continue;
    if (isTestFile(file)) {
      packagesWithTests.add(pkg);
    } else if (isProductionSource(file)) {
      const list = sourcesByPackage.get(pkg) ?? [];
      list.push(file);
      sourcesByPackage.set(pkg, list);
    }
  }

  const violations: Violation[] = [];
  for (const [pkg, sources] of [...sourcesByPackage.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!packagesWithTests.has(pkg)) {
      violations.push({ package: pkg, sources: [...sources].sort() });
    }
  }
  return { ok: violations.length === 0, violations };
}

function changedFiles(base: string | undefined): string[] {
  const args = base
    ? ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]
    : ["diff", "--cached", "--name-only", "--diff-filter=ACMR"];
  const out = execFileSync("git", args, { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatReport(result: GuardResult): string {
  if (result.ok)
    return "tdd-guard: ok (every changed source file has a test change in its package)";
  const lines = [
    "tdd-guard: FAILED. Production code changed without a test change in the same package:",
  ];
  for (const v of result.violations) {
    lines.push(`  ${v.package}`);
    for (const s of v.sources) lines.push(`    - ${s}`);
  }
  lines.push("");
  lines.push(
    "Write the failing test first, then the implementation. Both belong in the same change.",
  );
  return lines.join("\n");
}

function main(argv: string[]): number {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
  const result = evaluateChangedFiles(changedFiles(base));
  console.log(formatReport(result));
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]?.endsWith("tdd-guard.ts") ?? false;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
