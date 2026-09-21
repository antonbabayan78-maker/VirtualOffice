import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/orchestrator",
    include: ["src/**/*.test.ts"],
  },
});
