import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/server",
    include: ["src/**/*.test.ts"],
  },
});
