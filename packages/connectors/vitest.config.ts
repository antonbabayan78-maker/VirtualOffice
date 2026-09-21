import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/connectors",
    include: ["src/**/*.test.ts"],
  },
});
