import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap } from "../shared/result.js";
import { parseSkill, serializeSkill, type Skill, type SkillId } from "./skill.js";

const knownTools = new Set(["github.create_review", "github.get_diff", "slack.post_message"]);
const ctx = { knownTools };

const VALID = `---
name: code-review
version: 1.2.0
description: Review pull requests for correctness and test coverage.
tools:
  - github.get_diff
  - github.create_review
tags: [engineering, quality]
examples:
  - prompt: Review PR 42
    expectedOutcome: A review with at least one comment on the diff.
tests:
  - name: flags missing tests
    prompt: Review a PR that adds a function without tests
    expect: mentions missing tests
---
# Code review

Read the diff, run the checklist, leave actionable comments.

## Checklist
- Tests first
- No SQL outside adapters
`;

describe("parseSkill", () => {
  it("parses a valid skill file into a Skill", () => {
    const r = parseSkill(VALID, ctx);
    expect(isOk(r)).toBe(true);
    const skill = unwrap(r);
    expect(skill).toEqual<Skill>({
      id: "code-review" as SkillId,
      name: "code-review",
      version: "1.2.0",
      description: "Review pull requests for correctness and test coverage.",
      requiredTools: [
        { connectorId: "github", tool: "get_diff" },
        { connectorId: "github", tool: "create_review" },
      ],
      tags: ["engineering", "quality"],
      examples: [
        {
          prompt: "Review PR 42",
          expectedOutcome: "A review with at least one comment on the diff.",
        },
      ],
      tests: [
        {
          name: "flags missing tests",
          prompt: "Review a PR that adds a function without tests",
          expect: "mentions missing tests",
        },
      ],
      body: skill.body,
    });
    expect(skill.body.startsWith("# Code review")).toBe(true);
    expect(skill.body.trim().endsWith("- No SQL outside adapters")).toBe(true);
  });

  it("defaults tools, tags, examples and tests to empty lists", () => {
    const skill = unwrap(
      parseSkill(
        "---\nname: tdd\nversion: 0.1.0\ndescription: Red, green, refactor.\n---\nBody.\n",
        ctx,
      ),
    );
    expect(skill.requiredTools).toEqual([]);
    expect(skill.tags).toEqual([]);
    expect(skill.examples).toEqual([]);
    expect(skill.tests).toEqual([]);
  });

  it("rejects a file without frontmatter or with an empty body", () => {
    const noFm = parseSkill("# Just markdown\n", ctx);
    expect(isErr(noFm)).toBe(true);
    if (isErr(noFm)) expect(noFm.error[0]?.path).toBe("frontmatter");
    const noBody = parseSkill("---\nname: tdd\nversion: 0.1.0\ndescription: x\n---\n\n", ctx);
    expect(isErr(noBody)).toBe(true);
    if (isErr(noBody)) expect(noBody.error[0]?.path).toBe("body");
  });

  it("rejects invalid YAML frontmatter", () => {
    const r = parseSkill("---\nname: [unclosed\n---\nBody.\n", ctx);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("frontmatter");
  });

  it("reports missing required fields together", () => {
    const r = parseSkill("---\ntags: [x]\n---\nBody.\n", ctx);
    expect(isErr(r)).toBe(true);
    if (isErr(r))
      expect(r.error.map((e) => e.path).sort()).toEqual(["description", "name", "version"]);
  });

  it("rejects a bad semver", () => {
    const r = parseSkill("---\nname: tdd\nversion: v1\ndescription: x\n---\nBody.\n", ctx);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]).toMatchObject({ path: "version" });
  });

  it("rejects names that are not kebab-case identifiers", () => {
    for (const name of ["Code Review", "code_review", "-lead", "a", "x".repeat(65)]) {
      const r = parseSkill(`---\nname: ${name}\nversion: 1.0.0\ndescription: x\n---\nBody.\n`, ctx);
      expect(isErr(r), name).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("name");
    }
  });

  it("rejects unknown tool references and malformed tool ids with an indexed path", () => {
    const unknown = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntools: [github.get_diff, jira.create_issue]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown))
      expect(unknown.error[0]).toMatchObject({
        path: "tools[1]",
        message: expect.stringContaining("jira.create_issue") as string,
      });
    const malformed = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntools: [github]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(malformed)).toBe(true);
    if (isErr(malformed)) expect(malformed.error[0]?.path).toBe("tools[0]");
    const notList = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntools: github.get_diff\n---\nBody.\n",
      ctx,
    );
    expect(isErr(notList)).toBe(true);
    if (isErr(notList)) expect(notList.error[0]?.path).toBe("tools");
  });

  it("rejects malformed tags, examples and tests", () => {
    const tags = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntags: [1]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(tags)).toBe(true);
    if (isErr(tags)) expect(tags.error[0]?.path).toBe("tags[0]");
    const examples = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\nexamples: [{prompt: p}]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(examples)).toBe(true);
    if (isErr(examples)) expect(examples.error[0]?.path).toBe("examples[0].expectedOutcome");
    const tests = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntests: [{name: n, prompt: p}]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(tests)).toBe(true);
    if (isErr(tests)) expect(tests.error[0]?.path).toBe("tests[0].expect");
  });

  it("rejects examples and tests that are not lists of objects", () => {
    const notList = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\nexamples: nope\n---\nBody.\n",
      ctx,
    );
    expect(isErr(notList)).toBe(true);
    if (isErr(notList)) expect(notList.error[0]?.path).toBe("examples");
    const notObject = parseSkill(
      "---\nname: tdd\nversion: 1.0.0\ndescription: x\ntests: [plain]\n---\nBody.\n",
      ctx,
    );
    expect(isErr(notObject)).toBe(true);
    if (isErr(notObject)) expect(notObject.error[0]?.path).toBe("tests[0]");
  });

  it("round-trips through serializeSkill", () => {
    const skill = unwrap(parseSkill(VALID, ctx));
    const again = unwrap(parseSkill(serializeSkill(skill), ctx));
    expect(again).toEqual(skill);
  });
});
