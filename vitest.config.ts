import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "tooling/vitest.config.ts",
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/*.test.ts"],
      // Coverage gate: packages/core carries the highest correctness bar (see plan §11).
      // Each key is checked independently against the files it matches.
      thresholds: {
        "packages/core/src/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
