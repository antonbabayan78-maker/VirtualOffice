import { describe, expect, it } from "vitest";
import type { Correction } from "@vo/core";
import { CORRECTIONS_PREFIX, studyPrompt, type VoiceSample } from "./study.js";

const samples: VoiceSample[] = [
  { name: "reply-to-tom.txt", text: "Hi Tom,\n\nSorted — the parcel goes out today.\n\nAnna" },
  { name: "note.txt", text: "Quick one: the supplier moved the date again." },
];

const correction = (overrides: Partial<Correction> = {}): Correction => ({
  at: new Date("2026-10-03T09:00:00Z"),
  taskId: "task-1",
  before: "Dear Sir or Madam,",
  after: "Hi Tom,",
  ...overrides,
});

describe("studying how somebody writes", () => {
  it("asks for the manner and not the content", () => {
    // A card that carried a customer's name or an order number would put one
    // person's business into every prompt the office sends afterwards.
    const { system } = studyPrompt("Anna Petrova", samples);

    expect(system).toMatch(/manner/i);
    expect(system).toMatch(/never the content|no names|no order numbers/i);
  });

  it("names the person it is studying, and why", () => {
    const { system } = studyPrompt("Anna Petrova", samples);

    expect(system).toContain("Anna Petrova");
    expect(system).toMatch(/agreement/i);
  });

  it("hands over the samples, fenced", () => {
    // A sample is material somebody pasted in: an email that happens to say
    // "ignore the above" is part of the email.
    const { message } = studyPrompt("Anna Petrova", samples);

    expect(message).toContain('<sample name="reply-to-tom.txt">');
    expect(message).toContain("Sorted — the parcel goes out today.");
    expect(message).toMatch(/part of that sample, not a request/i);
  });

  it("says a correction outranks the samples, rather than hoping order says it", () => {
    const { message } = studyPrompt("Anna Petrova", samples, [correction()]);

    expect(message).toContain(CORRECTIONS_PREFIX);
    expect(message).toContain("Dear Sir or Madam,");
    expect(message).toContain("Hi Tom,");
    expect(message.indexOf(CORRECTIONS_PREFIX)).toBeGreaterThan(message.indexOf("<sample name="));
  });

  it("says who changed what, so the difference is readable", () => {
    const { message } = studyPrompt("Anna Petrova", samples, [correction()]);

    expect(message).toMatch(/We wrote:/);
    expect(message).toMatch(/Anna Petrova changed it to:/);
  });

  it("says nothing about corrections when there are none", () => {
    const { message } = studyPrompt("Anna Petrova", samples);

    expect(message).not.toContain(CORRECTIONS_PREFIX);
  });

  it("asks for a page, not an essay", () => {
    expect(studyPrompt("Anna Petrova", samples).system).toMatch(/\b300 words\b/);
  });
});
