import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/storage",
    include: ["src/**/*.test.ts"],
  },
});
