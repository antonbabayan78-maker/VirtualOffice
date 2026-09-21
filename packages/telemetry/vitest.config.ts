import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/telemetry",
    include: ["src/**/*.test.ts"],
  },
});
