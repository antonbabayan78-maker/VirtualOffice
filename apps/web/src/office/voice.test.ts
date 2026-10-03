import { describe, expect, it } from "vitest";
import type { Employee } from "@vo/core";
import { voiceOf, inTheirVoice } from "./voice.js";

const sam = (overrides: Record<string, unknown> | null = null): Employee =>
  ({
    id: "emp-sam",
    name: "Sam",
    understudy:
      overrides === null
        ? null
        : {
            person: "Anna Petrova",
            recordedBy: "owner-1",
            recordedAt: new Date("2026-10-03T09:00:00Z"),
            enabled: true,
            card: "Opens with the first name.",
            cardMadeAt: new Date("2026-10-03T09:00:00Z"),
            cardFromSamples: 3,
            corrections: [],
            ...overrides,
          },
  }) as unknown as Employee;

describe("saying whose voice work is in", () => {
  it("names the person somebody stands in for", () => {
    expect(voiceOf(sam({}))).toBe("Anna Petrova");
  });

  it("names nobody for somebody who writes as themselves", () => {
    expect(voiceOf(sam())).toBeNull();
  });

  it("names nobody while the voice is switched off", () => {
    // The card is kept, and nothing is written in it, so nothing is labelled.
    expect(voiceOf(sam({ enabled: false }))).toBeNull();
  });

  it("names nobody before the office has studied them", () => {
    // Standing in for somebody with no card yet is an intention, not a voice:
    // the work reads as this employee's own because it is.
    expect(voiceOf(sam({ card: null }))).toBeNull();
  });

  it("names nobody at all when there is nobody to ask about", () => {
    expect(voiceOf(undefined)).toBeNull();
  });

  it("says it the one way, so three screens cannot word it differently", () => {
    expect(inTheirVoice(sam({}))).toBe("in Anna Petrova's voice");
    expect(inTheirVoice(sam())).toBeNull();
  });
});
