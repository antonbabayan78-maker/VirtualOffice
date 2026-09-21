import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vo/llm",
    include: ["src/**/*.test.ts"],
  },
});
