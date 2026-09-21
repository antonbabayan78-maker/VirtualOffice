import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/memory",
    include: ["src/**/*.test.ts"],
  },
});
