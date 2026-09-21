import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/notifications",
    include: ["src/**/*.test.ts"],
  },
});
