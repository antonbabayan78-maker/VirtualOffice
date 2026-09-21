import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/cli",
    include: ["src/**/*.test.ts"],
  },
});
