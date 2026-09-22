import { describe, expect, it } from "vitest";
import { toAnthropicParams } from "../anthropic/anthropic-provider.js";
import { estimateTokens, FakeLlmProvider, reply } from "../fake/fake-provider.js";
import type { Message, ToolDefinition } from "../provider/types.js";
import {
  buildPrompt,
  canonicalizeSchema,
  systemText,
  type PromptLayers,
} from "./prompt-builder.js";

const tools: ToolDefinition[] = [
  {
    name: "slack_post",
    description: "Post to Slack",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, channel: { type: "string" } },
      required: ["channel", "text"],
    },
  },
  {
    name: "get_diff",
    description: "Fetch a PR diff",
    inputSchema: { required: ["pr"], properties: { pr: { type: "number" } }, type: "object" },
  },
];
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Review PR 42" }] }];

const layers: PromptLayers = {
  system: {
    stable: [
      "You are Ada, a backend engineer at Acme.",
      "Rules:\n- TDD only\n- No secrets in output",
    ],
    dynamic: ["Today is 2026-09-22.", "Current task: Review PR 42 (priority high)."],
  },
  tools,
  messages,
};

describe("buildPrompt", () => {
  it("puts tools first, sorted by name with canonical schemas, and marks the last one as a cache breakpoint", () => {
    const built = buildPrompt(layers);
    expect(built.tools.map((t) => t.name)).toEqual(["get_diff", "slack_post"]);
    expect(JSON.stringify(built.tools[0]?.inputSchema)).toBe(
      '{"properties":{"pr":{"type":"number"}},"required":["pr"],"type":"object"}',
    );
    expect(built.tools.map((t) => t.cache ?? false)).toEqual([false, true]);
  });

  it("renders stable system blocks before dynamic ones and marks only the stable block cacheable", () => {
    const built = buildPrompt(layers);
    expect(built.system).toEqual([
      {
        text: "You are Ada, a backend engineer at Acme.\n\nRules:\n- TDD only\n- No secrets in output",
        cache: true,
      },
      { text: "Today is 2026-09-22.\n\nCurrent task: Review PR 42 (priority high).", cache: false },
    ]);
    expect(built.messages).toEqual(messages);
    expect(systemText(built.system)).toBe(
      "You are Ada, a backend engineer at Acme.\n\nRules:\n- TDD only\n- No secrets in output\n\nToday is 2026-09-22.\n\nCurrent task: Review PR 42 (priority high).",
    );
  });

  it("produces a byte-stable prefix across runs regardless of tool order, key order or dynamic content", () => {
    const a = buildPrompt(layers);
    const shuffledTools = [...tools].reverse().map((t) => ({
      ...t,
      inputSchema: Object.fromEntries(Object.entries(t.inputSchema).reverse()),
    }));
    const b = buildPrompt({
      ...layers,
      tools: shuffledTools,
      system: {
        ...layers.system,
        dynamic: ["Today is 2027-01-01.", "Current task: something else."],
      },
    });
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.prefixHash).toBe(b.prefixHash);
    expect(a.prefixHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.stablePrefix).toMatchSnapshot();
  });

  it("changes the prefix hash when stable content changes", () => {
    const a = buildPrompt(layers);
    const b = buildPrompt({
      ...layers,
      system: { ...layers.system, stable: [...layers.system.stable, "Extra rule."] },
    });
    const c = buildPrompt({
      ...layers,
      tools: [...tools, { name: "extra", description: "x", inputSchema: { type: "object" } }],
    });
    expect(b.prefixHash).not.toBe(a.prefixHash);
    expect(c.prefixHash).not.toBe(a.prefixHash);
  });

  it("omits the dynamic block when there is none and tolerates no tools", () => {
    const built = buildPrompt({ system: { stable: ["Identity."] }, tools: [], messages });
    expect(built.system).toEqual([{ text: "Identity.", cache: true }]);
    expect(built.tools).toEqual([]);
    expect(built.stablePrefix).toContain("Identity.");
  });

  it("rejects duplicate tool names and empty stable system", () => {
    expect(() => buildPrompt({ ...layers, tools: [...tools, ...tools.slice(0, 1)] })).toThrow(
      /duplicate tool "slack_post"/,
    );
    expect(() => buildPrompt({ ...layers, system: { stable: [] } })).toThrow(/stable system/);
  });

  it("estimates the prefix token count so budgets can reason about cache size", () => {
    const built = buildPrompt(layers);
    expect(built.prefixTokens).toBe(estimateTokens(built.stablePrefix));
    expect(built.prefixTokens).toBeGreaterThan(20);
  });
});

describe("canonicalizeSchema", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(
      JSON.stringify(canonicalizeSchema({ b: { d: 1, c: [3, { z: 1, y: 2 }] }, a: "x" })),
    ).toBe('{"a":"x","b":{"c":[3,{"y":2,"z":1}],"d":1}}');
  });
});

describe("request integration", () => {
  it("the Anthropic adapter renders system blocks and the last tool with cache_control", () => {
    const built = buildPrompt(layers);
    const params = toAnthropicParams(
      {
        model: "claude-opus-5",
        system: built.system,
        tools: built.tools,
        messages: built.messages,
      },
      {},
    );
    expect(params.system).toEqual([
      { type: "text", text: built.system[0]?.text, cache_control: { type: "ephemeral" } },
      { type: "text", text: built.system[1]?.text },
    ]);
    const lastTool = params.tools?.at(-1) as { name: string; cache_control?: unknown };
    expect(lastTool.name).toBe("slack_post");
    expect(lastTool.cache_control).toEqual({ type: "ephemeral" });
    expect((params.tools?.[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it("the fake provider counts system blocks in its usage estimate", async () => {
    const built = buildPrompt(layers);
    const provider = new FakeLlmProvider({ script: [reply("ok")] });
    const res = await provider.complete({
      model: "fake",
      system: built.system,
      tools: built.tools,
      messages: built.messages,
    });
    expect(res.usage.inputTokens).toBe(
      estimateTokens(systemText(built.system)) + estimateTokens("Review PR 42"),
    );
  });
});
