import { describe, expect, it } from "vitest";
import { cn } from "./cn.js";

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("keeps the ones that are switched on and drops the rest", () => {
    const classes = (enabled: boolean): string => cn("a", enabled && "b", undefined, "c");
    expect(classes(false)).toBe("a c");
    expect(classes(true)).toBe("a b c");
  });

  it("lets the last of two conflicting utilities win", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
