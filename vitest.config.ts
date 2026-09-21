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
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
