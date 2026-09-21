import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@vo/core", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@vo/core");
  });
});
