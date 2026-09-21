import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/skills",
    include: ["src/**/*.test.ts"],
  },
});
