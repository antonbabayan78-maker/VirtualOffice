import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/api-client",
    include: ["src/**/*.test.ts"],
  },
});
