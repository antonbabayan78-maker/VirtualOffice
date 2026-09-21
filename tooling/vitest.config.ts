import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/tooling",
    include: ["tests/**/*.test.ts"],
  },
});
