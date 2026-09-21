import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/core",
    include: ["src/**/*.test.ts"],
  },
});
